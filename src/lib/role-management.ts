/**
 * Role management system for SEDS Pakistan website
 */

import { doc, getDoc, serverTimestamp, collection, query, where, getDocs, Firestore } from 'firebase/firestore';
import { UserRole, FOUNDER_UID } from './roles';
import { EnhancedUserRole } from './rbac-types';
import { logAuditEntry } from './audit-logging';
import { setDoc, updateDoc, deleteDoc } from '@/lib/client/firestore-wrapper';
import { normalizeRoleSlug } from './unified-roles';
import { parseConsentGateResponse } from '@/lib/client/consent-gate-error';

/**
 * Phase 2 (spec B.3a.2): live role writes go through POST
 * /api/admin/roles/assign, the only server path allowed to write Category B
 * roles. The route writes BOTH role stores in one batch and enforces the
 * Founder Consent gate; a gate 409 throws ConsentGateBlocked (from
 * parseConsentGateResponse) so the calling surface can open the consent
 * dialog. Returns true on success, false on any other failure.
 */
async function postRoleAssign(body: Record<string, unknown>): Promise<boolean> {
  const { getAuth } = await import('firebase/auth');
  const currentUser = getAuth().currentUser;
  if (!currentUser) {
    console.error('[RoleManager] No signed-in user; cannot call the assign route.');
    return false;
  }
  const token = await currentUser.getIdToken();
  const res = await fetch('/api/admin/roles/assign', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await parseConsentGateResponse(res);
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    console.error(
      '[RoleManager] Assign route failed:',
      res.status,
      (errBody as { error?: string })?.error || ''
    );
    return false;
  }
  return true;
}

export interface RoleWriteOpts {
  consentRequestId?: string | null;
}

/**
 * Single writer for the denormalized role fields on the user document.
 * roles/{uid}.role is the source of truth; users/{uid}.role and
 * users/{uid}.displayRole are mirrors so server permission checks
 * (which read users.role first) never drift from the assigned role.
 * Uses setDoc with merge so a missing user doc does not fail the sync.
 * Returns true when the mirror write succeeded. A false return means the
 * two stores now disagree and the caller must surface it loudly.
 */
export async function syncUserRoleFields(
  firestore: Firestore,
  targetUid: string,
  role: string
): Promise<boolean> {
  try {
    const userDocRef = doc(firestore, 'users', targetUid);
    await setDoc(
      userDocRef,
      { role, displayRole: role, updatedAt: serverTimestamp() },
      { merge: true }
    );
    return true;
  } catch (error: any) {
    // Loud failure on purpose: a stale users.role lets a demoted user keep
    // passing server-side role gates, so this must never be silent.
    console.error(
      `[RoleManager] Client mirror write failed for users/${targetUid} ` +
        `Code=${error?.code}, Msg=${error?.message}. Trying server fallback.`
    );
    // Server fallback: the Admin SDK bypasses Firestore rules, which deny
    // client-side role writes on docs missing the numeric validity fields.
    try {
      const { getAuth } = await import('firebase/auth');
      const currentUser = getAuth().currentUser;
      if (!currentUser) {
        console.error('[RoleManager] Server fallback impossible: no signed-in user.');
        return false;
      }
      const token = await currentUser.getIdToken();
      const res = await fetch('/api/admin/sync-user-role', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: targetUid, role }),
      });
      if (res.ok) {
        console.log(`[RoleManager] Server fallback synced users/${targetUid} to "${role}".`);
        return true;
      }
      const errBody = await res.json().catch(() => ({}));
      console.error('[RoleManager] Server fallback failed:', res.status, errBody?.error || '');
      return false;
    } catch (fallbackError: any) {
      console.error('[RoleManager] Server fallback threw:', fallbackError?.message || fallbackError);
      return false;
    }
  }
}

/**
 * Record a role-mirror sync failure where admins will see it.
 * The roles/{uid} write already succeeded, so this never throws.
 */
async function logRoleSyncFailure(
  firestore: Firestore,
  actorUid: string,
  targetUid: string,
  role: string
): Promise<void> {
  try {
    await logAuditEntry(
      firestore,
      'role_user_sync_failed',
      actorUid,
      targetUid,
      {
        newRole: role,
        detail: 'roles/{uid} updated but users/{uid} role/displayRole mirror write failed; stores disagree until retried',
      }
    );
  } catch (e) {
    console.error('[RoleManager] Could not write role_user_sync_failed audit entry:', e);
  }
}

/**
 * Assign a role to a user
 * @param firestore The Firestore instance
 * @param targetUid The UID of the user to assign the role to
 * @param role The role to assign
 * @param assignedBy The UID of the user assigning the role
 * @param reason Optional reason for the role assignment
 */
export async function assignRole(
  firestore: Firestore,
  targetUid: string,
  role: EnhancedUserRole,
  assignedBy: string,
  reason: string,
  opts?: RoleWriteOpts
  ): Promise<boolean> {
  const normalizedRole = normalizeRoleSlug(role);
  console.log(`[RoleManager] Assigning "${normalizedRole}" to ${targetUid} by ${assignedBy}`);

  // 1. IDENTITY LOCKDOWN: Founder is immutable
  if (targetUid === FOUNDER_UID) {
    console.error(`[RoleManager] CRITICAL: Attempted to modify immutable Founder role. Target: ${targetUid}`);
    return false;
  }

  // 2. SOLE AUTHORITY LOCKDOWN: No one but the Founder can be Superadmin
  if (normalizedRole === 'superadmin') {
    console.error(`[RoleManager] UNAUTHORIZED: Superadmin reservation violation by ${assignedBy}. Role: ${normalizedRole}`);
    return false;
  }

  // 3. Mandatory justification
  if (!reason || reason.trim().length < 10) {
    console.error(`[RoleManager] Error: Justification too short. Length: ${reason?.length || 0}`);
    return false;
  }
  // Phase 2 (spec B.3a.2): the direct roles/{uid} writer that used to live
  // here is deleted. All live role writes go through the gated assign route,
  // which writes both role stores atomically and audits server-side. The
  // firestore and assignedBy parameters are retained for call-site
  // compatibility; the route derives the actor from the caller's token.
  void firestore;
  void assignedBy;
  return postRoleAssign({
    targetUid,
    role: normalizedRole,
    reason,
    consentRequestId: opts?.consentRequestId ?? null,
  });
  }

/**
 * Revoke a role from a user
 * @param firestore The Firestore instance
 * @param targetUid The UID of the user to revoke the role from
 * @param revokedBy The UID of the user revoking the role
 * @param reason Optional reason for the role revocation
 */
export async function revokeRole(
  firestore: Firestore,
  targetUid: string,
  revokedBy: string,
  reason: string,
  opts?: RoleWriteOpts
): Promise<boolean> {
  if (targetUid === FOUNDER_UID) {
    console.error('CRITICAL: Attempted to revoke immutable Founder role.');
    return false;
  }
  if (!reason || reason.trim().length < 10) {
    console.error('Error: Mandatory justification (min 10 chars) required for role revocation.');
    return false;
  }
  // Phase 2 (spec B.3a.2): revocation is a Category B removal when the
  // current role is Category B, so it goes through the gated assign route
  // like every other live role write. Direct writers deleted.
  void firestore;
  void revokedBy;
  return postRoleAssign({
    targetUid,
    action: 'revoke',
    reason,
    consentRequestId: opts?.consentRequestId ?? null,
  });
}

/**
 * Get a user's role
 * @param firestore The Firestore instance
 * @param userUid The UID of the user
 * @returns The user's role or 'guest' if not found
 */
export async function getUserRole(firestore: Firestore, userUid: string): Promise<EnhancedUserRole> {
  try {
    const roleDocRef = doc(firestore, 'roles', userUid);
    const roleDoc = await getDoc(roleDocRef);

    if (roleDoc.exists()) {
      return roleDoc.data().role || 'guest';
    }

    return 'guest';
  } catch (error) {
    console.error('Error getting user role:', error);
    return 'guest';
  }
}

/**
 * Get users with a specific role
 * @param firestore The Firestore instance
 * @param role The role to filter by
 * @returns Array of user UIDs with the specified role
 */
export async function getUsersWithRole(firestore: Firestore, role: EnhancedUserRole): Promise<string[]> {
  try {
    const rolesRef = collection(firestore, 'roles');
    const q = query(rolesRef, where('role', '==', role));
    const querySnapshot = await getDocs(q);

    return querySnapshot.docs.map(doc => doc.id);
  } catch (error) {
    console.error('Error getting users with role:', error);
    return [];
  }
}

/**
 * Physically delete a role profile (Nuclear Deletion)
 * @param firestore The Firestore instance
 * @param targetUid The UID of the user whose role profile to delete
 * @param deletedBy The UID of the admin performing the deletion
 * @param reason Mandatory justification
 */
export async function deleteRoleProfile(
  firestore: Firestore,
  targetUid: string,
  deletedBy: string,
  reason: string,
  opts?: RoleWriteOpts
): Promise<boolean> {
  if (targetUid === FOUNDER_UID) {
    console.error('CRITICAL: Attempted to delete immutable Founder profile.');
    return false;
  }
  if (!reason || reason.trim().length < 10) return false;

  // Phase 2 (spec B.3a.2): profile deletion removes whatever authority the
  // target holds; when that authority is Category B the assign route's gate
  // applies (subject action 'remove'). Direct deleteDoc writer deleted.
  void firestore;
  void deletedBy;
  return postRoleAssign({
    targetUid,
    action: 'delete',
    reason,
    consentRequestId: opts?.consentRequestId ?? null,
  });
}
