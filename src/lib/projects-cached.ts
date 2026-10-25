import { collection, getDocs, Firestore } from 'firebase/firestore';
import {
  fetchAdminProjectRowsViaRoute,
  getCurrentUserIdToken,
  projectsSupaClientEnabled,
} from './projects-supa';

/**
 * Projects list with lightweight in-memory caching.
 *
 * Same pattern as getAllRoleDefinitionsCached (src/lib/role-definitions.ts):
 * the projects collection is small and slow-changing, but several admin
 * surfaces used to one-shot the whole collection on every mount
 * (read-burn census P1: the admin tasks page paid the full projects
 * read on every load). Module-level caching makes repeat mounts in a
 * session free; concurrent callers share one in-flight fetch.
 *
 * Supabase migration (cluster I, C-14): the module's contract is
 * unchanged — same signature, same cache/TTL/in-flight semantics,
 * same { id, ...data } shape. Only the fetch inside the single
 * in-flight promise gained a first attempt: when the projects
 * client surface is ON (NEXT_PUBLIC_SUPA_SURFACES names 'projects')
 * the full admin row set is read through GET
 * /api/admin/projects/supa (which re-checks the server flag and
 * canManageProjects); ANY failure of that attempt — flag mismatch,
 * no token, route or adapter error — falls through to the Firestore
 * getDocs below, byte-identical to the pre-migration behavior. A
 * successful route read is cached exactly like a Firestore read; a
 * failed fetch (both backends) is still never cached.
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
    let list: ProjectDoc[] | null = null;
    if (projectsSupaClientEnabled()) {
      try {
        const token = await getCurrentUserIdToken();
        if (!token) throw new Error('projects supa read requires a token');
        const rows = await fetchAdminProjectRowsViaRoute(token);
        list = rows.map((r) => ({ id: r.id, ...(r.data as any) }));
      } catch {
        list = null; // fall through to the Firestore read below
      }
    }
    if (list === null) {
      const snap = await getDocs(collection(firestore, PROJECTS_COLLECTION));
      list = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as any),
      }));
    }
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
