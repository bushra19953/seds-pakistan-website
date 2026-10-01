/**
 * Role request system for SEDS Pakistan website
 */

import { doc, getDoc, collection, query, where, orderBy, getDocs, serverTimestamp, Firestore } from 'firebase/firestore';
;
import { EnhancedUserRole } from './rbac-types';
import { logAuditEntry } from './audit-logging';
import { setDoc, updateDoc } from '@/lib/client/firestore-wrapper';

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
    const roleRequestRef = doc(collection(firestore, 'role_requests'));
    const roleRequestData: any = {
      requesterUid,
      requestedRole,
      status: 'pending',
      createdAt: serverTimestamp(),
      notes,
    };
    
    await setDoc(roleRequestRef, roleRequestData);
    
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
    const roleRequestRef = doc(firestore, 'role_requests', requestId);
    const roleRequestDoc = await getDoc(roleRequestRef);
    
    if (!roleRequestDoc.exists()) {
      return null;
    }
    
    const data = roleRequestDoc.data();
    return {
      id: roleRequestDoc.id,
      requesterUid: data.requesterUid,
      requestedRole: data.requestedRole,
      status: data.status,
      createdAt: data.createdAt?.toDate() || new Date(),
      handledBy: data.handledBy,
      handledAt: data.handledAt ? data.handledAt.toDate() : undefined,
      notes: data.notes,
    };
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
    const roleRequestsRef = collection(firestore, 'role_requests');
    const q = query(
      roleRequestsRef,
      where('requesterUid', '==', userUid),
      orderBy('createdAt', 'desc')
    );
    const querySnapshot = await getDocs(q);
    
    return querySnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        requesterUid: data.requesterUid,
        requestedRole: data.requestedRole,
        status: data.status,
        createdAt: data.createdAt?.toDate() || new Date(),
        handledBy: data.handledBy,
        handledAt: data.handledAt ? data.handledAt.toDate() : undefined,
        notes: data.notes,
      };
    });
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
    const roleRequestsRef = collection(firestore, 'role_requests');
    const q = query(
      roleRequestsRef,
      where('status', '==', 'pending'),
      orderBy('createdAt', 'desc')
    );
    const querySnapshot = await getDocs(q);
    
    return querySnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        requesterUid: data.requesterUid,
        requestedRole: data.requestedRole,
        status: data.status,
        createdAt: data.createdAt?.toDate() || new Date(),
        handledBy: data.handledBy,
        handledAt: data.handledAt ? data.handledAt.toDate() : undefined,
        notes: data.notes,
      };
    });
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
    
    // Update the role request status
    const roleRequestRef = doc(firestore, 'role_requests', requestId);
    await updateDoc(roleRequestRef, {
      status: 'approved',
      handledBy,
      handledAt: serverTimestamp(),
      notes: notes || roleRequest.notes,
    });
    
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
    
    // Update the role request status
    const roleRequestRef = doc(firestore, 'role_requests', requestId);
    await updateDoc(roleRequestRef, {
      status: 'rejected',
      handledBy,
      handledAt: serverTimestamp(),
      notes: notes || roleRequest.notes,
    });
    
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
