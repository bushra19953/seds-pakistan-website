/**
 * Applications write law for the retention engine (cutover A8).
 *
 * The retention engine is generic: it writes through an injected
 * deps.db (the cron-g3 handle or Firestore, per the retention
 * route's own surface). Write point A8 in the applications census —
 * the engine's archive-stamp update, PII-scrub update (and delete,
 * which the applications policy never arms today: deleteAfterDays
 * is null) on `applications` docs — had NO hook into the
 * applications primacy/mirror law, so under applications primacy
 * with the retention route running on Firestore those updates would
 * land on the wrong store and drift fs_applications. The
 * applications primacy build named this as the cron/compliance
 * workstream's engine hook; this module is that hook, wired by the
 * cron/retention route into RetentionDeps.onDocWrite /
 * afterDocWrite (engine.ts).
 *
 * The law, for collection 'applications' only (every other
 * collection returns 'passthrough' / no-ops, so the engine's other
 * classes — audit_logs, warnings — are byte-identical):
 *
 * - isApplicationsSupaPrimary ACTIVE (both flags + adapter):
 *   onDocWrite performs the write through the applications seam's
 *   primary-first helpers and returns 'handled' — the engine skips
 *   its deps.db write. A primary failure (adapter failure, or an
 *   update on an unreconciled fs row) THROWS out of the hook: the
 *   engine records it exactly like a failing deps.db write
 *   (archive step: archiveFailed, destructive steps blocked —
 *   the data-safe direction for a PII scrub). No silent Firestore
 *   fallback under primacy.
 * - Primacy inactive: onDocWrite returns 'passthrough' (the engine
 *   writes deps.db as today — Firestore, or the cron-g3 handle when
 *   that surface serves the run), and afterDocWrite applies the
 *   seam's best-effort mirror (mirrorApplicationUpdate /
 *   mirrorDeleteDoc), which no-ops when the applications surface is
 *   OFF and logs its own failures without throwing. When the
 *   cron-g3 handle served the deps.db write, this mirror merges the
 *   same payload onto the same fs row a second time — an idempotent
 *   RMW merge, the same double-mirror posture A5 documents.
 *
 * READ SIDE, named: the engine's collection scan still reads
 * deps.db (the retention route's cron-g3 surface). Under
 * applications primacy WITHOUT cron-g3 flipped, Supa-only
 * application docs are invisible to the scan; every such doc is by
 * construction younger than the 730-day archive horizon at flip
 * time, and flipping cron-g3 (or running the applications
 * reconcile) closes the scan gap. The write law above is complete
 * in every flag combination for every doc the scan can see.
 */

import {
  APPLICATIONS_COLLECTION,
  applicationsPrimaryActive,
  mirrorApplicationUpdate,
  mirrorDeleteDoc,
  resolveApplicationsSupaAdapter,
  updateApplicationPrimaryFirst,
} from '@/lib/applications-supa';
import type { RetentionDocWrite } from './engine';

/**
 * Engine onDocWrite hook: 'handled' only for `applications` under
 * active applications primacy; 'passthrough' in every other state.
 * Throws when the primary write fails (loud, per primacy law).
 */
export async function retentionApplicationsDocWrite(
  write: RetentionDocWrite,
): Promise<'handled' | 'passthrough'> {
  if (write.collection !== APPLICATIONS_COLLECTION) return 'passthrough';
  if (!(await applicationsPrimaryActive())) return 'passthrough';
  if (write.kind === 'update') {
    await updateApplicationPrimaryFirst(write.id, write.data ?? {});
    return 'handled';
  }
  // Delete under primacy: the applications seam has no
  // delete-primary helper (its mirror delete is best-effort, the
  // wrong shape for a sole writer), so delete through the resolved
  // adapter directly and let failures throw. The applications
  // retention policy never arms delete today (deleteAfterDays:
  // null); this leg exists so the hook law is complete if a stored
  // policy override ever arms it.
  const adapter = await resolveApplicationsSupaAdapter();
  if (!adapter) {
    throw new Error(
      'applications retention delete under primacy: Supabase adapter unavailable',
    );
  }
  await adapter.deleteDoc(APPLICATIONS_COLLECTION, write.id);
  return 'handled';
}

/**
 * Engine afterDocWrite hook: the mirror leg for a committed
 * passthrough write on `applications`. No-op under active primacy
 * (the primary leg was the only write) and for every other
 * collection. The seam mirrors never throw.
 */
export async function retentionApplicationsAfterDocWrite(
  write: RetentionDocWrite,
): Promise<void> {
  if (write.collection !== APPLICATIONS_COLLECTION) return;
  if (await applicationsPrimaryActive()) return;
  if (write.kind === 'update') {
    await mirrorApplicationUpdate(write.id, write.data ?? {});
  } else {
    await mirrorDeleteDoc(APPLICATIONS_COLLECTION, write.id);
  }
}
