/**
 * Route-facing helpers for the ROLES admin API routes (Supabase
 * migration, roles cluster group 2: R16 in
 * ROLES_RESOLUTION_PARITY_MATRIX.md).
 *
 * Every helper here is a thin wrapper over the EXISTING server seam
 * (src/lib/server/supa-roles-seam.ts) — the same seam roles-1 wired
 * into src/lib/server/permissions.ts — so the routes get the exact
 * migration semantics that file-group established:
 *
 *   flag OFF (useSupa('roles') false) -> the seam returns null/false
 *     and the caller's Firestore code runs byte-identically;
 *   flag ON -> reads are served by the adapter over the fs_* tables;
 *     a genuinely missing doc is { exists:false } (data, never the
 *     fallback signal);
 *   adapter unavailable / error -> null/false, Firestore fallback.
 *
 * Writes stay Firestore-primary in every state (the routes' atomic
 * batches, consent gates and audits are unchanged); flag ON adds a
 * best-effort Supabase mirror AFTER the Firestore commit, through
 * the seam's mirror helpers, which never throw into the route.
 *
 * Only the four collections the roles cluster owns are seamable
 * (roles, roleDefinitions, permissions, role_permissions). `users`
 * and `chapters` reads/writes in these routes belong to other
 * clusters and always stay on Firestore.
 */

import {
  supaGetDoc,
  supaListDocs,
  supaMirrorDelete,
  supaMirrorSet,
  type SupaRolesCollection,
} from './supa-roles-seam';

export type { SupaRolesCollection };

/** Snapshot-shaped result matching the Admin-SDK doc snapshot the
 * routes already consume ({ exists, id, data() }). */
export interface SeamDocSnap {
  exists: boolean;
  id: string;
  data: () => Record<string, unknown> | undefined;
}

type FirestoreDocGet = () => Promise<{
  exists: boolean;
  id?: string;
  data: () => Record<string, unknown> | undefined;
}>;

/**
 * One doc read through the seam. Flag ON + adapter answers -> the
 * adapter's doc (missing = exists:false). Anything else (flag OFF,
 * no adapter, adapter error) -> the Firestore get runs exactly as
 * the route ran it before the migration.
 */
export async function seamDocGet(
  collection: SupaRolesCollection,
  id: string,
  firestoreGet: FirestoreDocGet,
): Promise<SeamDocSnap> {
  const supa = await supaGetDoc(collection, id);
  if (supa !== null) {
    return { exists: supa.exists, id, data: () => supa.data };
  }
  const snap = await firestoreGet();
  return { exists: snap.exists, id: snap.id ?? id, data: snap.data };
}

/**
 * Whole-collection list through the seam (these collections are
 * small: one doc per role / per holder). Same fallback contract as
 * seamDocGet: null from the seam means the Firestore list runs.
 */
export async function seamListDocs(
  collection: SupaRolesCollection,
  firestoreList: () => Promise<Array<{ id: string; data: Record<string, unknown> }>>,
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const rows = await supaListDocs(collection);
  if (rows !== null) return rows;
  return firestoreList();
}

/**
 * Holder ids for a role slug from the roles collection, flag ON:
 * the roles half of the routes' holders fences (primary `role` and
 * `additionalRoles` surfaces). Returns null when the seam cannot
 * answer (flag OFF / unavailable / error) — the caller then runs
 * its Firestore where() queries exactly as before. The users-mirror
 * half of every fence always stays on Firestore (other cluster).
 */
export async function seamRoleHolderIds(slug: string): Promise<Set<string> | null> {
  const rows = await supaListDocs('roles');
  if (rows === null) return null;
  const ids = new Set<string>();
  for (const { id, data } of rows) {
    if (data.role === slug) ids.add(id);
    else if (Array.isArray(data.additionalRoles) && data.additionalRoles.includes(slug)) {
      ids.add(id);
    }
  }
  return ids;
}

/**
 * Mirror payloads must be JSON-plain for the adapter's jsonb tables:
 * top-level Date values (the routes stamp updatedAt with new Date())
 * become ISO strings — the same treatment the merged role-definitions
 * mirror applies to timestamps (parity matrix R12 shape note).
 * Everything else is passed through untouched.
 */
export function toMirrorData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

/** Best-effort flag-ON mirror of a committed Firestore set. Never
 * throws (the seam swallows adapter errors into `false`). */
export async function mirrorSeamSet(
  collection: SupaRolesCollection,
  id: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  return supaMirrorSet(collection, id, toMirrorData(data));
}

/** Best-effort flag-ON mirror of a committed Firestore delete. */
export async function mirrorSeamDelete(
  collection: SupaRolesCollection,
  id: string,
): Promise<boolean> {
  return supaMirrorDelete(collection, id);
}

/* ---------------------------------------------------------------
 * WRITE-PRIMACY route wrappers (identity full build, design §2.1):
 * the route-facing forms of the seam's primary helpers. The
 * toMirrorData Date->ISO normalization the mirror wrappers carry is
 * the PRIMARY payload rule under primacy (renamed in effect, not in
 * behavior): primary payloads land JSON-plain in fs_* jsonb.
 * These THROW on adapter error (loud primary failure).
 */

import {
  supaPrimaryDelete,
  supaPrimarySet,
  supaPrimaryUpdate,
  supaRolesPrimaryEnabled,
} from './supa-roles-seam';

export { supaRolesPrimaryEnabled };

export async function primarySeamSet(
  collection: SupaRolesCollection,
  id: string,
  data: Record<string, unknown>,
  options?: { merge?: boolean },
): Promise<void> {
  await supaPrimarySet(collection, id, toMirrorData(data), options);
}

export async function primarySeamUpdate(
  collection: SupaRolesCollection,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  await supaPrimaryUpdate(collection, id, toMirrorData(data));
}

export async function primarySeamDelete(
  collection: SupaRolesCollection,
  id: string,
): Promise<void> {
  await supaPrimaryDelete(collection, id);
}
