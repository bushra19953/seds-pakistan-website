// Retention policies (Workstream F). Defaults are the F-G decision
// defaults from the Phase 3 front matter (0.2), applied because the
// decisions are gated with defaults so silence does not block:
//   F-G2 rejected applications: retain 24 months, then archive + scrub.
//   F-G3 audit_logs: archive at 2 years, delete at 10 years.
//   F-G5 warnings: retain 10 years (interim, pending Decision 14).
// Governance classes are FLAG-FOR-REVIEW ONLY: the cron never deletes
// or scrubs them, whatever any stored override says.
//
// SPEC-GAP(F): Part F's detailed policy schema was never written; this
// shape (per-class thresholds in days + an action vocabulary) is the
// minimal model that expresses the F-G defaults and the front matter's
// "retention schema with flag-for-review-only cron".

import type { Firestore } from 'firebase-admin/firestore';

export type RetentionAction = 'archive' | 'scrub-pii' | 'delete' | 'flag-only';

export interface RetentionPolicy {
  key: string;
  collection: string;
  /** Field carrying the record's age timestamp. */
  dateField: string;
  /** Only rows matching this predicate description are in scope. */
  scope: string;
  archiveAfterDays: number | null;
  scrubAfterDays: number | null;
  deleteAfterDays: number | null;
  flagForReviewOnly: boolean;
  notes: string;
}

export const RETENTION_POLICIES_COLLECTION = 'retention_policies';

export const DEFAULT_RETENTION_POLICIES: RetentionPolicy[] = [
  {
    key: 'rejected_applications',
    collection: 'applications',
    dateField: 'createdAt',
    scope: 'status == rejected',
    archiveAfterDays: 730, // 24 months (F-G2)
    scrubAfterDays: 730,
    deleteAfterDays: null, // scrubbed shell is retained; never auto-deleted
    flagForReviewOnly: false,
    notes: 'F-G2: rejected applications retained 24 months, then archived to the backups folder and PII-scrubbed in place.',
  },
  {
    key: 'audit_logs',
    collection: 'audit_logs',
    dateField: 'timestamp',
    scope: 'all',
    archiveAfterDays: 730, // 2 years (F-G3)
    scrubAfterDays: null,
    deleteAfterDays: 3650, // 10 years (F-G3), only after a successful archive
    flagForReviewOnly: false,
    notes: 'F-G3: audit archive at 2 years, deletion at 10 years, never before the archive copy exists.',
  },
  {
    key: 'warnings',
    collection: 'warnings',
    dateField: 'createdAt',
    scope: 'all',
    archiveAfterDays: 3650,
    scrubAfterDays: null,
    deleteAfterDays: 3650, // interim (F-G5), pending Decision 14
    flagForReviewOnly: false,
    notes: 'F-G5 interim: warnings retained 10 years pending Decision 14 (warnings system disposition).',
  },
  {
    key: 'governance_records',
    collection: 'governance_records',
    dateField: 'createdAt',
    scope: 'all',
    archiveAfterDays: null,
    scrubAfterDays: null,
    deleteAfterDays: null,
    flagForReviewOnly: true,
    notes: 'Governance records are permanent instruments/evidence. Flag for human review only; the retention job never deletes or scrubs them.',
  },
  {
    key: 'consents',
    collection: 'consents',
    dateField: 'createdAt',
    scope: 'all',
    archiveAfterDays: null,
    scrubAfterDays: null,
    deleteAfterDays: null,
    flagForReviewOnly: true,
    notes: 'Consent records are evidence of Reserved Matter decisions. Flag for human review only.',
  },
  {
    key: 'decisions',
    collection: 'decisions',
    dateField: 'createdAt',
    scope: 'all',
    archiveAfterDays: null,
    scrubAfterDays: null,
    deleteAfterDays: null,
    flagForReviewOnly: true,
    notes: 'Decision register entries are permanent governance evidence. Flag for human review only.',
  },
];

const GOVERNANCE_CLASSES = new Set([
  'governance_records',
  'consents',
  'decisions',
]);

/**
 * Effective policies: stored overrides in retention_policies/{key} merge
 * over the defaults, EXCEPT flagForReviewOnly can never be turned off
 * for governance classes, and governance classes can never gain an
 * automatic action through an override.
 */
export async function getRetentionPolicies(
  db: Firestore,
): Promise<RetentionPolicy[]> {
  const policies: RetentionPolicy[] = [];
  for (const base of DEFAULT_RETENTION_POLICIES) {
    let merged = { ...base };
    try {
      const snap = await db
        .collection(RETENTION_POLICIES_COLLECTION)
        .doc(base.key)
        .get();
      if (snap.exists) {
        const stored = snap.data() as Partial<RetentionPolicy>;
        merged = {
          ...merged,
          archiveAfterDays:
            typeof stored.archiveAfterDays === 'number' ||
            stored.archiveAfterDays === null
              ? (stored.archiveAfterDays as number | null)
              : merged.archiveAfterDays,
          scrubAfterDays:
            typeof stored.scrubAfterDays === 'number' ||
            stored.scrubAfterDays === null
              ? (stored.scrubAfterDays as number | null)
              : merged.scrubAfterDays,
          deleteAfterDays:
            typeof stored.deleteAfterDays === 'number' ||
            stored.deleteAfterDays === null
              ? (stored.deleteAfterDays as number | null)
              : merged.deleteAfterDays,
          flagForReviewOnly:
            typeof stored.flagForReviewOnly === 'boolean'
              ? stored.flagForReviewOnly
              : merged.flagForReviewOnly,
        };
      }
    } catch (e) {
      console.error(`[retention] policy override read failed for ${base.key}:`, e);
    }
    if (GOVERNANCE_CLASSES.has(base.key)) {
      merged.flagForReviewOnly = true;
      merged.archiveAfterDays = null;
      merged.scrubAfterDays = null;
      merged.deleteAfterDays = null;
    }
    policies.push(merged);
  }
  return policies;
}

export async function saveRetentionPolicy(
  db: Firestore,
  key: string,
  patch: Partial<
    Pick<
      RetentionPolicy,
      'archiveAfterDays' | 'scrubAfterDays' | 'deleteAfterDays' | 'flagForReviewOnly'
    >
  >,
  updatedBy: string,
): Promise<RetentionPolicy> {
  const base = DEFAULT_RETENTION_POLICIES.find((p) => p.key === key);
  if (!base) throw new Error(`Unknown retention policy key: ${key}`);
  if (GOVERNANCE_CLASSES.has(key)) {
    throw new Error(
      'Governance classes are flag-for-review only and cannot be given automatic retention actions',
    );
  }
  await db
    .collection(RETENTION_POLICIES_COLLECTION)
    .doc(key)
    .set({ ...patch, updatedBy, updatedAt: new Date().toISOString() }, { merge: true });
  const all = await getRetentionPolicies(db);
  return all.find((p) => p.key === key) as RetentionPolicy;
}
