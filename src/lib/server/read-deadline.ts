/**
 * read-deadline.ts — app-level deadlines for server-side Firestore
 * reads (perf program agent 1, 2026-10-30; the consent-picker cure
 * generalized).
 *
 * WHY: the app set NO deadline of its own on Firestore work, so the
 * GAPIC client defaults were the effective timeout — 60 s per RPC
 * attempt, 600 s total retry budget. When Firestore degrades (an
 * UNAVAILABLE / DEADLINE_EXCEEDED blip, a quota squeeze), a single
 * read retry-storms for tens of seconds. This app runs as ONE Node
 * process on a single free-tier instance, so one pinned request
 * queues every request behind it and the edge answers 502 for
 * unrelated traffic — proven live 2026-10-30, including static
 * assets 502ing behind pinned data reads (see
 * ~/workspace/known_issues/site_502_diagnosis_2026-10-30.md Q5,
 * mechanism 3; ~/workspace/known_issues/site_analytics_2026-10-30.md
 * cause class B).
 *
 * THE PATTERN (copied from the consent-picker fix, live since
 * ea823750: consent-lookup.ts withArmTimeout + its shared arm
 * budget): race the read against a hard timer; a timeout is a read
 * failure EXACTLY like a thrown error, so the caller's existing
 * error handling decides what happens next — a fallback arm, a
 * fail-closed default, a loud 503. Multi-step read paths share ONE
 * budget (createReadBudget) instead of stacking a fresh timeout per
 * step, the same shape as the picker's filed arm.
 *
 * CONTRACT: a deadline NEVER manufactures data. It only makes the
 * failure arrive in seconds instead of minutes; what a caller does
 * with a failed read (stale cache, defaults, 503) is the caller's
 * existing, documented choice. The losing read is not cancelled
 * (the Admin SDK exposes no per-call abort); it may settle later
 * and is deliberately swallowed by the race.
 */

/** Thrown when a read outlives its app-level deadline. */
export class ReadDeadlineError extends Error {
  readonly label: string;
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`firestore read "${label}" exceeded its app-level deadline of ${timeoutMs}ms`);
    this.name = 'ReadDeadlineError';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Single-document reads. The picker's proven per-arm value: warm
 * single-doc reads land at ~0.5–0.9 s and a cold process's first
 * call at ~4.4 s (consent picker root-cause measurements,
 * 2026-10-30), so 8 s is generous headroom over every legitimate
 * read while still failing 7x faster than one GAPIC RPC attempt.
 */
export const FIRESTORE_DOC_DEADLINE_MS = 8000;

/**
 * List / batch reads (bounded queries, getAll batches). Matches the
 * directory route's long-standing 10 s client-visible race
 * (api/admin/users/route.ts runWithTimeout).
 */
export const FIRESTORE_LIST_DEADLINE_MS = 10000;

/**
 * Total budget for the tasks list degradation ladder (tiers 1–3
 * share it): one tier's hang must not leave the next tier a fresh
 * timeout on top. 15 s bounds the whole ladder while leaving each
 * bounded tier ample room on a merely-slow day.
 */
export const TASKS_LIST_LADDER_BUDGET_MS = 15000;

/**
 * Race one read against a hard deadline. The wrapped error from the
 * read itself propagates untouched; only a read that outlives
 * `timeoutMs` produces a ReadDeadlineError.
 */
export async function withReadDeadline<T>(
  label: string,
  timeoutMs: number,
  run: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ReadDeadlineError(label, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ReadBudget {
  /** Milliseconds left before the shared deadline (0 when spent). */
  remainingMs(): number;
  /**
   * Run a read against whatever budget remains. When the budget is
   * already spent, throws ReadDeadlineError WITHOUT issuing the
   * read — a degraded path stops paying for reads it cannot use.
   */
  withBudget<T>(label: string, run: () => Promise<T>): Promise<T>;
}

/** One deadline shared by every step of a multi-read path. */
export function createReadBudget(totalMs: number): ReadBudget {
  const deadline = Date.now() + totalMs;
  const remainingMs = () => Math.max(0, deadline - Date.now());
  return {
    remainingMs,
    async withBudget<T>(label: string, run: () => Promise<T>): Promise<T> {
      const left = remainingMs();
      if (left <= 0) throw new ReadDeadlineError(label, totalMs);
      return withReadDeadline(label, left, run);
    },
  };
}
