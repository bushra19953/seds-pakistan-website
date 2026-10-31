/**
 * Mirror-on-write for the timeline collection (2026-11-01).
 *
 * Timeline writes are server-routed already: POST
 * /api/admin/pages/write (WS10) performs the Firestore set/delete
 * for `collection: 'timeline'` behind canManageTimeline. That route
 * calls the two helpers here AFTER a successful Firestore write, so
 * every admin create/edit/delete lands in fs_timeline in the same
 * request. Before this module the route's own header said it plainly:
 * "none of these writes had a Supabase mirror: Firestore-only parity"
 * — the drift hole the daily resync guard (resync-timeline.ts) now
 * only has to backstop, not carry.
 *
 * Both helpers are best-effort and NEVER throw: a mirror failure must
 * not fail the admin's write (Firestore is primary). Failures log
 * loudly; the drift they leave is exactly what the resync guard
 * detects and repairs. While the 'timeline' surface is off the
 * adapter is unavailable and mirroring is a no-op — the pre-flip
 * drift is repaired by the one-time resync run at flip time.
 */

import { toSupaSerializable } from '@/lib/supa-events/server-events';
import { resolveTimelineAdapter, TIMELINE_COLLECTION_PATH } from './public-timeline';

/**
 * Mirror one timeline doc from its Firestore source. `sourceData` is
 * the doc's data as stored in Firestore (the write route re-reads
 * the stored doc so serverTimestamp stamps are the real values);
 * null means the doc no longer exists and the mirror row is deleted.
 */
export async function mirrorTimelineDoc(
  id: string,
  sourceData: Record<string, unknown> | null,
): Promise<'upserted' | 'deleted' | 'skipped' | 'failed'> {
  const adapter = resolveTimelineAdapter();
  if (!adapter) return 'skipped';
  try {
    if (sourceData === null) {
      await adapter.deleteDoc(TIMELINE_COLLECTION_PATH, id);
      return 'deleted';
    }
    const serialized = toSupaSerializable(sourceData) as Record<string, unknown>;
    await adapter.setDoc(TIMELINE_COLLECTION_PATH, id, serialized);
    return 'upserted';
  } catch (err) {
    console.error(`[supa-timeline] mirror failed for timeline/${id}:`, err);
    return 'failed';
  }
}

/** Mirror a timeline deletion (the doc is already gone in Firestore). */
export async function mirrorTimelineDelete(id: string): Promise<'deleted' | 'skipped' | 'failed'> {
  const adapter = resolveTimelineAdapter();
  if (!adapter) return 'skipped';
  try {
    await adapter.deleteDoc(TIMELINE_COLLECTION_PATH, id);
    return 'deleted';
  } catch (err) {
    console.error(`[supa-timeline] mirror delete failed for timeline/${id}:`, err);
    return 'failed';
  }
}
