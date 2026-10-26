/**
 * deadline-fairness.ts
 *
 * Founder rule (2026-10-26): the deadline clock belongs to the assignee
 * only while the work is in the assignee's hands.
 *
 *   1. While a task/step sits in 'submitted-for-review', the deadline
 *      must not count against the assignee: no overdue stamp, no
 *      overdue display, no late penalty accrues for time spent waiting
 *      on the reviewer.
 *   2. Lateness is judged on the SUBMISSION instant (the task's
 *      server-stamped `submittedAt`), never on the approval instant.
 *      A reviewer who decides after the deadline does not make an
 *      on-time submission late.
 *   3. A rejection / request-revisions must carry a NEW deadline set
 *      by the reviewer; from then on the assignee is judged against
 *      that new deadline (enforced in the review APIs, which write the
 *      reviewer's date into the task's effective deadline field).
 *
 * Pure helpers, no imports with side effects, so the server
 * (gamification transaction, tasks API, team API) and the client
 * (profile mission surfaces) share one implementation and cannot
 * drift apart. Same pattern as src/lib/server/bug4-proof-guards.ts.
 *
 * No em dashes anywhere in this file; user-facing text follows the
 * house rule.
 */

/**
 * Normalize any stored task time value (Firestore Timestamp, a
 * { seconds } / { toMillis } / { toDate } shape, a JS Date, an ISO
 * string, or epoch millis) to epoch millis. Returns null when the
 * value carries no usable time.
 */
export function taskTimeToMs(value: unknown): number | null {
  if (value == null) return null;
  try {
    if (typeof (value as { toMillis?: unknown }).toMillis === 'function') {
      const ms = (value as { toMillis: () => number }).toMillis();
      return Number.isFinite(ms) ? ms : null;
    }
    if (typeof (value as { toDate?: unknown }).toDate === 'function') {
      const ms = (value as { toDate: () => Date }).toDate().getTime();
      return Number.isFinite(ms) ? ms : null;
    }
    if (value instanceof Date) {
      const ms = value.getTime();
      return Number.isFinite(ms) ? ms : null;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return null;
      // Tolerate epoch seconds vs millis, matching the overdue cron.
      return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === 'string') {
      const ms = new Date(value).getTime();
      return Number.isNaN(ms) ? null : ms;
    }
    if (typeof value === 'object') {
      const seconds = (value as { seconds?: unknown }).seconds;
      if (typeof seconds === 'number' && Number.isFinite(seconds)) {
        return seconds * 1000;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The task's effective deadline in epoch millis: workflow steps carry
 * `individualDeadline` (the more specific field, the same preference
 * the gamification transaction and the overdue cron use); plain tasks
 * carry `deadline`. Null when no usable deadline is stored.
 */
export function effectiveDeadlineMs(task: unknown): number | null {
  if (task === null || typeof task !== 'object') return null;
  const t = task as Record<string, unknown>;
  return taskTimeToMs(t.individualDeadline) ?? taskTimeToMs(t.deadline);
}

/**
 * Statuses whose tasks never display or count as overdue: terminal
 * states (canonical 'completed' plus the legacy 'approved' spelling
 * readers still honor) and 'submitted-for-review' (founder rule 1:
 * while a submission waits on the reviewer, the deadline is not
 * running against the assignee).
 */
export function statusExemptsOverdue(status: unknown): boolean {
  const s = typeof status === 'string' ? status.toLowerCase().trim() : '';
  return s === 'completed' || s === 'approved' || s === 'submitted-for-review';
}

/**
 * Display/API derivation: is this task overdue right now? A task with
 * an exempt status, or no usable deadline, is never overdue. Every
 * other incomplete task whose effective deadline has passed is.
 */
export function countsAsOverdue(task: unknown, nowMs: number): boolean {
  if (task === null || typeof task !== 'object') return false;
  if (statusExemptsOverdue((task as Record<string, unknown>).status)) return false;
  const deadlineMs = effectiveDeadlineMs(task);
  return deadlineMs !== null && deadlineMs < nowMs;
}

/**
 * The lateness judgment for a completion (founder rule 2).
 *
 * `judgedAtMs` is the submission instant when the task carries a
 * server-stamped `submittedAt` (source: 'submittedAt'); otherwise it
 * is the completion instant supplied by the caller (source:
 * 'completion'), which preserves the historic behavior for direct
 * completions that never passed through review. `isLate` compares
 * the judged instant against the effective deadline; a task with no
 * usable deadline is never late.
 */
export function judgeCompletionLateness(
  task: unknown,
  completionMs: number
): { judgedAtMs: number; judgedOn: 'submittedAt' | 'completion'; isLate: boolean } {
  const submittedMs = task !== null && typeof task === 'object'
    ? taskTimeToMs((task as Record<string, unknown>).submittedAt)
    : null;
  const judgedAtMs = submittedMs ?? completionMs;
  const judgedOn: 'submittedAt' | 'completion' = submittedMs !== null ? 'submittedAt' : 'completion';
  const deadlineMs = effectiveDeadlineMs(task);
  return {
    judgedAtMs,
    judgedOn,
    isLate: deadlineMs !== null && judgedAtMs > deadlineMs,
  };
}
