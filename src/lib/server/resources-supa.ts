/**
 * Resources + competitions -> Supabase seam (migration step 11,
 * Cluster K).
 *
 * Consumers (server routes added by this build; the resources surface
 * previously had NO server route — the public page and both admin
 * pages read/write Firestore directly from the browser):
 *   src/app/api/resources/route.ts               (GET list, POST create)
 *   src/app/api/resources/competitions/route.ts  (GET list)
 *   src/app/resources/page.tsx                    (public page: reads
 *     through GET /api/resources when the NEXT_PUBLIC twin flag is on;
 *     the route re-checks this server flag itself)
 *
 * Gate: useSupa('resources') && getSupaClient() (default OFF). Flag
 * OFF, client unconfigured, or ANY adapter error => routes serve their
 * Firestore (Admin SDK) path with the same response shape.
 *
 * Borrowed reads: the admin resources page also reads `users` and
 * `roles` for its notification targeting — those are Cluster B's
 * collections, already served by the directory adapter, and are NOT
 * re-pointed here (Cluster K's brief: delete borrowed reads, do not
 * re-create them).
 *
 * Writes: resources/competitions are admin-catalogue writes made
 * client-side today (src/lib/competitions.ts via the firestore
 * wrapper; admin resources pages via addDoc/updateDoc/deleteDoc).
 * Client writes cannot call the server adapter — mirrors are wired
 * into the server routes above (POST create mirrors best-effort);
 * the client write paths stay Firestore-primary and are recorded as
 * client-direct in the build report, the same ruling the chapters
 * and applications seams applied.
 */
import { getSupaAdapter, getSupaClient, isSupaPrimary, useSupa } from '@/lib/supa';
import type { SupaDoc } from '@/lib/supa';

export const RESOURCES_SUPA_SURFACE = 'resources';
export const RESOURCES_COLLECTION = 'resources';
export const COMPETITIONS_COLLECTION = 'competitions';

export function resourcesSupaEnabled(): boolean {
  try {
    return useSupa(RESOURCES_SUPA_SURFACE) && !!getSupaClient();
  } catch {
    return false;
  }
}

export type ResourcesRead =
  | { status: 'fallback' }
  | { status: 'ok'; docs: SupaDoc[] };

/** Resources in the public page's order: createdAt descending. The
 * adapter finishes data-field ordering client-side (Firestore-faithful
 * sort + id tiebreak, documents missing createdAt excluded — the same
 * existence rule Firestore's orderBy applies). */
export async function readResourcesViaSupa(): Promise<ResourcesRead> {
  if (!resourcesSupaEnabled()) return { status: 'fallback' };
  try {
    const docs = await getSupaAdapter().listDocs(RESOURCES_COLLECTION, {
      orderBy: { field: 'createdAt', direction: 'desc' },
    });
    return { status: 'ok', docs };
  } catch (err) {
    console.error('[resources-supa] adapter list failed, falling back to Firestore:', err);
    return { status: 'fallback' };
  }
}

export type CompetitionsRead =
  | { status: 'fallback' }
  | { status: 'ok'; docs: SupaDoc[] };

export async function readCompetitionsViaSupa(): Promise<CompetitionsRead> {
  if (!resourcesSupaEnabled()) return { status: 'fallback' };
  try {
    const docs = await getSupaAdapter().listDocs(COMPETITIONS_COLLECTION);
    return { status: 'ok', docs };
  } catch (err) {
    console.error('[resources-supa] adapter competitions list failed, falling back to Firestore:', err);
    return { status: 'fallback' };
  }
}

/* WRITE PRIMACY (cutover W4): isSupaPrimary('resources'). PrimaryFirst
 * helpers write the adapter FIRST and THROW on failure; callers then
 * run their Firestore write as the best-effort post-commit mirror.
 * OFF (default): return false, today's Firestore-first flow + mirror
 * runs byte-identically. NOTE: only the POST /api/resources create has
 * a server caller on this base — resource update/delete and all
 * competition CRUD are client-direct (see w4-census.md); the token
 * must not flip until those land server-side. */
export function resourcesSupaPrimary(): boolean {
  try {
    return isSupaPrimary(RESOURCES_SUPA_SURFACE) && !!getSupaClient();
  } catch {
    return false;
  }
}

export async function setResourcePrimaryFirst(id: string, data: Record<string, any>): Promise<boolean> {
  if (!resourcesSupaPrimary()) return false;
  await getSupaAdapter().setDoc(RESOURCES_COLLECTION, id, data);
  return true;
}

export async function setCompetitionPrimaryFirst(id: string, data: Record<string, any>): Promise<boolean> {
  if (!resourcesSupaPrimary()) return false;
  await getSupaAdapter().setDoc(COMPETITIONS_COLLECTION, id, data);
  return true;
}

/** Best-effort mirror of a Firestore resource create — never throws. */
export async function mirrorResourceCreate(id: string, data: Record<string, any>): Promise<void> {
  if (!resourcesSupaEnabled()) return;
  try {
    await getSupaAdapter().setDoc(RESOURCES_COLLECTION, id, data);
  } catch (e: any) {
    console.error('[resources-supa] mirror create failed:', e?.message || e);
  }
}

/** Best-effort mirror of a Firestore competition create — never throws. */
export async function mirrorCompetitionCreate(id: string, data: Record<string, any>): Promise<void> {
  if (!resourcesSupaEnabled()) return;
  try {
    await getSupaAdapter().setDoc(COMPETITIONS_COLLECTION, id, data);
  } catch (e: any) {
    console.error('[resources-supa] mirror competition create failed:', e?.message || e);
  }
}
