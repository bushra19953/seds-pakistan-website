/**
 * Role request system for SEDS Pakistan website
 */

import { doc, getDoc, collection, query, where, orderBy, getDocs, serverTimestamp, Firestore } from 'firebase/firestore';
;
import { EnhancedUserRole } from './rbac-types';
import { logAuditEntry } from './audit-logging';
import { setDoc, updateDoc } from '@/lib/client/firestore-wrapper';
import {
  rolesSupaEnabled,
  rolesSupaPrimary,
  seamGetDoc,
  seamMirrorSetDoc,
  seamMirrorUpdateDoc,
  seamQueryDocs,
  seamSetDoc,
  seamUpdateDoc,
} from './supa-roles-client-seam';

/**
 * Stored-doc -> RoleRequestData mapping, shared by the Firestore path
 * and the supa seam path. Seam data carries Timestamp shims (toDate)
 * for createdAt/handledAt, so the conversions below behave identically
 * on either backend; raw ISO strings are also accepted defensively.
 */
function mapRoleRequest(id: string, data: Record<string, any>): RoleRequestData {
  const toDate = (v: any): Date | undefined => {
    if (!v) return undefined;
    if (typeof v.toDate === 'function') return v.toDate();
    if (v instanceof Date) return v;
    if (typeof v === 'string') {
      const t = Date.parse(v);
      return Number.isNaN(t) ? undefined : new Date(t);
    }
    return undefined;
  };
  return {
    id,
    requesterUid: data.requesterUid,
    requestedRole: data.requestedRole,
    status: data.status,
    createdAt: toDate(data.createdAt) || new Date(),
    handledBy: data.handledBy,
    handledAt: toDate(data.handledAt),
    notes: data.notes,
  };
}

export interface RoleRequestData {
  id: string;
  requesterUid: string;
  requestedRole: EnhancedUserRole;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: any;
  handledBy?: string;
  handledAt?: any;
  notes?: string;
}

/**
 * Create a role request
 * @param firestore The Firestore instance
 * @param requesterUid The UID of the user requesting the role
 * @param requestedRole The role being requested
 * @param notes Optional notes explaining the request
 * @returns The ID of the created role request
 */
export async function createRoleRequest(
  firestore: Firestore,
  requesterUid: string,
  requestedRole: EnhancedUserRole,
  notes?: string
): Promise<string> {
  try {
    // GRANDFATHERING + RE-KEY (identity cutover step 1, design §2.2):
    // the role_requests lifecycle (create here, approve/reject below)
    // was among the program's first primary writes — under
    // SUPA_SURFACES alone these writes already landed in Supabase
    // ONLY through the seam, while sibling definition writes
    // (R-16..R-20) dual-wrote. The backend choice is now re-keyed to
    // primacy (rolesSupaPrimary, client twin of isSupaPrimary('roles')):
    //   primary     -> adapter-only via the seam (route mints the id;
    //                  createdAt travels as an ISO string). A seam
    //                  failure throws — no silent Firestore fallback
    //                  may resurrect the retired writer.
    //   non-primary -> uniform dual-write: Firestore primary FIRST
    //                  (payload byte-identical to the pre-seam write),
    //                  THEN a best-effort R-16-style mirror through
    //                  the seam under the Firestore-minted id (the
    //                  mirror leg never writes Firestore and its
    //                  failure never fails the create).
    //   flag OFF    -> Firestore only, zero seam calls.
    // Deliberate behaviour CHANGE under SUPA_SURFACES-only (was:
    // Supa-only; now: dual-write); rides the primacy deploy note.
    // The audit entry is written identically on every path
    // (audit-logging belongs to the audit cluster and stays on
    // Firestore here).
    const seamData = () => ({
      requesterUid,
      requestedRole,
      status: 'pending',
      createdAt: new Date().toISOString(),
      notes: notes ?? null,
    });
    if (rolesSupaPrimary()) {
      const written = await seamSetDoc('role_requests', null, seamData());
      if (written) {
        await logAuditEntry(firestore, 'create_role_request', requesterUid, written.id, {
          requestedRole,
          notes,
        });
        return written.id;
      }
      throw new Error(
        "createRoleRequest: 'roles' is Supabase-primary but the seam create did not land; refusing a Firestore fallback write"
      );
    }
    const roleRequestRef = doc(collection(firestore, 'role_requests'));
    const roleRequestData: any = {
      requesterUid,
      requestedRole,
      status: 'pending',
      createdAt: serverTimestamp(),
      notes,
    };

    await setDoc(roleRequestRef, roleRequestData);

    if (rolesSupaEnabled()) {
      // Best-effort mirror of the committed Firestore create, under
      // the same id so both stores agree on the request's identity.
      await seamMirrorSetDoc('role_requests', roleRequestRef.id, seamData());
    }

    // Log the audit entry
    await logAuditEntry(
      firestore,
      'create_role_request',
      requesterUid,
      roleRequestRef.id,
      {
        requestedRole,
        notes,
      }
    );

    return roleRequestRef.id;
  } catch (error) {
    console.error('Error creating role request:', error);
    throw new Error('Failed to create role request');
  }
}

/**
 * Get a role request by ID
 * @param firestore The Firestore instance
 * @param requestId The ID of the role request
 * @returns The role request data or null if not found
 */
export async function getRoleRequest(firestore: Firestore, requestId: string): Promise<RoleRequestData | null> {
  try {
    // Supa seam first (flag-gated); null = Firestore path below.
    const seamDoc = rolesSupaEnabled() ? await seamGetDoc('role_requests', requestId) : null;
    if (seamDoc) {
      return seamDoc.exists && seamDoc.data ? mapRoleRequest(seamDoc.id, seamDoc.data) : null;
    }
    const roleRequestRef = doc(firestore, 'role_requests', requestId);
    const roleRequestDoc = await getDoc(roleRequestRef);

    if (!roleRequestDoc.exists()) {
      return null;
    }

    return mapRoleRequest(roleRequestDoc.id, roleRequestDoc.data());
  } catch (error) {
    console.error('Error getting role request:', error);
    return null;
  }
}

/**
 * Get role requests for a user
 * @param firestore The Firestore instance
 * @param userUid The UID of the user
 * @returns Array of role requests for the user
 */
export async function getUserRoleRequests(firestore: Firestore, userUid: string): Promise<RoleRequestData[]> {
  try {
    // Supa seam first (flag-gated); null = Firestore query below.
    const seamDocs = rolesSupaEnabled()
      ? await seamQueryDocs('role_requests', 'requesterUid', userUid, 'createdAt')
      : null;
    if (seamDocs) {
      return seamDocs
        .filter((d) => d.exists && d.data)
        .map((d) => mapRoleRequest(d.id, d.data as Record<string, any>));
    }
    const roleRequestsRef = collection(firestore, 'role_requests');
    const q = query(
      roleRequestsRef,
      where('requesterUid', '==', userUid),
      orderBy('createdAt', 'desc')
    );
    const querySnapshot = await getDocs(q);

    return querySnapshot.docs.map((doc) => mapRoleRequest(doc.id, doc.data()));
  } catch (error) {
    console.error('Error getting user role requests:', error);
    return [];
  }
}

/**
 * Get pending role requests
 * @param firestore The Firestore instance
 * @returns Array of pending role requests
 */
export async function getPendingRoleRequests(firestore: Firestore): Promise<RoleRequestData[]> {
  try {
    // Supa seam first (flag-gated); null = Firestore query below.
    const seamDocs = rolesSupaEnabled()
      ? await seamQueryDocs('role_requests', 'status', 'pending', 'createdAt')
      : null;
    if (seamDocs) {
      return seamDocs
        .filter((d) => d.exists && d.data)
        .map((d) => mapRoleRequest(d.id, d.data as Record<string, any>));
    }
    const roleRequestsRef = collection(firestore, 'role_requests');
    const q = query(
      roleRequestsRef,
      where('status', '==', 'pending'),
      orderBy('createdAt', 'desc')
    );
    const querySnapshot = await getDocs(q);

    return querySnapshot.docs.map((doc) => mapRoleRequest(doc.id, doc.data()));
  } catch (error) {
    console.error('Error getting pending role requests:', error);
    return [];
  }
}

/**
 * Approve a role request
 * @param firestore The Firestore instance
 * @param requestId The ID of the role request to approve
 * @param handledBy The UID of the user approving the request
 * @param notes Optional notes about the approval
 * @returns True if successful, false otherwise
 */
export async function approveRoleRequest(
  firestore: Firestore,
  requestId: string,
  handledBy: string,
  notes?: string
): Promise<boolean> {
  try {
    // Get the role request
    const roleRequest = await getRoleRequest(firestore, requestId);
    if (!roleRequest) {
      return false;
    }
    
    // Update the role request status — re-keyed to primacy like the
    // create above (identity cutover step 1, design §2.2; this site
    // was Supa-only under SUPA_SURFACES alone):
    //   primary     -> adapter-only via the seam (manager-gated at
    //                  the route). Seam failure returns false with
    //                  ZERO Firestore writes — no silent fallback.
    //   non-primary -> Firestore primary first (payload identical to
    //                  the pre-seam update), then a best-effort
    //                  mirror update through the seam (ISO handledAt;
    //                  its failure never fails the approval).
    //   flag OFF    -> Firestore only, zero seam calls.
    if (rolesSupaPrimary()) {
      const seamUpdated = await seamUpdateDoc('role_requests', requestId, {
        status: 'approved',
        handledBy,
        handledAt: new Date().toISOString(),
        notes: notes || roleRequest.notes || null,
      });
      if (!seamUpdated) {
        console.error(
          `approveRoleRequest: 'roles' is Supabase-primary but the seam update for '${requestId}' did not land; refusing a Firestore fallback write`
        );
        return false;
      }
    } else {
      const roleRequestRef = doc(firestore, 'role_requests', requestId);
      await updateDoc(roleRequestRef, {
        status: 'approved',
        handledBy,
        handledAt: serverTimestamp(),
        notes: notes || roleRequest.notes,
      });
      if (rolesSupaEnabled()) {
        await seamMirrorUpdateDoc('role_requests', requestId, {
          status: 'approved',
          handledBy,
          handledAt: new Date().toISOString(),
          notes: notes || roleRequest.notes || null,
        });
      }
    }
    
    // Log the audit entry
    await logAuditEntry(
      firestore,
      'approve_role_request',
      handledBy,
      requestId,
      {
        requesterUid: roleRequest.requesterUid,
        requestedRole: roleRequest.requestedRole,
        notes,
      }
    );
    
    return true;
  } catch (error) {
    console.error('Error approving role request:', error);
    return false;
  }
}

/**
 * Reject a role request
 * @param firestore The Firestore instance
 * @param requestId The ID of the role request to reject
 * @param handledBy The UID of the user rejecting the request
 * @param notes Optional notes about the rejection
 * @returns True if successful, false otherwise
 */
export async function rejectRoleRequest(
  firestore: Firestore,
  requestId: string,
  handledBy: string,
  notes?: string
): Promise<boolean> {
  try {
    // Get the role request
    const roleRequest = await getRoleRequest(firestore, requestId);
    if (!roleRequest) {
      return false;
    }
    
    // Update the role request status — re-keyed to primacy exactly
    // like approve above (identity cutover step 1, design §2.2):
    //   primary     -> adapter-only via the seam; seam failure returns
    //                  false with ZERO Firestore writes.
    //   non-primary -> Firestore primary first (pre-seam payload),
    //                  then a best-effort mirror update via the seam.
    //   flag OFF    -> Firestore only, zero seam calls.
    if (rolesSupaPrimary()) {
      const seamUpdated = await seamUpdateDoc('role_requests', requestId, {
        status: 'rejected',
        handledBy,
        handledAt: new Date().toISOString(),
        notes: notes || roleRequest.notes || null,
      });
      if (!seamUpdated) {
        console.error(
          `rejectRoleRequest: 'roles' is Supabase-primary but the seam update for '${requestId}' did not land; refusing a Firestore fallback write`
        );
        return false;
      }
    } else {
      const roleRequestRef = doc(firestore, 'role_requests', requestId);
      await updateDoc(roleRequestRef, {
        status: 'rejected',
        handledBy,
        handledAt: serverTimestamp(),
        notes: notes || roleRequest.notes,
      });
      if (rolesSupaEnabled()) {
        await seamMirrorUpdateDoc('role_requests', requestId, {
          status: 'rejected',
          handledBy,
          handledAt: new Date().toISOString(),
          notes: notes || roleRequest.notes || null,
        });
      }
    }
    
    // Log the audit entry
    await logAuditEntry(
      firestore,
      'reject_role_request',
      handledBy,
      requestId,
      {
        requesterUid: roleRequest.requesterUid,
        requestedRole: roleRequest.requestedRole,
        notes,
      }
    );
    
    return true;
  } catch (error) {
    console.error('Error rejecting role request:', error);
    return false;
  }
}
