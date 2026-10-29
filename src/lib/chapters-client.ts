'use client';

/**
 * chapters-client — ONE shared, cached reader for the `chapters`
 * collection on the client.
 *
 * Before this module, three admin call sites each fired their own
 * unbounded getDocs over `chapters` with no sharing (UserTable's
 * chapter filter on mount; Role Registry on mount and again when its
 * Create Role dialog opens). This reader collapses them into a single
 * read per cache window:
 *
 *   - module-level promise cache, modelled on
 *     src/hooks/use-universities.ts (one in-flight/completed read is
 *     shared by every caller; a failure clears the cache so a later
 *     caller can retry), combined with
 *   - a 5-minute TTL, modelled on src/lib/role-definitions.ts
 *     (getAllRoleDefinitionsCached).
 *
 * The returned list preserves the underlying getDocs order (no
 * orderBy): callers that relied on a query orderBy('name', 'asc')
 * sort by name client-side on their own copy. The cached array itself
 * is shared — callers must not mutate it.
 */

import { collection, getDocs, type Firestore } from 'firebase/firestore';

export interface ChapterListItem {
  id: string;
  name: string;
}

const CHAPTERS_CACHE_TTL_MS = 5 * 60 * 1000;

let chaptersPromise: Promise<ChapterListItem[]> | null = null;
let chaptersExpiresAt = 0;

/**
 * All chapters as { id, name } (name falls back to the doc id, the
 * mapping every existing call site already used). Within the TTL
 * window every caller shares the first caller's single getDocs read.
 */
export function getChaptersCached(firestore: Firestore): Promise<ChapterListItem[]> {
  const now = Date.now();
  if (chaptersPromise && chaptersExpiresAt > now) {
    return chaptersPromise;
  }
  const promise = (async () => {
    const snap = await getDocs(collection(firestore, 'chapters'));
    return snap.docs.map((d) => ({
      id: d.id,
      name: (d.data() as any)?.name || d.id,
    }));
  })();
  chaptersPromise = promise;
  chaptersExpiresAt = now + CHAPTERS_CACHE_TTL_MS;
  // Clear the cache on failure so a later mount can retry the read
  // (the rejection still propagates to this call's callers).
  promise.catch(() => {
    if (chaptersPromise === promise) chaptersPromise = null;
  });
  return promise;
}

/** Invalidate the in-memory cache explicitly. */
export function invalidateChaptersCache() {
  chaptersPromise = null;
  chaptersExpiresAt = 0;
}
