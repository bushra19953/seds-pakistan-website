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

    // Mirror the role onto the user doc through the single writer, so the
    // server permission checks (which read users.role) never drift from the
    // assigned role again. A mirror failure is loud, not silent: it is
    // logged and recorded in the audit log, while the roles/{uid} write
    // above still stands.
    const mirrorOk = await syncUserRoleFields(firestore, targetUid, normalizedRole);
    if (!mirrorOk) {
      console.error(
        `[RoleManager] PARTIAL FAILURE: roles/${targetUid} is "${normalizedRole}" ` +
          `but users/${targetUid} was not updated; role stores disagree until retried.`
      );
      await logRoleSyncFailure(firestore, assignedBy, targetUid, normalizedRole);
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

    // Mirror the demotion onto the user doc through the single writer.
    // Without this, users/{uid}.role keeps the old role and server
    // permission checks keep passing the demoted user.
    const mirrorOk = await syncUserRoleFields(firestore, targetUid, 'member');
    if (!mirrorOk) {
      console.error(
        `[RoleManager] PARTIAL FAILURE: roles/${targetUid} revoked to "member" ` +
          `but users/${targetUid} was not updated; role stores disagree until retried.`
      );
      await logRoleSyncFailure(firestore, revokedBy, targetUid, 'member');
    }

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
