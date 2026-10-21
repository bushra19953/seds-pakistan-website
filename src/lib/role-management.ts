/**
 * Role management - Phase 1 shim (spec B.2 item 5).
 *
 * This module used to write roles/{uid} directly from the client and then
 * mirror onto users/{uid} as a second, separately-failing write - the
 * mechanism behind the recurring "demotion did not take" bug class. It is
 * now a thin client adapter over the single server write path:
 *
 *   assignRole        -> POST /api/admin/roles/write { action: 'assign' }
 *   revokeRole        -> POST /api/admin/roles/write { action: 'remove' }
 *   deleteRoleProfile -> POST /api/admin/roles/write { action: 'remove' }
 *   syncUserRoleFields-> POST /api/admin/sync-user-role (repair only)
 *
 * The exported names and boolean-return contract are unchanged so the six
 * existing UI callers compile and behave; the server composes roles +
 * mirror + roleHistory + audit in one transaction and fails loudly.
 * Read helpers (getUserRole, getUsersWithRole) are unchanged.
 */

import { doc, getDoc, collection, query, where, getDocs, Firestore } from 'firebase/firestore';
import { FOUNDER_UID } from './roles';
import { EnhancedUserRole } from './rbac-types';
import { resolveRole } from './role-catalog';
import { normalizeRoleSlug } from './role-catalog';

async function authedFetch(path: string, body: Record<string, unknown>): Promise<Response | null> {
  try {
    const { getAuth } = await import('firebase/auth');
    const currentUser = getAuth().currentUser;
    if (!currentUser) {
      console.error(`[RoleManager] ${path} impossible: no signed-in user.`);
      return null;
    }
    const token = await currentUser.getIdToken();
    return await fetch(path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`[RoleManager] ${path} threw:`, err);
    return null;
  }
}

/**
 * Mirror repair caller. The narrowed sync route honors a role field ONLY
 * when it exactly equals the effective role on the roles/{uid} record;
 * anything else is a 409, returned here as false (loud in the console).
 */
export async function syncUserRoleFields(
  _firestore: Firestore,
  targetUid: string,
  role: string
): Promise<boolean> {
  const res = await authedFetch('/api/admin/sync-user-role', { uid: targetUid, role });
  if (res?.ok) return true;
  if (res) {
    const errBody = await res.json().catch(() => ({}));
    console.error(
      `[RoleManager] Mirror repair for users/${targetUid} rejected: ${res.status} ${errBody?.error || ''}. ` +
        'Role changes go through /api/admin/roles/write.'
    );
  }
  return false;
}

/**
 * Assign a role via the single write path. The role string is resolved to
 * its catalog key client-side for an early, legible failure; the server
 * re-validates everything.
 */
export async function assignRole(
  _firestore: Firestore,
  targetUid: string,
  role: EnhancedUserRole,
  assignedBy: string,
  reason: string
): Promise<boolean> {
  if (targetUid === FOUNDER_UID) {
    console.error(`[RoleManager] CRITICAL: Attempted to modify immutable Founder role. Target: ${targetUid}`);
    return false;
  }
  const slug = normalizeRoleSlug(String(role));
  if (slug === 'superadmin') {
    console.error(`[RoleManager] UNAUTHORIZED: 'superadmin' is retired; use chief_technology_officer.`);
    return false;
  }
  if (!reason || reason.trim().length < 10) {
    console.error(`[RoleManager] Error: Justification too short. Length: ${reason?.length || 0}`);
    return false;
  }
  const resolved = resolveRole(slug);
  if (resolved.kind !== 'catalog' && resolved.kind !== 'legacy') {
    console.error(`[RoleManager] Role "${slug}" does not resolve to a catalog key; not assigning.`);
    return false;
  }
  const res = await authedFetch('/api/admin/roles/write', {
    action: 'assign',
    uid: targetUid,
    role: resolved.key,
    reason,
  });
  if (res?.ok) {
    console.log(`[RoleManager] Assigned ${resolved.key} to ${targetUid} via the write path.`);
    return true;
  }
  if (res) {
    const errBody = await res.json().catch(() => ({}));
    console.error(`[RoleManager] Assign failed: ${res.status} ${errBody?.error || ''}`);
  }
  return false;
}

/**
 * Revoke a role via the single write path (removeRole semantics: roles
 * record deleted, mirror reset to member_basic, history recorded).
 */
export async function revokeRole(
  _firestore: Firestore,
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
  const res = await authedFetch('/api/admin/roles/write', {
    action: 'remove',
    uid: targetUid,
    reason,
  });
  if (res?.ok) return true;
  if (res) {
    const errBody = await res.json().catch(() => ({}));
    console.error(`[RoleManager] Revoke failed: ${res.status} ${errBody?.error || ''}`);
  }
  return false;
}

/** Get a user's role from the roles collection (read-only, unchanged). */
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

/** Get users with a specific role (read-only, unchanged). */
export async function getUsersWithRole(firestore: Firestore, role: EnhancedUserRole): Promise<string[]> {
  try {
    const rolesRef = collection(firestore, 'roles');
    const q = query(rolesRef, where('role', '==', role));
    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map((d) => d.id);
  } catch (error) {
    console.error('Error getting users with role:', error);
    return [];
  }
}

/**
 * Delete a role profile via the single write path. The old client-side
 * deleteDoc is retired: deletion now also resets the mirror and writes
 * the roleHistory record, in the same transaction.
 */
export async function deleteRoleProfile(
  _firestore: Firestore,
  targetUid: string,
  deletedBy: string,
  reason: string
): Promise<boolean> {
  if (targetUid === FOUNDER_UID) {
    console.error('CRITICAL: Attempted to delete immutable Founder profile.');
    return false;
  }
  if (!reason || reason.trim().length < 10) return false;
  const res = await authedFetch('/api/admin/roles/write', {
    action: 'remove',
    uid: targetUid,
    reason,
  });
  if (res?.ok) return true;
  if (res) {
    const errBody = await res.json().catch(() => ({}));
    console.error(`[RoleManager] Delete failed: ${res.status} ${errBody?.error || ''}`);
  }
  return false;
}
