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
/** Optional Phase 2 consent linkage for a role write (spec B.5):
 * when a Category B assignment/demotion was consented, the caller passes
 * the consent request id and it is forwarded to the write path, which
 * records it on the roleHistory entry. Added at integration (step 4)
 * so the gates crew's call sites (roles page, user table) compile
 * against the Phase 1 client unchanged in shape. */
export interface RoleWriteOpts {
  consentRequestId?: string | null;
  /**
   * Custom-role grant expiry (Custom Roles Fix Program, contracts 2.2/3.2,
   * ruling X11). Three-way semantics at the write boundary:
   * - an ISO 8601 string sets or replaces the grant's expiry;
   * - explicit null clears the grant's expiry;
   * - undefined (field absent) preserves any existing expiry and, for a
   *   fresh grant, means non-expiring.
   * Only meaningful when the write grants a custom_ role; expiry-core
   * owns the server-side validation and capture.
   */
  expiresAt?: string | null;
  /**
   * The custom_ slug the expiry applies to (contracts 2.2: the grant
   * record cannot say WHICH grant expires without it). Travels with
   * expiresAt as a pair whenever expiresAt is provided.
   */
  expiresRoleKey?: string | null;
}

export async function assignRole(
  _firestore: Firestore,
  targetUid: string,
  role: EnhancedUserRole,
  assignedBy: string,
  reason: string,
  opts?: RoleWriteOpts
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
    consentRequestId: opts?.consentRequestId ?? null,
    // Expiry travels only when the caller decided it (X11): undefined
    // keeps both keys out of the body entirely so the server preserves.
    // When present, expiresAt and expiresRoleKey go as a pair
    // (contracts 3.2).
    ...(opts?.expiresAt !== undefined
      ? { expiresAt: opts.expiresAt, expiresRoleKey: opts.expiresRoleKey ?? null }
      : {}),
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
  const res = await authedFetch('/api/admin/roles/write', {
    action: 'remove',
    uid: targetUid,
    reason,
    consentRequestId: opts?.consentRequestId ?? null,
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
  reason: string,
  opts?: RoleWriteOpts
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
    consentRequestId: opts?.consentRequestId ?? null,
  });
  if (res?.ok) return true;
  if (res) {
    const errBody = await res.json().catch(() => ({}));
    console.error(`[RoleManager] Delete failed: ${res.status} ${errBody?.error || ''}`);
  }
  return false;
}
