/**
 * penalty-schedule.ts - the pure math of the geometric hourly
 * deadline penalty (Founder-approved design, 2026-11-06;
 * second-brain Orders 47/48 Item A).
 *
 * While a task sits past its deadline unsubmitted, its penalty grows
 * by the hour on a doubling schedule (2, 4, 8, 16, 32, ...), strictly
 * capped at the task's own penaltyPoints. This module is the single
 * source for that schedule: the accrual pass
 * (src/lib/server/penalty-accrual.ts) settles it against member
 * balances, and the completion transaction
 * (src/lib/server/gamification-transaction.ts) reads the accrued
 * total back so it can apply only the remaining penalty. Pure and
 * dependency-free, in the style of src/lib/deadline-fairness.ts.
 */

const HOUR_MS = 60 * 60 * 1000;

/**
 * Total penalty accrued after `hoursOverdue` whole hours on the
 * doubling schedule (2 + 4 + 8 + ...), capped at `cap`. Zero before
 * the first full hour. The loop stops at the cap, so arbitrarily
 * large hour counts stay exact and cheap.
 */
export function accruedPenaltyForHours(hoursOverdue: number, cap: number): number {
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  const hours = Math.floor(hoursOverdue);
  if (!Number.isFinite(hours) || hours < 1) return 0;
  let total = 0;
  let increment = 2;
  for (let h = 0; h < hours; h++) {
    total += increment;
    if (total >= cap) return cap;
    increment *= 2;
  }
  return Math.min(total, cap);
}

/** Whole hours between the deadline and now; never negative. */
export function wholeHoursOverdue(deadlineMs: number, nowMs: number): number {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return 0;
  const elapsed = nowMs - deadlineMs;
  if (elapsed < HOUR_MS) return 0;
  return Math.floor(elapsed / HOUR_MS);
}

/**
 * Points of this task's penalty already accrued (actually deducted)
 * for one assignee, from the accrual state the accrual pass maintains
 * on the task doc: penaltyAccrual[uid].applied. Zero when absent.
 */
export function accruedPenaltyFor(task: unknown, uid: string): number {
  if (task === null || typeof task !== 'object') return 0;
  const entry = (task as Record<string, any>)?.penaltyAccrual?.[uid];
  const applied = entry?.applied;
  return typeof applied === 'number' && Number.isFinite(applied) && applied > 0 ? applied : 0;
}

/**
 * The penalty still owed at completion for one assignee: the cap
 * minus what accrual already took, never negative. Accrual plus
 * completion can therefore never charge more than penaltyPoints in
 * total for a task.
 */
export function remainingPenaltyFor(task: unknown, uid: string, cap: number): number {
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  return Math.max(0, cap - accruedPenaltyFor(task, uid));
}
