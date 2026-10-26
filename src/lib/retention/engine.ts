// Retention engine (Workstream F). Applies retention_policies over
// injected dependencies so it is fully testable on fixtures.
//
// Invariants:
// - Governance classes (flagForReviewOnly) are NEVER modified; the
//   engine only counts them for the review report.
// - Nothing is scrubbed or deleted unless an archive copy was written
//   successfully - in this run, or recorded on the doc by a prior run
//   (retentionArchivedAt). A failed archive skips the destructive step.
// - "Scrub" for rejected applications removes PII fields in place and
//   keeps a non-identifying shell (status, dates, counts), per F-G2.
//
// SPEC-GAP(F): the draft never specified scrub field lists or the run
// report shape; both are defined here minimally and marked.

import { getRetentionPolicies, type RetentionPolicy } from './policies';

/** One per-doc write the engine is about to perform (cutover A8 hook). */
export interface RetentionDocWrite {
  collection: string;
  id: string;
  kind: 'update' | 'delete';
  /** The update payload (kind 'update' only). */
  data?: Record<string, unknown>;
}

export interface RetentionDeps {
  db: {
    collection: (name: string) => {
      get: () => Promise<{
        docs: Array<{
          id: string;
          ref: unknown;
          data: () => Record<string, unknown>;
        }>;
        empty: boolean;
        size: number;
      }>;
      doc: (id: string) => {
        update: (data: Record<string, unknown>) => Promise<void>;
        delete: () => Promise<void>;
      };
    };
  };
  /**
   * Generic per-doc write hook (cutover A8 — the engine-level hook
   * the applications primacy build assigned to this workstream).
   * Consulted BEFORE every doc update/delete the engine performs,
   * for every collection:
   * - return 'handled': the hook performed the write under the
   *   collection's own primacy/mirror law; the engine SKIPS its
   *   deps.db write (writing through deps.db as well would put the
   *   same change on a second store — and when deps.db is not the
   *   collection's primary store, on the WRONG store).
   * - return 'passthrough' (or hook absent): the engine writes via
   *   deps.db exactly as before; `afterDocWrite` then runs.
   * A THROWING hook aborts that write and surfaces through the same
   * error handling a failing deps.db write hits (archive step:
   * archiveFailed + class error; delete/scrub: class error) — under
   * primacy a hook failure IS the primary write failing, and it must
   * be loud, never silently bypassed by a deps.db write.
   * The production wiring (cron/retention route) supplies the
   * applications law from src/lib/retention/applications-write-hook.ts;
   * every other collection returns 'passthrough' there.
   */
  onDocWrite?: (write: RetentionDocWrite) => Promise<'handled' | 'passthrough'>;
  /**
   * Best-effort companion to onDocWrite, run after a 'passthrough'
   * deps.db write commits (the mirror leg of a collection's
   * dual-write law). Errors are swallowed by the engine: a failed
   * mirror must not fail a write that already committed (the seam
   * helpers it calls log their own failures).
   */
  afterDocWrite?: (write: RetentionDocWrite) => Promise<void>;
  /** Archive a batch of docs (production: JSON into the backups Drive folder). */
  archiveDocs: (
    collection: string,
    docs: Array<{ id: string; data: Record<string, unknown> }>,
  ) => Promise<void>;
  now: () => Date;
}

export interface RetentionClassReport {
  key: string;
  collection: string;
  scanned: number;
  archived: number;
  scrubbed: number;
  deleted: number;
  flaggedForReview: number;
  errors: string[];
}

export interface RetentionRunReport {
  startedAt: string;
  finishedAt: string;
  classes: RetentionClassReport[];
}

function toMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  if (value instanceof Date) return value.getTime();
  if (
    typeof value === 'object' &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    return ((value as { toDate: () => Date }).toDate()).getTime();
  }
  if (
    typeof value === 'object' &&
    typeof (value as { seconds?: unknown }).seconds === 'number'
  ) {
    return (value as { seconds: number }).seconds * 1000;
  }
  return null;
}

function inScope(policy: RetentionPolicy, data: Record<string, unknown>): boolean {
  if (policy.scope === 'status == rejected') {
    return data.status === 'rejected';
  }
  return true;
}

// SPEC-GAP(F): PII field list for the rejected-application scrub.
const APPLICATION_PII_FIELDS = [
  'fullName',
  'email',
  'phoneNumber',
  'phone',
  'cnic',
  'address',
  'answers',
  'statementOfPurpose',
  'dateOfBirth',
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Perform one engine doc write through the A8 hook law (see
 * RetentionDeps.onDocWrite): hook-first when a hook is wired, the
 * deps.db write on 'passthrough', the best-effort after-hook after
 * a committed deps.db write. With no hooks wired this is exactly
 * the pre-hook deps.db write.
 */
async function writeEngineDoc(
  deps: RetentionDeps,
  write: RetentionDocWrite,
): Promise<void> {
  if (deps.onDocWrite) {
    const verdict = await deps.onDocWrite(write);
    if (verdict === 'handled') return;
  }
  if (write.kind === 'update') {
    await deps.db
      .collection(write.collection)
      .doc(write.id)
      .update(write.data ?? {});
  } else {
    await deps.db.collection(write.collection).doc(write.id).delete();
  }
  if (deps.afterDocWrite) {
    try {
      await deps.afterDocWrite(write);
    } catch {
      // Mirror leg: best-effort by contract (see RetentionDeps).
    }
  }
}

export async function runRetention(
  deps: RetentionDeps,
  policyOverride?: RetentionPolicy[],
): Promise<RetentionRunReport> {
  const started = deps.now();
  const policies =
    policyOverride ?? (await getRetentionPolicies(deps.db as never));
  const reports: RetentionClassReport[] = [];

  for (const policy of policies) {
    const report: RetentionClassReport = {
      key: policy.key,
      collection: policy.collection,
      scanned: 0,
      archived: 0,
      scrubbed: 0,
      deleted: 0,
      flaggedForReview: 0,
      errors: [],
    };
    try {
      const snap = await deps.db.collection(policy.collection).get();
      const rows = snap.docs
        .map((d) => ({ id: d.id, data: d.data() }))
        .filter((r) => inScope(policy, r.data));
      report.scanned = rows.length;

      if (policy.flagForReviewOnly) {
        // Never modified. The review count is the whole class.
        report.flaggedForReview = rows.length;
        reports.push(report);
        continue;
      }

      const nowMs = started.getTime();
      const olderThan = (
        r: { data: Record<string, unknown> },
        days: number | null,
      ): boolean => {
        if (days === null) return false;
        const t = toMillis(r.data[policy.dateField]);
        return t !== null && nowMs - t >= days * DAY_MS;
      };

      // Archive step: everything past the archive threshold that is
      // not archived yet, in ONE batch call per class. A failed
      // archive blocks every destructive step for those docs.
      const needArchive = rows.filter(
        (r) =>
          olderThan(r, policy.archiveAfterDays) &&
          !r.data.retentionArchivedAt &&
          (olderThan(r, policy.scrubAfterDays) ||
            olderThan(r, policy.deleteAfterDays) ||
            policy.archiveAfterDays !== null),
      );
      let archiveFailed = false;
      if (needArchive.length > 0) {
        try {
          await deps.archiveDocs(policy.collection, needArchive);
          for (const r of needArchive) {
            await writeEngineDoc(deps, {
              collection: policy.collection,
              id: r.id,
              kind: 'update',
              data: { retentionArchivedAt: started.toISOString() },
            });
            r.data.retentionArchivedAt = started.toISOString();
            report.archived += 1;
          }
        } catch (e) {
          archiveFailed = true;
          report.errors.push(
            `archive failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      if (!archiveFailed) {
        // Delete step (only docs with an archive copy on record).
        for (const r of rows) {
          if (
            olderThan(r, policy.deleteAfterDays) &&
            r.data.retentionArchivedAt &&
            !r.data.retentionScrubbedAt
          ) {
            await writeEngineDoc(deps, {
              collection: policy.collection,
              id: r.id,
              kind: 'delete',
            });
            report.deleted += 1;
          }
        }
        // Scrub step for rejected applications.
        if (policy.scrubAfterDays !== null) {
          for (const r of rows) {
            if (
              olderThan(r, policy.scrubAfterDays) &&
              r.data.retentionArchivedAt &&
              !r.data.retentionScrubbedAt
            ) {
              const scrub: Record<string, unknown> = {
                retentionScrubbedAt: started.toISOString(),
              };
              for (const field of APPLICATION_PII_FIELDS) {
                if (field in r.data) scrub[field] = null;
              }
              await writeEngineDoc(deps, {
                collection: policy.collection,
                id: r.id,
                kind: 'update',
                data: scrub,
              });
              report.scrubbed += 1;
            }
          }
        }
      }
    } catch (e) {
      report.errors.push(e instanceof Error ? e.message : String(e));
    }
    reports.push(report);
  }

  return {
    startedAt: started.toISOString(),
    finishedAt: deps.now().toISOString(),
    classes: reports,
  };
}
