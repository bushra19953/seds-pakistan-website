/**
 * Bug 4 guards: "overdue despite proof uploaded".
 *
 * A task with a non-empty `deliverableFiles` array has proof attached and is
 * awaiting review, not missing work. These pure helpers pin that rule in one
 * place so the crons and the upload endpoint cannot drift apart:
 *
 *  - /api/cron/overdue must not stamp proof-bearing tasks as overdue.
 *  - /api/cron/check-deadlines must not warn, penalize, or stamp
 *    proof-bearing tasks.
 *  - /api/tasks/attach-upload may move a task to submitted-for-review only
 *    under the conservative conditions below.
 *
 * No em dashes anywhere in this file; user-facing text follows the house rule.
 */

export interface ProofDocLike {
  id: string;
  data: () => Record<string, unknown>;
}

/**
 * True when the task data carries at least one attached proof file.
 * A non-empty deliverableFiles array means the assignee already submitted
 * proof; the task is awaiting review, not missing work.
 */
export function taskHasProofUploaded(data: unknown): boolean {
  if (data === null || typeof data !== 'object') return false;
  const files = (data as Record<string, unknown>).deliverableFiles;
  return Array.isArray(files) && files.length > 0;
}

/**
 * Normalize every stored deadline shape (Firestore Timestamp, Date, ISO
 * string, epoch millis) to epoch millis. Returns 0 when there is no
 * usable deadline.
 */
export function deadlineMsOf(taskData: unknown): number {
  if (taskData === null || typeof taskData !== 'object') return 0;
  const raw = (taskData as Record<string, unknown>).individualDeadline ??
    (taskData as Record<string, unknown>).deadline;
  if (raw == null || raw === '') return 0;
  if (typeof (raw as { toMillis?: unknown }).toMillis === 'function') {
    return (raw as { toMillis: () => number }).toMillis();
  }
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === 'string' || typeof raw === 'number') {
    const d = new Date(raw);
    const ms = d.getTime();
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
}

/**
 * Conservative auto-transition rule for the attach-upload endpoint.
 * Returns true only when ALL of these hold:
 *   - status is exactly 'pending' or 'in-progress'
 *     (never completed, approved, overdue, submitted-for-review,
 *      changes-requested, or anything else)
 *   - the deadline has not passed (a task with no usable deadline is not
 *     overdue-bound, so it may transition)
 *   - a non-empty report is already stored on the task (the upload-after-
 *     report case)
 * Post-deadline uploads and uploads without a report return false and are
 * left for manual or admin action. The guard is idempotent: once the status
 * leaves pending/in-progress it never re-enters, so repeat uploads change
 * nothing.
 */
export function shouldAutoTransitionOnProofUpload(
  taskData: unknown,
  nowMs: number = Date.now()
): boolean {
  if (taskData === null || typeof taskData !== 'object') return false;
  const task = taskData as Record<string, unknown>;
  const status = typeof task.status === 'string' ? task.status : '';
  if (status !== 'pending' && status !== 'in-progress') return false;
  const deadlineMs = deadlineMsOf(task);
  if (deadlineMs > 0 && deadlineMs < nowMs) return false;
  const report = typeof task.report === 'string' ? task.report : '';
  return report.trim().length > 0;
}

/**
 * Split fetched overdue-candidate docs into proof-bearing (must be skipped
 * before any warning/penalty/stamp logic) and the rest.
 */
export function splitProofSkippedDocs<TDoc extends ProofDocLike>(docs: TDoc[]): {
  withProof: TDoc[];
  withoutProof: TDoc[];
} {
  const withProof: TDoc[] = [];
  const withoutProof: TDoc[] = [];
  for (const doc of docs) {
    if (taskHasProofUploaded(doc.data())) withProof.push(doc);
    else withoutProof.push(doc);
  }
  return { withProof, withoutProof };
}
