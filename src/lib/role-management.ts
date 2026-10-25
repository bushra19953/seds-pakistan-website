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
 * Custom roles (Custom Roles Fix Program, contracts.md K2): a custom_
 * slug is never a primary. assignRole delegates such picks to
 * assignCustomRole, which translates the pick into primary = the
 * target's current catalog primary (member_basic when no roles record
 * exists) + additionalRoles += slug, chapterId forwarded; the server
 * re-validates the definition, chapter and Reserved Powers.
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
import {
  rolesSupaEnabled,
  seamGetDoc,
  seamQueryDocs,
} from './supa-roles-client-seam';

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
   * C6 (deliberate behaviour change, assign-path plan section 5): on a
   * CATALOG assign, first read the target's current record and forward
   * its additionalRoles (custom grants included, minus the new primary)
   * and chapterId, so the write preserves them. Without the opt the
   * POST body is byte-identical to the historical shape and the server
   * composes from additionalRoles ?? [] (the old silent wipe). Opt-in
   * per caller: the users table opts in; superadmin/invite/auth-form
   * callers keep today's semantics.
   */
  preserveAdditionalRoles?: boolean;
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

interface RoleRecord {
  /** roles/{uid} primary (catalog key), or null when no record holds one. */
  primary: string | null;
  /** Stored additionalRoles verbatim (custom_ slugs included). */
  additionalRoles: string[];
  /** roles doc chapterId, else the users doc chapterId, else null. */
  chapterId: string | null;
  hasRoleDoc: boolean;
}

/**
 * Read the target's current role record: roles/{uid} first, users/{uid}
 * for the chapterId fallback - the same precedence the server resolves
 * with in role-writes (audit B7 / watch W10: the users UI used to send
 * no chapterId at all).
 */
async function readRoleRecord(firestore: Firestore, uid: string): Promise<RoleRecord> {
  const record: RoleRecord = {
    primary: null,
    additionalRoles: [],
    chapterId: null,
    hasRoleDoc: false,
  };
  try {
    // Supa seam (file-group 3): behind the flag, roles/{uid} is read
    // through the server route; null falls back to the direct getDoc.
    // The users/{uid} chapterId fallback below stays on Firestore —
    // the users collection belongs to the directory cluster.
    const seamDoc = rolesSupaEnabled() ? await seamGetDoc('roles', uid) : null;
    const roleSnap = seamDoc
      ? { exists: () => seamDoc.exists, data: () => seamDoc.data ?? {} }
      : await getDoc(doc(firestore, 'roles', uid));
    if (roleSnap.exists()) {
      record.hasRoleDoc = true;
      const data = roleSnap.data() as Record<string, unknown>;
      record.primary = typeof data.role === 'string' ? data.role : null;
      if (Array.isArray(data.additionalRoles)) {
        record.additionalRoles = data.additionalRoles.filter(
          (r): r is string => typeof r === 'string'
        );
      }
      record.chapterId = typeof data.chapterId === 'string' ? data.chapterId : null;
    }
  } catch (err) {
    console.error(`[RoleManager] Reading roles/${uid} failed:`, err);
  }
  if (record.chapterId === null) {
    try {
      const userSnap = await getDoc(doc(firestore, 'users', uid));
      if (userSnap.exists()) {
        const data = userSnap.data() as Record<string, unknown>;
        record.chapterId = typeof data.chapterId === 'string' ? data.chapterId : null;
      }
    } catch (err) {
      console.error(`[RoleManager] Reading users/${uid} failed:`, err);
    }
  }
  return record;
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
    // Custom roles (contracts K2): a definition-backed custom_ slug is
    // assignable as an additionalRoles entry only; the translation lives
    // in assignCustomRole. Non-prefixed unknowns (junk slugs included)
    // still die here, client-side, exactly as before.
    if (slug.startsWith('custom_')) {
      return assignCustomRole(_firestore, targetUid, slug, assignedBy, reason, opts);
    }
    console.error(`[RoleManager] Role "${slug}" does not resolve to a catalog key; not assigning.`);
    return false;
  }
  const body: Record<string, unknown> = {
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
  };
  if (opts?.preserveAdditionalRoles) {
    const record = await readRoleRecord(_firestore, targetUid);
    body.additionalRoles = record.additionalRoles.filter((r) => r !== resolved.key);
    body.chapterId = record.chapterId;
  }
  const res = await authedFetch('/api/admin/roles/write', body);
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
 * Grant a custom role (contracts K2 translation): POST an assign whose
 * primary is the target's current catalog primary (member_basic when no
 * roles record exists, mirroring the reconciliation bootstrap) and whose
 * additionalRoles are the current ones plus the custom slug, with the
 * target's chapterId forwarded. The server re-validates the definition,
 * the chapter match, and the Reserved Powers ceiling. Granting a slug
 * the target already holds is a no-op success (no write issued).
 */
export async function assignCustomRole(
  firestore: Firestore,
  targetUid: string,
  customSlug: string,
  assignedBy: string,
  reason: string,
  opts?: RoleWriteOpts
): Promise<boolean> {
  if (targetUid === FOUNDER_UID) {
    console.error(`[RoleManager] CRITICAL: Attempted to modify immutable Founder role. Target: ${targetUid}`);
    return false;
  }
  const slug = normalizeRoleSlug(String(customSlug));
  if (slug === 'superadmin' || !slug.startsWith('custom_')) {
    console.error(`[RoleManager] "${slug}" is not a custom role slug; not assigning.`);
    return false;
  }
  if (!reason || reason.trim().length < 10) {
    console.error(`[RoleManager] Error: Justification too short. Length: ${reason?.length || 0}`);
    return false;
  }
  const record = await readRoleRecord(firestore, targetUid);
  if (record.additionalRoles.includes(slug)) {
    console.log(`[RoleManager] ${targetUid} already holds ${slug}; nothing to grant.`);
    return true;
  }
  const res = await authedFetch('/api/admin/roles/write', {
    action: 'assign',
    uid: targetUid,
    role: record.primary ?? 'member_basic',
    additionalRoles: [...record.additionalRoles, slug],
    chapterId: record.chapterId,
    reason,
    consentRequestId: opts?.consentRequestId ?? null,
    // Expiry pair forwarding (expiry-ui, X11): the inspector's custom
    // grants route through here on the merged tree, so the decided
    // expiry must travel as a pair exactly as in assignRole above;
    // undefined keeps both keys out and the server preserves.
    ...(opts?.expiresAt !== undefined
      ? { expiresAt: opts.expiresAt, expiresRoleKey: opts.expiresRoleKey ?? slug }
      : {}),
  });
  if (res?.ok) {
    console.log(`[RoleManager] Granted custom role ${slug} to ${targetUid} via the write path.`);
    return true;
  }
  if (res) {
    const errBody = await res.json().catch(() => ({}));
    console.error(`[RoleManager] Custom assign failed: ${res.status} ${errBody?.error || ''}`);
  }
  return false;
}

/**
 * Remove ONE custom role from a holder: a plain re-assign of the current
 * primary with the slug filtered out of additionalRoles. (Prior-state
 * restoration at EXPIRY is the expiry sweep's job, not this function's.)
 * Returns false when there is no roles record - there is nothing to
 * remove. Removing a slug the target does not hold is a no-op success.
 */
export async function removeCustomRole(
  firestore: Firestore,
  targetUid: string,
  customSlug: string,
  removedBy: string,
  reason: string,
  opts?: RoleWriteOpts
): Promise<boolean> {
  if (targetUid === FOUNDER_UID) {
    console.error('CRITICAL: Attempted to modify immutable Founder role.');
    return false;
  }
  const slug = normalizeRoleSlug(String(customSlug));
  if (!slug.startsWith('custom_')) {
    console.error(`[RoleManager] "${slug}" is not a custom role slug; not removing.`);
    return false;
  }
  if (!reason || reason.trim().length < 10) {
    console.error('Error: Mandatory justification (min 10 chars) required for role removal.');
    return false;
  }
  const record = await readRoleRecord(firestore, targetUid);
  if (!record.hasRoleDoc || !record.primary) {
    console.error(`[RoleManager] ${targetUid} has no roles record; no custom role to remove.`);
    return false;
  }
  if (!record.additionalRoles.includes(slug)) {
    console.log(`[RoleManager] ${targetUid} does not hold ${slug}; nothing to remove.`);
    return true;
  }
  const res = await authedFetch('/api/admin/roles/write', {
    action: 'assign',
    uid: targetUid,
    role: record.primary,
    additionalRoles: record.additionalRoles.filter((r) => r !== slug),
    chapterId: record.chapterId,
    reason,
    consentRequestId: opts?.consentRequestId ?? null,
  });
  if (res?.ok) return true;
  if (res) {
    const errBody = await res.json().catch(() => ({}));
    console.error(`[RoleManager] Custom remove failed: ${res.status} ${errBody?.error || ''}`);
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
    // Supa seam first (flag-gated); null = Firestore path below.
    const seamDoc = rolesSupaEnabled() ? await seamGetDoc('roles', userUid) : null;
    if (seamDoc) {
      return seamDoc.exists ? ((seamDoc.data?.role as EnhancedUserRole) || 'guest') : 'guest';
    }
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
    // Supa seam first (flag-gated, canManageRoles-gated at the route);
    // null = Firestore query below.
    const seamDocs = rolesSupaEnabled()
      ? await seamQueryDocs('roles', 'role', String(role))
      : null;
    if (seamDocs) return seamDocs.map((d) => d.id);
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
