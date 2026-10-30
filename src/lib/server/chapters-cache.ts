/**
 * Shared cached reader for the chapters collection (perf program,
 * 2026-10-30).
 *
 * The chapters list is a handful of small docs that change only
 * through consent-gated chapter-lifecycle acts, yet two hot request
 * paths re-read it from Firestore on every call: GET /api/v1/chapters
 * (the public chapters list) and the profile route's chapter leg
 * (loadChapterDocs' Firestore fallback), each paying the day's
 * Firestore latency (0.5–6 s on a degraded day) per request. This
 * reader collapses those repeats into one collection read per TTL
 * window per db handle.
 *
 * TTL: CHAPTERS_CACHE_TTL_MS = 5 minutes — the hierarchy feed /
 * leaderboard badge-definitions doctrine for small public reference
 * sets. Justification: chapter creation/rename/closure is a reserved,
 * consent-gated act that happens a few times a year, and the in-app
 * creation path invalidates synchronously (see below), so the TTL
 * only bounds out-of-band edits; a five-minute bound matches the
 * platform's existing public-set doctrine.
 *
 * Discipline (mirrors role-definitions-cache.ts):
 *   - Entries live in a WeakMap keyed by the exact db handle that
 *     produced them, so test fakes never see another fake's data.
 *   - Concurrent loads for the same handle coalesce behind one
 *     in-flight promise, evicted the moment it settles.
 *   - A failed load is NEVER cached and the error propagates, exactly
 *     as the uncached reads behaved at each call site.
 *   - An EMPTY snapshot is NEVER cached: a degraded read must not be
 *     able to pin an empty chapters list (the cached-empty failure
 *     mode is forbidden platform-wide). The chapters collection is
 *     never legitimately empty in production, so a zero-row load is
 *     treated as suspect and the next call re-reads.
 *   - invalidateChaptersCache(db) drops a handle's entry; the chapter
 *     creation paths call it synchronously after their write, so an
 *     in-app chapter appears on the next read, not at TTL expiry.
 */

export const CHAPTERS_CACHE_TTL_MS = 5 * 60 * 1000;

export interface ChapterRow {
  id: string;
  /** Doc data exactly as stored (doc.data() shape). */
  data: Record<string, unknown>;
}

/** Doc-shaped adapter for call sites written against Firestore docs. */
export interface ChapterDocLike {
  id: string;
  data: () => Record<string, unknown>;
}

interface CacheEntry {
  fetchedAt: number;
  rows: ChapterRow[];
}

type FirestoreLike = {
  collection: (name: string) => {
    get: () => Promise<any>;
  };
};

const cache = new WeakMap<object, CacheEntry>();
const inflight = new WeakMap<object, Promise<ChapterRow[]>>();

/**
 * The full chapters collection, cached per db handle. Throws only
 * when the Firestore load itself throws (the pre-cache behaviour at
 * the call sites); a successful non-empty load is cached, a
 * successful empty load is returned but never cached.
 */
export async function getChaptersSnapshot(
  db: FirestoreLike,
): Promise<ChapterRow[]> {
  const key = db as unknown as object;
  const entry = cache.get(key);
  if (entry && Date.now() - entry.fetchedAt < CHAPTERS_CACHE_TTL_MS) {
    return entry.rows;
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const promise = (async (): Promise<ChapterRow[]> => {
    try {
      const snap = await db.collection('chapters').get();
      const rows: ChapterRow[] = (
        snap.docs as Array<{ id: string; data: () => Record<string, unknown> }>
      ).map((d) => ({ id: d.id, data: d.data() ?? {} }));
      if (rows.length > 0) {
        cache.set(key, { fetchedAt: Date.now(), rows });
      }
      return rows;
    } finally {
      // Identity-checked cleanup: only evict our own in-flight entry.
      if (inflight.get(key) === promise) inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
}

/**
 * Active chapters as Firestore-doc-shaped objects — the drop-in
 * replacement for `db.collection('chapters').where('isActive', '==',
 * true).limit(n).get()` followed by reading `.docs`. The in-memory
 * filter is field-identical to the Firestore predicate (only docs
 * whose isActive is exactly true match).
 */
export async function getActiveChapterDocs(
  db: FirestoreLike,
  limit = 100,
): Promise<ChapterDocLike[]> {
  const rows = await getChaptersSnapshot(db);
  return rows
    .filter((row) => row.data.isActive === true)
    .slice(0, limit)
    .map((row) => ({ id: row.id, data: () => row.data }));
}

/** Drop one handle's cached snapshot (chapter write paths call this). */
export function invalidateChaptersCache(db: FirestoreLike): void {
  cache.delete(db as unknown as object);
}
