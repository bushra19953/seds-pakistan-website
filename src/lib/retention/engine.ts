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
            await deps.db
              .collection(policy.collection)
              .doc(r.id)
              .update({ retentionArchivedAt: started.toISOString() });
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
            await deps.db.collection(policy.collection).doc(r.id).delete();
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
              await deps.db
                .collection(policy.collection)
                .doc(r.id)
                .update(scrub);
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
