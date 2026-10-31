/**
 * Public-timeline seam for the Firestore -> Supabase migration
 * (timeline surface, 2026-11-01; pattern: the E4 events seam,
 * src/lib/supa-events/public-events.ts).
 *
 * WHY THIS EXISTS: the public timeline (homepage teaser + /timeline)
 * read the Firestore `timeline` collection directly from the browser
 * with `where('isPublished','==',true) + orderBy('position')`. That
 * query needs a composite index that was never created, so it failed
 * FAILED_PRECONDITION and the section rendered silently empty (the
 * component never read the hook's error state). This seam takes the
 * read off Firestore entirely, behind a cached-shape server route,
 * exactly like events (/api/events/public): fs_timeline is the read
 * source when the 'timeline' surface is on; any failure answers null
 * so the route 503s and the component runs its Firestore path
 * byte-identically to before (the fallback query's composite index
 * was created 2026-11-01 and is in firestore.indexes.json).
 *
 * This module is the ONE place in the timeline surfaces that knows
 * about Supabase. The server route `src/app/api/timeline/public`
 * calls the helpers here; browser code never imports this module
 * (it statically binds the server-only adapter) — browsers import
 * the hint from public-timeline-client.ts only.
 *
 * Exposure parity: firestore.rules gives timeline public read (the
 * section renders for anonymous visitors today), so a service-role
 * server route serving published rows reproduces that exposure. The
 * published predicate is pushed into the adapter query itself, so
 * drafts never leave the server.
 *
 * Query preservation (the component's Firestore shapes, verbatim):
 * - full:   where isPublished==true, orderBy position asc, limit 200
 *           (the component's TIMELINE_FULL_LIMIT).
 * - teaser: where isPublished==true, orderBy position desc,
 *           limit 7 (TIMELINE_TEASER_LIMIT 6 + 1 sentinel row whose
 *           presence drives the "View the full timeline" link; the
 *           component reverses back to chronological and slices).
 */

import { getSupaAdapter, getSupaClient, parseSupaSurfaces, useSupa } from '@/lib/supa';
import { normalizeSupaData, toPublicJson } from '@/lib/supa-events/public-events';
import { PUBLIC_TIMELINE_SURFACE } from './public-timeline-client';

export { PUBLIC_TIMELINE_SURFACE, publicTimelineSupaClientEnabled } from './public-timeline-client';
export { normalizeSupaData, toPublicJson };

export const TIMELINE_COLLECTION_PATH = 'timeline';

/** Mirrors TIMELINE_FULL_LIMIT in timeline-section.tsx. */
export const TIMELINE_SEAM_FULL_LIMIT = 200;
/** Mirrors TIMELINE_TEASER_LIMIT + 1 (sentinel) in timeline-section.tsx. */
export const TIMELINE_SEAM_TEASER_LIMIT = 7;

/* ------------------------------------------------------------------ types */

/** Structural copy of the adapter contract (see the events seam). */
export interface TimelineSupaAdapter {
  getDoc(collectionPath: string, id: string): Promise<Record<string, unknown> | null>;
  listDocs(collectionPath: string, options?: unknown): Promise<Record<string, unknown>[]>;
  countDocs(collectionPath: string, where?: unknown): Promise<number>;
  setDoc(
    collectionPath: string,
    id: string,
    data: Record<string, unknown>,
    options?: { merge?: boolean },
  ): Promise<Record<string, unknown>>;
  updateDoc(
    collectionPath: string,
    id: string,
    updates: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  deleteDoc(collectionPath: string, id: string): Promise<void>;
}

/* ------------------------------------------------------------------- flags */

/**
 * Surface check against an explicit env (test/audit surface): the
 * ADAPTER's own parser applied to the given env's SUPA_SURFACES.
 */
export function supaSurfaceEnabled(
  surface: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    const surfaces = parseSupaSurfaces(env.SUPA_SURFACES);
    return surfaces.has('*') || surfaces.has(surface.trim().toLowerCase());
  } catch {
    return false;
  }
}

/**
 * The operative runtime flag check: with no argument it delegates to
 * the adapter's statically bound `useSupa('timeline')` reading the
 * process env at call time. An explicit env argument evaluates that
 * env through the adapter parser instead. Never throws — a
 * resolution failure means "off", i.e. Firestore serves.
 */
export function publicTimelineSupaEnabled(env?: NodeJS.ProcessEnv): boolean {
  if (env !== undefined) return supaSurfaceEnabled(PUBLIC_TIMELINE_SURFACE, env);
  try {
    return useSupa(PUBLIC_TIMELINE_SURFACE);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------- adapter resolve */

let injectedAdapter: TimelineSupaAdapter | null | undefined;

/** Test seam: inject a mock adapter (or null to force "unavailable").
 * Overrides getSupaAdapter(); the flag gate above still applies. */
export function setPublicTimelineAdapterForTests(
  adapter: TimelineSupaAdapter | null | undefined,
): void {
  injectedAdapter = adapter;
}

/**
 * Returns the shared adapter when the 'timeline' surface is on AND a
 * Supabase client is configured, otherwise null. Never throws. Used
 * by the read API below AND by the write-side mirror + resync (they
 * share the same gate: no mirror exists while the surface is off).
 */
export function resolveTimelineAdapter(): TimelineSupaAdapter | null {
  if (!publicTimelineSupaEnabled()) return null;
  if (injectedAdapter !== undefined) return injectedAdapter;
  try {
    if (!getSupaClient()) return null; // unconfigured -> Firestore fallback
    return (getSupaAdapter() as unknown as TimelineSupaAdapter) ?? null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- read API */

async function listTimeline(
  options: Record<string, unknown>,
  label: string,
): Promise<Array<Record<string, unknown>> | null> {
  const adapter = resolveTimelineAdapter();
  if (!adapter) return null;
  try {
    const rows = await adapter.listDocs(TIMELINE_COLLECTION_PATH, options);
    return rows.map((row) => normalizeSupaData(row) as Record<string, unknown>);
  } catch (err) {
    console.error(`[supa-timeline] ${label} failed:`, err);
    return null;
  }
}

/**
 * The /timeline page's query, verbatim: published only, position
 * ascending, bounded at 200. Returns null when Supabase is
 * unavailable so the route 503s and the client falls back.
 */
export async function listTimelineFull(): Promise<Array<Record<string, unknown>> | null> {
  return listTimeline(
    {
      where: [['isPublished', '==', true]],
      orderBy: { field: 'position', direction: 'asc' },
      limit: TIMELINE_SEAM_FULL_LIMIT,
    },
    'listTimelineFull',
  );
}

/**
 * The homepage teaser's query, verbatim: published only, position
 * descending, limit 7 (6 displayed + sentinel). The component
 * reverses to chronological order and slices, exactly as it does
 * with the Firestore rows today.
 */
export async function listTimelineTeaser(): Promise<Array<Record<string, unknown>> | null> {
  return listTimeline(
    {
      where: [['isPublished', '==', true]],
      orderBy: { field: 'position', direction: 'desc' },
      limit: TIMELINE_SEAM_TEASER_LIMIT,
    },
    'listTimelineTeaser',
  );
}
