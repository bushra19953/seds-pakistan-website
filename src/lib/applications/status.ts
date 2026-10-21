/**
 * Application status vocabulary for the ADMIN review pipeline
 * (phase2_spec.md Section F.6).
 *
 * One exported const that the universal-review route, the admin
 * applications page, the applicant tracker, and the cadetship pipe all
 * import, so the four writers can never drift apart again:
 *
 *   'shortlisted' means exactly "marked promising, NO consequence" - in
 *   particular it creates no account, role, invite, or cadetship.
 *   'approved'    means exactly "admitted to Cadetship" (post-Decision-17
 *   semantics); approval is the single entry point into the cadetship
 *   pipeline.
 *
 * Note: src/lib/applicant-status.ts owns a SEPARATE vocabulary for the
 * applicant-facing portal model (pending | under_review | shortlisted |
 * rejected | on_hold | approved on applications/{uid} portal docs). That
 * module predates this one and serves a different surface; do not merge
 * the two lists casually - a grep test pins this module's writers.
 */

export const KNOWN_APPLICATION_STATUSES = [
  'submitted',
  'under_review',
  'info_requested',
  'shortlisted',
  'approved',
  'rejected',
  'withdrawn',
] as const;

export type ApplicationStatus = (typeof KNOWN_APPLICATION_STATUSES)[number];

/** Terminal statuses: no further pipeline consequence may flow from these. */
export const TERMINAL_APPLICATION_STATUSES: ApplicationStatus[] = [
  'rejected',
  'withdrawn',
];

export function isKnownApplicationStatus(
  value: unknown,
): value is ApplicationStatus {
  return (
    typeof value === 'string' &&
    (KNOWN_APPLICATION_STATUSES as readonly string[]).includes(value)
  );
}
