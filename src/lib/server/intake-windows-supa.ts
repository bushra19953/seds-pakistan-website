/**
 * Intake windows -> Supabase seam (migration step 6, Cluster E).
 *
 * Consumers:
 *   src/app/api/public/intake-window/route.ts (READ: seam-first list)
 *   src/lib/server/intake-windows.ts          (MIRROR hook inside
 *     recomputeAndMirrorConfig, which runs after every admin window
 *     mutation — create, edit, cancel, uncancel — so one hook covers
 *     the whole write family in src/app/api/admin/intake-windows/**)
 *
 * Gate: useSupa('intake-windows') && getSupaClient() (default OFF).
 * Flag OFF, client unconfigured, or ANY adapter error => callers use
 * listWindows(db) and behave byte-identically.
 *
 * Shape note: listWindows() returns raw Firestore doc data (Timestamp
 * fields) sorted by opensAt ascending, with windowId filled from the
 * doc id when the doc omits it. The seam returns the same logical
 * shape: Supa rows carry ISO strings for the timestamp fields, and
 * every consumer (windowToLike / timestampLikeToMs in
 * src/lib/intake-windows/resolve.ts) already accepts ISO strings, so
 * resolution results are identical.
 *
 * The intake_config/current mirror doc is mirrored too (same hook),
 * with the serverTimestamp sentinel replaced by an ISO string of the
 * same instant — the adapter's storage shape.
 */
import { getSupaAdapter, getSupaClient, useSupa } from '@/lib/supa';
import { timestampLikeToMs } from '@/lib/intake-windows/resolve';
import type { IntakeWindow } from '@/types/intake-window';

export const INTAKE_WINDOWS_SUPA_SURFACE = 'intake-windows';
export const INTAKE_WINDOWS_COLLECTION = 'intake_windows';
export const INTAKE_CONFIG_COLLECTION = 'intake_config';
export const INTAKE_CONFIG_DOC_ID = 'current';

export function intakeWindowsSupaEnabled(): boolean {
  try {
    return useSupa(INTAKE_WINDOWS_SUPA_SURFACE) && !!getSupaClient();
  } catch {
    return false;
  }
}

export type IntakeWindowsRead =
  | { status: 'fallback' }
  | { status: 'ok'; windows: IntakeWindow[] };

export async function readWindowsViaSupa(): Promise<IntakeWindowsRead> {
  if (!intakeWindowsSupaEnabled()) return { status: 'fallback' };
  try {
    const docs = await getSupaAdapter().listDocs(INTAKE_WINDOWS_COLLECTION);
    const windows = docs.map((doc) => {
      const { id, ...data } = doc as Record<string, any>;
      return {
        ...data,
        windowId: typeof data.windowId === 'string' ? data.windowId : id,
      } as IntakeWindow;
    });
    windows.sort(
      (a, b) => timestampLikeToMs(a.opensAt) - timestampLikeToMs(b.opensAt),
    );
    return { status: 'ok', windows };
  } catch (err) {
    console.error('[intake-windows-supa] adapter read failed, falling back to Firestore:', err);
    return { status: 'fallback' };
  }
}

/**
 * Best-effort snapshot mirror — never throws. Upserts every window doc
 * in the snapshot (the full collection, as re-read by
 * recomputeAndMirrorConfig after a mutation). Windows are never
 * deleted in Firestore (cancel is a status), so an upsert-only
 * snapshot cannot resurrect a deleted window.
 */
export async function mirrorIntakeWindowsSnapshot(
  docs: Array<{ id: string; data: Record<string, unknown> }>,
): Promise<void> {
  if (!intakeWindowsSupaEnabled()) return;
  for (const doc of docs) {
    try {
      await getSupaAdapter().setDoc(INTAKE_WINDOWS_COLLECTION, doc.id, doc.data);
    } catch (e: any) {
      console.error('[intake-windows-supa] mirror window failed:', doc.id, e?.message || e);
    }
  }
}

/** Best-effort mirror of intake_config/current — never throws. */
export async function mirrorIntakeConfigDoc(data: Record<string, unknown>): Promise<void> {
  if (!intakeWindowsSupaEnabled()) return;
  try {
    await getSupaAdapter().setDoc(INTAKE_CONFIG_COLLECTION, INTAKE_CONFIG_DOC_ID, data, { merge: true });
  } catch (e: any) {
    console.error('[intake-windows-supa] mirror config failed:', e?.message || e);
  }
}
