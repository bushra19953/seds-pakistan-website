/**
 * Shared cached reader for the roleDefinitions / permissions collections
 * (READ-BLEED FIX TRAIN 2, item C — census 18 SYSTEMIC + census 15
 * convergence).
 *
 * Three hot paths independently re-read these two small collections
 * UNCACHED on every call: the consent gate (isCategoryBRole's per-call
 * roleDefinitions/{slug} get), leave-notifications (candidateRoleSlugs'
 * full .get() on BOTH collections per reviewer lookup), and the admin
 * layout / identity path. Roles is Supabase-PRIMARY, so this reader is
 * seam-first: it lists through the roles seam (supaListDocs) when the
 * seam answers, and only then falls back to a Firestore collection
 * read through the caller's own db handle.
 *
 * Whichever source answers is cached in-process for
 * ROLE_DEFINITIONS_CACHE_TTL_MS: the seam result in a module-level
 * slot (it does not depend on any db handle), the Firestore result in
 * a WeakMap keyed by the exact db handle that produced it, so test
 * fakes never see another fake's data. A failed Firestore load is
 * never cached and the error propagates, exactly as the uncached
 * reads behaved at each call site.
 *
 * Displayed data is identical: the collections are the same, only the
 * redundant repeat reads are gone. Gate semantics at every call site
 * are unchanged — this module answers "what do the docs say", nothing
 * more.
 */

import { supaListDocs } from '@/lib/server/supa-roles-seam';

export type RoleCollectionName = 'roleDefinitions' | 'permissions';

export const ROLE_DEFINITIONS_CACHE_TTL_MS = 60_000;

export interface RoleCollectionSnapshot {
  /** Doc data by doc id, exactly as stored (doc.data() shape). */
  byId: Map<string, Record<string, unknown>>;
}

interface CacheEntry {
  fetchedAt: number;
  snapshot: RoleCollectionSnapshot;
}

type FirestoreLike = {
  collection: (name: string) => {
    // Structural minimum: the Admin SDK's collection .get() and the
    // test fakes both satisfy this; rows are narrowed in toSnapshot.
    get: () => Promise<any>;
  };
};

const seamCache = new Map<RoleCollectionName, CacheEntry>();
const firestoreCache = new WeakMap<object, Map<RoleCollectionName, CacheEntry>>();

function fresh(entry: CacheEntry | undefined): entry is CacheEntry {
  return !!entry && Date.now() - entry.fetchedAt < ROLE_DEFINITIONS_CACHE_TTL_MS;
}

function toSnapshot(
  rows: Array<{ id: string; data: Record<string, unknown> }>,
): RoleCollectionSnapshot {
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of rows) byId.set(row.id, row.data ?? {});
  return { byId };
}

/**
 * The full roleDefinitions or permissions collection, cached.
 *
 * Seam-first: a fresh seam cache entry wins; otherwise the roles seam
 * is asked (it returns null when the surface is off / unconfigured /
 * errored — never throws). Firestore fallback: a fresh per-handle
 * cache entry wins; otherwise one collection .get() through `db`.
 * Throws only when the Firestore load itself throws and no seam data
 * was available (the pre-cache behavior at the call sites). Returns
 * null when neither a seam answer nor a db handle is available.
 */
export async function getRoleCollectionSnapshot(
  db: FirestoreLike | null | undefined,
  collection: RoleCollectionName,
): Promise<RoleCollectionSnapshot | null> {
  const seamEntry = seamCache.get(collection);
  if (fresh(seamEntry)) return seamEntry.snapshot;

  const seamRows = await supaListDocs(collection);
  if (seamRows) {
    const snapshot = toSnapshot(seamRows);
    seamCache.set(collection, { fetchedAt: Date.now(), snapshot });
    return snapshot;
  }

  if (!db) return null;

  let perDb = firestoreCache.get(db as object);
  const fsEntry = perDb?.get(collection);
  if (fresh(fsEntry)) return fsEntry.snapshot;

  const snap = await db.collection(collection).get();
  const snapshot = toSnapshot(
    (snap.docs as Array<{ id: string; data: () => Record<string, unknown> }>).map((d) => ({
      id: d.id,
      data: d.data(),
    })),
  );
  if (!perDb) {
    perDb = new Map();
    firestoreCache.set(db as object, perDb);
  }
  perDb.set(collection, { fetchedAt: Date.now(), snapshot });
  return snapshot;
}

/** One roleDefinitions doc (or undefined when absent), via the shared cache. */
export async function getRoleDefinitionDoc(
  db: FirestoreLike | null | undefined,
  slug: string,
): Promise<Record<string, unknown> | undefined> {
  const snapshot = await getRoleCollectionSnapshot(db, 'roleDefinitions');
  return snapshot?.byId.get(slug);
}

/** All doc ids in a role collection, via the shared cache (null = unreadable). */
export async function listRoleCollectionIds(
  db: FirestoreLike | null | undefined,
  collection: RoleCollectionName,
): Promise<string[] | null> {
  const snapshot = await getRoleCollectionSnapshot(db, collection);
  return snapshot ? [...snapshot.byId.keys()] : null;
}

/** Test hook: drop every cached snapshot (seam + all Firestore handles). */
export function __resetRoleDefinitionsCacheForTests(): void {
  seamCache.clear();
  // WeakMap entries cannot be enumerated; tests that need a clean
  // Firestore-side cache pass a fresh fake handle, which is a new key.
}
