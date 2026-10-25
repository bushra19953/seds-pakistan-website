import { collection, getDocs, Firestore } from 'firebase/firestore';

/**
 * Projects list with lightweight in-memory caching.
 *
 * Same pattern as getAllRoleDefinitionsCached (src/lib/role-definitions.ts):
 * the projects collection is small and slow-changing, but several admin
 * surfaces used to one-shot the whole collection on every mount
 * (read-burn census P1: the admin tasks page paid the full projects
 * read on every load). Module-level caching makes repeat mounts in a
 * session free; concurrent callers share one in-flight fetch.
 */

export type ProjectDoc = {
  id: string;
  title?: string;
  slug?: string;
  [key: string]: any;
};

const PROJECTS_COLLECTION = 'projects';

type CacheEntry = { data: ProjectDoc[]; expiresAt: number } | null;
let cache: CacheEntry = null;
let inFlight: Promise<ProjectDoc[]> | null = null;

/**
 * Get all projects with lightweight in-memory caching.
 * - Defaults to 5 minutes TTL.
 */
export async function getAllProjectsCached(
  firestore: Firestore,
  ttlMs: number = 5 * 60 * 1000
): Promise<ProjectDoc[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.data;
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const snap = await getDocs(collection(firestore, PROJECTS_COLLECTION));
    const list: ProjectDoc[] = snap.docs.map((d) => ({
      id: d.id,
      ...(d.data() as any),
    }));
    cache = { data: list, expiresAt: Date.now() + Math.max(10_000, ttlMs) };
    return list;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Invalidate the in-memory cache explicitly. */
export function invalidateProjectsCache() {
  cache = null;
}
