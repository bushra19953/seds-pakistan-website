/**
 * consents-resync.ts — the fs_consent_requests mirror guard runner
 * (consents mirror + seam program, 2026-10-30; modeled on
 * src/lib/applications-resync.ts, the P1 mirror-loudness guard).
 *
 * WHY THIS EXISTS: the consents surface dual-writes (Firestore
 * primary + fs_consent_requests mirror). The seam's mirror helpers
 * never throw, so a failed mirror write could strand a governance
 * record silently — invisible to seam reads once the `consents`
 * surface flips. This guard is the proactive backstop the standing
 * no-manual-backfills rule requires: a scheduled dry-run/repair pass
 * that detects residual drift and repairs it, reporting only when it
 * acts or finds something unhealable.
 *
 * WHAT IT DOES (the applications design, deliberately narrow):
 * - Firestore is primary. A Firestore doc with NO fs_consent_requests
 *   row is "missing" — the stranded shape. Repair mode re-mirrors it
 *   verbatim through the seam's own mirror helper (mirrorConsentSet —
 *   the same write path as live traffic, no parallel path here).
 * - An fs_consent_requests row with no Firestore doc is an "orphan":
 *   reported only, NEVER deleted (a delete decision on governance
 *   records is a human's, not a guard's).
 * - History rows (fs_consent_requests_history) are out of scope for
 *   presence checks here: enumerating every request's subcollection
 *   would multiply the scan's read cost; history completeness is
 *   seeded by the one-time backfill and maintained by dual-write.
 * - Drifted-but-present rows are out of scope: presence is what
 *   strands reads; field-level reconciliation belongs to the
 *   migration refresh, as the applications guard states.
 *
 * READ BUDGET (standing Firestore quota rule): the scan is capped at
 * CONSENTS_RESYNC_READ_BUDGET_CAP reads. The query asks for cap+1
 * docs; if the +1 exists the collection is over budget, the runner
 * reports overBudget and makes NO adapter writes (and does not even
 * read the fs side).
 *
 * The adapter comes from the seam's resolveConsentsAdapter(), so the
 * guard runs only when the consents surface is enabled and Supabase
 * is configured — the same gate as every other consents seam read.
 * Adapter-absent returns null and the route answers 503.
 */

import {
  CONSENTS_COLLECTION,
  mirrorConsentSet,
  resolveConsentsAdapter,
} from '@/lib/server/consents-supa';

export const CONSENTS_RESYNC_READ_BUDGET_CAP = 300;

/** Firestore rows are fetched in one capped query: cap + 1 as the tripwire. */
const SCAN_LIMIT = CONSENTS_RESYNC_READ_BUDGET_CAP + 1;

/** fs_consent_requests listing page size (the adapter pages by id past this). */
const FS_PAGE_SIZE = 1000;

export type ConsentsResyncMode = 'dry-run' | 'repair';

export interface ConsentsResyncReport {
  mode: ConsentsResyncMode;
  /** True when the Firestore scan tripped the read-budget cap; all counts are null and nothing was written. */
  overBudget: boolean;
  firestoreCount: number | null;
  supaCount: number | null;
  /** Firestore ids with no fs_consent_requests row. Reported in both modes. */
  missingIds: string[];
  /** Missing ids re-mirrored successfully (repair mode only). */
  repairedIds: string[];
  /** Missing ids whose repair mirror reported failure (repair mode only). */
  unhealableIds: string[];
  /** fs_consent_requests ids with no Firestore doc. Report only — never deleted. */
  orphanIds: string[];
  /** Firestore reads consumed by the scan (the capped query's snapshot size). */
  readsUsed: number;
}

/** Structural Firestore shape (Admin SDK in prod, fakes in tests). */
export interface ConsentsResyncDb {
  collection: (name: string) => {
    limit: (n: number) => {
      get: () => Promise<{
        size: number;
        docs: Array<{ id: string; data: () => Record<string, any> }>;
      }>;
    };
  };
}

/**
 * Run the consents resync. Returns null when the consents adapter is
 * unavailable (surface off / Supabase unconfigured) — the caller
 * answers 503. A Firestore scan error throws (the route surfaces it
 * as a 500), matching the applications/events runners. Mirror repair
 * failures never throw: the seam helper reports them as `false` and
 * the id lands in unhealableIds.
 */
export async function runConsentsResync(
  db: ConsentsResyncDb,
  mode: ConsentsResyncMode = 'dry-run',
): Promise<ConsentsResyncReport | null> {
  const adapter = resolveConsentsAdapter();
  if (!adapter) return null;

  const snap = await db.collection(CONSENTS_COLLECTION).limit(SCAN_LIMIT).get();
  const readsUsed = snap.size;

  if (snap.size > CONSENTS_RESYNC_READ_BUDGET_CAP) {
    return {
      mode,
      overBudget: true,
      firestoreCount: null,
      supaCount: null,
      missingIds: [],
      repairedIds: [],
      unhealableIds: [],
      orphanIds: [],
      readsUsed,
    };
  }

  const firestoreById = new Map<string, Record<string, any>>();
  for (const doc of snap.docs) {
    firestoreById.set(doc.id, doc.data() as Record<string, any>);
  }

  // fs_consent_requests ids, paged by id so a table larger than one
  // page can never silently truncate the set (the adapter's listDocs
  // honors limit + startAfter over id ordering).
  const fsIds = new Set<string>();
  let startAfter: string | undefined;
  for (;;) {
    const rows = await adapter.listDocs(CONSENTS_COLLECTION, {
      limit: FS_PAGE_SIZE,
      ...(startAfter !== undefined ? { startAfter } : {}),
    });
    for (const row of rows) {
      if (row && typeof row.id === 'string') fsIds.add(row.id);
    }
    if (rows.length < FS_PAGE_SIZE) break;
    const lastId = rows[rows.length - 1]?.id;
    if (typeof lastId !== 'string' || lastId === startAfter) break;
    startAfter = lastId;
  }

  const missingIds: string[] = [];
  for (const id of firestoreById.keys()) {
    if (!fsIds.has(id)) missingIds.push(id);
  }
  const orphanIds: string[] = [];
  for (const id of fsIds) {
    if (!firestoreById.has(id)) orphanIds.push(id);
  }

  const repairedIds: string[] = [];
  const unhealableIds: string[] = [];
  if (mode === 'repair') {
    for (const id of missingIds) {
      const mirrored = await mirrorConsentSet(id, firestoreById.get(id) ?? {});
      if (mirrored) repairedIds.push(id);
      else unhealableIds.push(id);
    }
  }

  return {
    mode,
    overBudget: false,
    firestoreCount: firestoreById.size,
    supaCount: fsIds.size,
    missingIds,
    repairedIds,
    unhealableIds,
    orphanIds,
    readsUsed,
  };
}
