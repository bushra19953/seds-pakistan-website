/**
 * Task-form house rules — the ONE source for the creation flow's
 * shared constants (UX fix program F1/F6, audit P1/P7).
 *
 * Before this module the same policy was baked independently into the
 * tasks page, the task form, POST /api/tasks and POST /api/workflows,
 * where the copies could drift and a silently filed default was
 * indistinguishable from a deliberate choice. Every consumer now reads
 * these values from here.
 *
 * NOTE: src/lib/server/gamification-transaction.ts still carries its
 * own literal payout fallback (10) — that file is under the C-07
 * NAMED BLOCKER (B-GAME-1) and opens only via its own program. Its
 * literal equals HOUSE_POINTS_DEFAULTS.bonus, so behaviour is
 * coherent; the gamification program can adopt this constant when it
 * legitimately opens the file.
 */

/** Minimum lead time between now and a workflow's final deadline. */
export const WORKFLOW_MIN_DEADLINE_HOURS = 24;

/** House points defaults, filed when the creator makes no choice. */
export const HOUSE_POINTS_DEFAULTS = {
  base: 10,
  penalty: 5,
  bonus: 10,
} as const;
