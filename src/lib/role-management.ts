/**
 * Role management system for SEDS Pakistan website
 */

import { doc, getDoc, serverTimestamp, collection, query, where, getDocs, Firestore } from 'firebase/firestore';
import { UserRole, FOUNDER_UID } from './roles';
import { EnhancedUserRole } from './rbac-types';
import { logAuditEntry } from './audit-logging';
import { setDoc, updateDoc, deleteDoc } from '@/lib/client/firestore-wrapper';
import { normalizeRoleSlug } from './unified-roles';

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
  reason: string
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
  try {
    // Get current role for audit logging
    const currentRole = await getUserRole(firestore, targetUid);

    // Update the roles collection
    const roleDocRef = doc(firestore, 'roles', targetUid);
    const roleData: any = {
      role: normalizedRole,
      grantedBy: assignedBy,
      grantedAt: serverTimestamp(),
    };

    console.log(`[RoleManager] Writing to roles/${targetUid}...`);
    await setDoc(roleDocRef, roleData, { merge: true });

    // Denormalize displayRole on user doc (for leaderboard, profiles, etc.)
    try {
      const userDocRef = doc(firestore, 'users', targetUid);
      // 🔥 CRITICAL: We catch the error locally to ensure the main transaction succeeds.
      // Role Managers might have permission for the 'roles' collection but NOT the 'users' collection.
      await updateDoc(userDocRef, { displayRole: normalizedRole, updatedAt: serverTimestamp() }).catch(e => {
        console.warn('[RoleManager] Non-fatal denormalization failure (Likely Rules):', e);
      });
    } catch (e) {
      console.warn('[RoleManager] Non-fatal denormalization setup failure:', e);
    }

    // Log the audit entry
    await logAuditEntry(
      firestore,
      'assign_role',
      assignedBy,
      targetUid,
      {
        previousRole: currentRole,
        newRole: normalizedRole,
        reason,
      }
    );

    console.log(`[RoleManager] Successfully assigned ${normalizedRole} to ${targetUid}`);
    return true;
  } catch (error: any) {
    console.error('[RoleManager] FATAL ERROR during role assignment:', error);
    console.error(`[RoleManager] Error Details: Code=${error.code}, Msg=${error.message}`);
    return false;
  }
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
  reason: string
): Promise<boolean> {
  if (targetUid === FOUNDER_UID) {
    console.error('CRITICAL: Attempted to revoke immutable Founder role.');
    return false;
  }
  if (!reason || reason.trim().length < 10) {
    console.error('Error: Mandatory justification (min 10 chars) required for role revocation.');
    return false;
  }
  try {
    // Get current role for audit logging
    const currentRole = await getUserRole(firestore, targetUid);

    // Update the roles collection to set role to 'member'
    const roleDocRef = doc(firestore, 'roles', targetUid);
    await updateDoc(roleDocRef, {
      role: 'member',
      grantedBy: revokedBy,
      grantedAt: serverTimestamp(),
    });

    // Log the audit entry
    await logAuditEntry(
      firestore,
      'revoke_role',
      revokedBy,
      targetUid,
      {
        previousRole: currentRole,
        newRole: 'member',
        reason,
      }
    );

    return true;
  } catch (error) {
    console.error('Error revoking role:', error);
    return false;
  }
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
  reason: string
): Promise<boolean> {
  if (targetUid === FOUNDER_UID) {
    console.error('CRITICAL: Attempted to delete immutable Founder profile.');
    return false;
  }
  if (!reason || reason.trim().length < 10) return false;

  try {
    const currentRole = await getUserRole(firestore, targetUid);
    const roleDocRef = doc(firestore, 'roles', targetUid);

    await deleteDoc(roleDocRef);

    await logAuditEntry(
      firestore,
      'nuclear_delete_role',
      deletedBy,
      targetUid,
      {
        previousRole: currentRole,
        newRole: 'none (deleted)',
        reason,
        alertType: 'CRITICAL_SECURITY_EVENT'
      }
    );

    return true;
  } catch (error) {
    console.error('Error doing nuclear delete role:', error);
    return false;
  }
}
