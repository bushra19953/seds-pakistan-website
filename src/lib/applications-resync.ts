/**
 * applications-resync.ts — the fs_applications mirror guard runner
 * (P1 mirror-loudness fix, 2026-10-29).
 *
 * WHY THIS EXISTS: the applications surface writes dual-store
 * (Firestore primary + fs_applications mirror). The seam's mirror
 * helpers never throw, and before the P1 fix several call sites
 * ignored their failure boolean, so a failed mirror write stranded
 * a document silently (2026-10-28: three applications stranded in
 * Firestore with no fs_applications row, invisible to Supa reads).
 * The call sites are loud now; this guard is the proactive backstop
 * the standing no-manual-backfills rule requires: a scheduled
 * dry-run/repair pass that detects any residual drift and repairs
 * it, reporting only when it acts or finds something unhealable.
 *
 * WHAT IT DOES (the applications design — deliberately narrower
 * than the events resync in src/lib/supa-events/resync-events.ts):
 * - Firestore is primary. A Firestore doc with NO fs_applications
 *   row is "missing" — the stranded shape above. Repair mode
 *   re-mirrors it verbatim through the seam's own mirror helper
 *   (mirrorApplicationSet — the same write path as live traffic,
 *   no parallel path here).
 * - An fs_applications row with no Firestore doc is an "orphan":
 *   reported only, NEVER deleted (a delete decision on application
 *   records is a human's, not a guard's).
 * - Drifted-but-present rows are out of scope: presence is what
 *   strands reads; field-level reconciliation belongs to the
 *   migration refresh, as the seam's mirror-update contract states.
 *
 * READ BUDGET (standing Firestore quota rule): the scan is capped
 * at READ_BUDGET_CAP reads. The query asks for cap+1 docs; if the
 * +1 exists the collection is over budget, the runner reports
 * overBudget and makes NO adapter writes (and does not even read
 * the fs side) — a future census-grade pass needs its own budget
 * decision, it does not happen by accident here.
 *
 * The adapter comes from the seam's resolveApplicationsSupaAdapter(),
 * so the guard runs only when the applications surface is enabled
 * and Supabase is configured — the same gate as every other
 * applications mirror path. Adapter-absent returns null and the
 * route answers 503.
 */

import {
  APPLICATIONS_COLLECTION,
  mirrorApplicationSet,
  resolveApplicationsSupaAdapter,
} from '@/lib/applications-supa';

export const APPLICATIONS_RESYNC_READ_BUDGET_CAP = 300;

/** Firestore rows are fetched in one capped query: cap + 1 as the tripwire. */
const SCAN_LIMIT = APPLICATIONS_RESYNC_READ_BUDGET_CAP + 1;

/** fs_applications listing page size (the adapter pages by id past this). */
const FS_PAGE_SIZE = 1000;

export type ApplicationsResyncMode = 'dry-run' | 'repair';

export interface ApplicationsResyncReport {
  mode: ApplicationsResyncMode;
  /** True when the Firestore scan tripped the read-budget cap; all counts are null and nothing was written. */
  overBudget: boolean;
  firestoreCount: number | null;
  supaCount: number | null;
  /** Firestore ids with no fs_applications row. Reported in both modes. */
  missingIds: string[];
  /** Missing ids re-mirrored successfully (repair mode only). */
  repairedIds: string[];
  /** Missing ids whose repair mirror reported failure (repair mode only). */
  unhealableIds: string[];
  /** fs_applications ids with no Firestore doc. Report only — never deleted. */
  orphanIds: string[];
  /** Firestore reads consumed by the scan (the capped query's snapshot size). */
  readsUsed: number;
}

/** Structural Firestore shape (Admin SDK in prod, fakes in tests). */
export interface ApplicationsResyncDb {
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
 * Run the applications resync. Returns null when the applications
 * adapter is unavailable (surface off / Supabase unconfigured) —
 * the caller answers 503. A Firestore scan error throws (the
 * route's caller pattern surfaces it as a 500), matching the events
 * runner's behavior. Mirror repair failures never throw: the seam
 * helper reports them as `false` and the id lands in unhealableIds.
 */
export async function runApplicationsResync(
  db: ApplicationsResyncDb,
  mode: ApplicationsResyncMode = 'dry-run',
): Promise<ApplicationsResyncReport | null> {
  const adapter = await resolveApplicationsSupaAdapter();
  if (!adapter) return null;

  const snap = await db.collection(APPLICATIONS_COLLECTION).limit(SCAN_LIMIT).get();
  const readsUsed = snap.size;

  if (snap.size > APPLICATIONS_RESYNC_READ_BUDGET_CAP) {
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

  // fs_applications ids, paged by id so a table larger than one page
  // can never silently truncate the set (the adapter's listDocs
  // honors limit + startAfter over id ordering).
  const fsIds = new Set<string>();
  let startAfter: string | undefined;
  for (;;) {
    const rows = await adapter.listDocs(APPLICATIONS_COLLECTION, {
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
      const mirrored = await mirrorApplicationSet(id, firestoreById.get(id) ?? {});
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
