/**
 * Canonical workflow-progress semantics (SEDS Pakistan).
 * A step counts toward mission progress when the assignee's work is DONE:
 *  - 'completed'            (admin-approved, the one canonical spelling)
 *  - 'approved'             (LEGACY terminal spelling stamped by older
 *                            approval paths; honored by every reader until
 *                            stored data is unified. Writers must never
 *                            stamp it again.)
 *  - 'submitted-for-review' (work submitted, awaiting verification)
 * A mission is fully complete only when EVERY step is admin-approved.
 */
export function isStepWorkDone(status: string | null | undefined): boolean {
  return status === 'completed' || status === 'approved' || status === 'submitted-for-review';
}

export function isStepApproved(status: string | null | undefined): boolean {
  return status === 'completed' || status === 'approved';
}

/**
 * Terminal task statuses: the canonical 'completed' plus the legacy
 * 'approved' spelling found on older docs. A task in either state is
 * finished work: it must drain from active lists (team lists, boards)
 * and count as complete in every rollup.
 */
export function isTerminalTaskStatus(status: string | null | undefined): boolean {
  return status === 'completed' || status === 'approved';
}

export interface WorkflowProgress {
  totalSteps: number;
  /** steps with work done (completed OR submitted-for-review) */
  completedSteps: number;
  /** steps admin-approved */
  approvedSteps: number;
  progressPercentage: number;
  /** true only when every step is admin-approved */
  isCompleted: boolean;
}

export function computeWorkflowProgress(statuses: Array<string | null | undefined>): WorkflowProgress {
  const totalSteps = statuses.length;
  const completedSteps = statuses.filter(isStepWorkDone).length;
  const approvedSteps = statuses.filter(isStepApproved).length;
  const progressPercentage = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
  const isCompleted = totalSteps > 0 && approvedSteps === totalSteps;
  return { totalSteps, completedSteps, approvedSteps, progressPercentage, isCompleted };
}
