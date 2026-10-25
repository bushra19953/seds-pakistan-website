/**
 * Supabase seam for the USERS G1 (directory API) + G2 (picker) surfaces:
 *   - GET /api/admin/users   (src/app/api/admin/users/route.ts)
 *   - GET /api/users/picker  (src/app/api/users/picker/route.ts)
 *
 * This module is the ONLY place in the users directory cluster that
 * knows about the Supabase adapter. It follows the merged profile seam
 * (src/lib/supa-seams/profile.ts): static import of the shipped adapter
 * from '@/lib/supa', plus a test-only adapter injection point.
 *
 * Behaviour contract (cluster DECISIONS.md, 2026-10-25):
 * - Gate: useSupa('users') AND getSupaClient() non-null. Flag OFF,
 *   unconfigured client, or adapter factory error -> null here, and
 *   callers run the Firestore path byte-identically to before.
 * - Adapter ERROR during a read: the helpers below THROW (never
 *   convert an error into an empty result); callers catch and fall
 *   back to the full Firestore path, so a Supa outage degrades to
 *   today's behaviour, never to a silently wrong directory.
 * - searchMethod: callers report "supabase" only when a read through
 *   this seam actually served the response (DECISIONS.md).
 * - Timestamps: this seam does NOT re-convert shapes. It consumes the
 *   adapter's read guarantee (SUPA_FIX_WAVE): legacy dumped
 *   {_seconds,_nanoseconds} values arrive as SupaTimestamp (working
 *   toDate()/toMillis()), ISO-stored values arrive as ISO strings.
 *   The one timestamp these surfaces consume — roles/{uid}.expiresAt
 *   — is rendered by the directory route's expiryIso(), which accepts
 *   both shapes (string passthrough, toDate() otherwise).
 *
 * FULL-SET SEARCH STRATEGY (the defect being designed out):
 * The Firestore Path B text search scores only a bounded window of
 * pageSize*3 docs ordered by doc id, so most of the directory is
 * invisible to a name search. The Supa path has NO window:
 * listAllUsers() issues ONE adapter listDocs('users') with no limit.
 * The adapter serves an unbounded read through its id-keyset paged
 * loop (page size 1000, src/lib/supa/adapter.ts fetchAllRows), so the
 * result cannot truncate at the PostgREST row cap. Bound relied on:
 * fs_users holds ~246 rows (full dump census 2026-10-25) — a single
 * adapter page — and even at 10x growth the adapter's paging, not a
 * route-level limit, is what bounds each round trip. Filtering
 * (chapter equality) is pushed to the adapter as a where clause
 * where Firestore did the same; name/email scoring then runs in
 * memory over the COMPLETE filtered set, exactly like the Firestore
 * scoring loop runs over its window — same scores, same pagination
 * shape, complete candidate set.
 */

import {
  getSupaAdapter,
  getSupaClient,
  useSupa,
  type SupaAdapter,
  type SupaDoc,
} from '@/lib/supa';

export const USERS_SURFACE = 'users';
export const USERS_COLLECTION = 'users';
export const ROLES_COLLECTION = 'roles';

export type UsersSupaAdapter = SupaAdapter;

/** A read row in Firestore-snapshot-ish shape: { id, data }. */
export interface SupaRow {
  id: string;
  data: Record<string, unknown>;
}

function strip(doc: SupaDoc): SupaRow {
  const { id, ...data } = doc as { id: string } & Record<string, unknown>;
  return { id: String(id), data };
}

/* ------------------------------------------------------- adapter gate */

let adapterOverride: SupaAdapter | null | undefined;

/** Test-only injection point (passing null forces "unavailable"). */
export function setUsersSupaAdapterForTests(adapter: SupaAdapter | null | undefined): void {
  adapterOverride = adapter;
}

export function resetUsersSupaAdapterForTests(): void {
  adapterOverride = undefined;
}

/**
 * The adapter for the users surfaces, or null when Supabase must not
 * serve: flag OFF, client unconfigured, or factory error. Never throws.
 */
export function getUsersSupaAdapter(): SupaAdapter | null {
  if (adapterOverride !== undefined) return adapterOverride;
  try {
    if (!useSupa(USERS_SURFACE)) return null;
    if (!getSupaClient()) return null;
    return getSupaAdapter();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ reads */

/**
 * The COMPLETE fs_users set (see header: unbounded adapter read, no
 * route-level limit, no window). Optional chapter equality is pushed
 * to the adapter as a where clause.
 */
export async function supaListAllUsers(
  adapter: SupaAdapter,
  chapterId?: string | null,
): Promise<SupaRow[]> {
  const docs = await adapter.listDocs(
    USERS_COLLECTION,
    chapterId ? { where: [['chapterId', '==', chapterId]] } : undefined,
  );
  return docs.map(strip);
}

/** Users whose stored field equals a value (role mirror, email probe). */
export async function supaListUsersWhere(
  adapter: SupaAdapter,
  field: string,
  value: unknown,
  limit?: number,
): Promise<SupaRow[]> {
  const docs = await adapter.listDocs(USERS_COLLECTION, {
    where: [[field, '==', value]],
    ...(limit !== undefined ? { limit } : {}),
  });
  return docs.map(strip);
}

/** Exact-email probe parity: at most one user doc for an address. */
export async function supaProbeUserByEmail(
  adapter: SupaAdapter,
  email: string,
): Promise<SupaRow[]> {
  return supaListUsersWhere(adapter, 'email', email, 1);
}

/** Roles docs whose primary role equals the slug (exact holders, part 1). */
export async function supaListRolesWhereRole(
  adapter: SupaAdapter,
  roleSlug: string,
): Promise<SupaRow[]> {
  const docs = await adapter.listDocs(ROLES_COLLECTION, {
    where: [['role', '==', roleSlug]],
  });
  return docs.map(strip);
}

/**
 * Users fetched by document id in chunks of 30 — the adapter translates
 * the '__name__' in clause onto the id column (adapter contract G1).
 * Missing ids are simply absent, exactly as with the Firestore query.
 */
export async function supaGetUsersByIds(
  adapter: SupaAdapter,
  ids: string[],
): Promise<SupaRow[]> {
  const rows: SupaRow[] = [];
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    if (chunk.length === 0) continue;
    const docs = await adapter.listDocs(USERS_COLLECTION, {
      where: [['__name__', 'in', chunk]],
    });
    rows.push(...docs.map(strip));
  }
  return rows;
}

/** Roles overlay rows for a set of uids, chunked by document id (30). */
export async function supaGetRolesByIds(
  adapter: SupaAdapter,
  ids: string[],
): Promise<SupaRow[]> {
  const rows: SupaRow[] = [];
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    if (chunk.length === 0) continue;
    const docs = await adapter.listDocs(ROLES_COLLECTION, {
      where: [['__name__', 'in', chunk]],
    });
    rows.push(...docs.map(strip));
  }
  return rows;
}
