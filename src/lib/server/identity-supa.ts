// identity-supa: Supabase (PostgREST) identity loaders — drop-in Supa counterparts
// of the Firestore loaders in permissions.ts, reproducing the bundle /
// permission-doc contract in IDENTITY_DEPENDENCY_MAP.md §1 + §6 exactly.
//
// SEAM: every backing-store access in this module goes through the ONE
// internal fetchRowData(table, id) below. When the real adapter lands at
// src/lib/supa/, re-point fetchRowData's body at it; nothing else in this
// file (or in identity-backend.ts) changes.
//
// Failure semantics (§6.4d, the highest-risk divergence): an unconfigured
// client, an HTTP error, or a network failure THROWS. A throw is never
// converted to { exists: false } and never fabricates a bundle — a missing
// ROW is data ({ exists: false }); a failed LOOKUP is an error.
import type { IdentityBundle, PermissionDocEntry } from './identity-cache';

type PermissionCollection = 'roleDefinitions' | 'permissions';

const TABLE_FOR_COLLECTION: Record<PermissionCollection, string> = {
  roleDefinitions: 'fs_roleDefinitions',
  permissions: 'fs_permissions',
};

/**
 * The one store-access seam: fetch the `data` jsonb of the single row
 * `id = <id>` in `table` (fs_* landing shape: { id, firebase_uid,
 * parent_path, data jsonb }; rows are looked up by `id` — for fs_roles
 * `firebase_uid` is null, §6.2).
 *
 * Returns the row's data object, or null when NO row exists (a legitimate
 * successful read). Throws when Supabase is unconfigured or the request
 * fails for any reason.
 *
 * Exported for tests / the future adapter re-point only; loaders in this
 * module are the production callers.
 */
export async function fetchRowData(
  table: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      `[identity-supa] Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing); cannot read ${table}/${id}`,
    );
  }
  const endpoint = `${url.replace(/\/+$/, '')}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&select=data`;
  const res = await fetch(endpoint, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(
      `[identity-supa] PostgREST read failed for ${table}/${id}: HTTP ${res.status}`,
    );
  }
  const rows = (await res.json()) as Array<{ data: unknown }>;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const data = rows[0]?.data;
  if (data === null || data === undefined) return {};
  return data as Record<string, unknown>;
}

// Field projection copied from the Firestore loader (permissions.ts
// loadIdentityBundle): additionalRoles is sliced when it is an array so
// the bundle never aliases the source array, and stored as-is otherwise.
const sliceRoles = (value: unknown): unknown =>
  Array.isArray(value) ? [...value] : value;

/**
 * Supa counterpart of loadIdentityBundle (permissions.ts): exactly TWO
 * row lookups, in parallel — fs_roles id=uid and fs_users id=uid.
 * A missing row yields the exists:false object (never null roles/users).
 * roles.expiresAt is passed through VERBATIM from the jsonb (never
 * converted to a Date): expiry derivation downstream accepts the
 * {_seconds,_nanoseconds} object, ISO string, and epoch-millis shapes.
 */
export async function loadIdentityBundleFromSupa(
  uid: string,
): Promise<IdentityBundle> {
  const [roleData, userData] = await Promise.all([
    fetchRowData('fs_roles', uid),
    fetchRowData('fs_users', uid),
  ]);
  return {
    roles: {
      exists: roleData !== null,
      role: roleData?.role,
      additionalRoles: sliceRoles(roleData?.additionalRoles),
      // Verbatim jsonb passthrough — see header note on expiresAt shapes.
      expiresAt: roleData?.expiresAt,
      expiresRoleKey: roleData?.expiresRoleKey,
      chapterId: roleData?.chapterId,
    },
    users: {
      exists: userData !== null,
      role: userData?.role,
      displayRole: userData?.displayRole,
      additionalRoles: sliceRoles(userData?.additionalRoles),
      // Exactly === true semantics: jsonb true -> true, anything else
      // (including the string 'true') -> false.
      isBanned: userData?.isBanned === true,
      chapterId: userData?.chapterId,
    },
    loadedAt: Date.now(),
  };
}

/**
 * Supa counterpart of the Firestore permission-doc loader
 * (permissions.ts cachedDocGet loader): ONE row lookup —
 * fs_roleDefinitions / fs_permissions by id=slug. Present row ->
 * { exists: true, data: whole data jsonb }; absent row ->
 * { exists: false, data: undefined }. Lookup failures throw.
 */
export async function loadPermissionDocFromSupa(
  collection: PermissionCollection,
  slug: string,
): Promise<PermissionDocEntry> {
  const data = await fetchRowData(TABLE_FOR_COLLECTION[collection], slug);
  if (data === null) return { exists: false, data: undefined };
  return { exists: true, data };
}
