/**
 * Named-Reviewer Resolution (Server-side)
 *
 * A task's named reviewer is the user designated at creation to verify
 * the work. Resolution reads ONLY the structured uid fields stamped
 * on the task doc:
 *
 *  - `reviewerId`  — the lead reviewer (single uid string), stamped by
 *    POST /api/tasks, by PATCH /api/tasks updates, and (workflow level
 *    + per-step) by POST /api/workflows.
 *  - `reviewerIds` — every designated reviewer (uid string array),
 *    lead included. The creation routes derive it from reviewerId;
 *    multi-reviewer stamps (e.g. a lead plus a co-reviewer) write it
 *    directly.
 *
 * Identity is keyed by uid only. Reviewer names written into a task
 * DESCRIPTION are display text for humans and the mission PDF; they
 * grant nothing and are never parsed here. Founder ruling 2026-10-28:
 * names on this platform are unreliable (duplicate accounts, case
 * variants, short forms), so identity is matched by email/uid, exactly
 * as the assignee pickers already do. A task carrying no reviewer
 * fields has no named reviewer, whatever its text says.
 */

export interface ReviewerTaskLike {
  reviewerId?: unknown;
  reviewerIds?: unknown;
}

/**
 * Resolve every uid designated as this task's reviewer: the deduped
 * union of the `reviewerId` field and the `reviewerIds` array, in
 * that order (lead first). Pure and synchronous: malformed values
 * (non-strings, blanks, non-array reviewerIds) are ignored, never
 * thrown on.
 */
export function resolveTaskReviewerUids(task: ReviewerTaskLike): string[] {
  const uids: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== 'string') return;
    const uid = value.trim();
    if (uid && !uids.includes(uid)) uids.push(uid);
  };
  if (!task || typeof task !== 'object') return uids;
  push(task.reviewerId);
  if (Array.isArray(task.reviewerIds)) {
    for (const value of task.reviewerIds) push(value);
  }
  return uids;
}
