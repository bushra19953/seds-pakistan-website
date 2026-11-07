/**
 * Client-side filter predicates for the admin Tasks page
 * (Role / Chapter / Type filters, added 2026-11-07).
 *
 * The page already filters by Status, Assignee and Project; these
 * predicates compose with them (every filter ANDs together) over the
 * task rows the page has loaded. Kept in a standalone module so the
 * matching rules are unit-testable without rendering the page.
 */

export type TaskTypeFilter =
  | 'all'
  | 'overdue'
  | 'due-today'
  | 'due-this-week'
  | 'standalone'
  | 'workflow-steps';

/** The subset of a task record the filters read. */
export interface FilterableTask {
  status?: string | null;
  deadline?: Date | string | number | null;
  individualDeadline?: Date | string | number | null;
  assigneeId?: string | null;
  assigneeIds?: string[] | null;
  chapterId?: unknown;
  workflowId?: string | null;
}

/** The subset of a user record the role filter reads. */
export interface RoleBearer {
  role?: string | null;
  additionalRoles?: string[] | null;
}

function toValidDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * The deadline that counts for a task: the per-step individual
 * deadline wins when present, else the task (parent) deadline.
 * Same precedence as the tasks table display.
 */
export function effectiveTaskDeadline(task: FilterableTask): Date | null {
  return toValidDate(task.individualDeadline) ?? toValidDate(task.deadline);
}

/** Every assignee id on the task: assigneeIds when non-empty, else the primary assigneeId. */
export function taskAssigneeIds(task: FilterableTask): string[] {
  if (Array.isArray(task.assigneeIds) && task.assigneeIds.length > 0) {
    return task.assigneeIds.map(String);
  }
  return task.assigneeId ? [String(task.assigneeId)] : [];
}

/**
 * Effective overdue: the stored status is 'overdue', OR the task is
 * still open (not completed, not submitted-for-review — a submission
 * freezes the deadline clock) and its effective deadline has passed.
 */
export function isTaskEffectivelyOverdue(task: FilterableTask, now: Date): boolean {
  const status = String(task.status || 'pending').toLowerCase();
  if (status === 'overdue') return true;
  if (status === 'completed' || status === 'submitted-for-review') return false;
  const eff = effectiveTaskDeadline(task);
  return eff !== null && eff.getTime() < now.getTime();
}

/** A task matches the role filter when ANY assignee holds the role, primary or additional. */
export function taskMatchesRole(
  task: FilterableTask,
  usersById: Readonly<Record<string, RoleBearer>>,
  roleKey: string
): boolean {
  if (!roleKey) return true;
  return taskAssigneeIds(task).some((uid) => {
    const user = usersById[uid];
    if (!user) return false;
    if (user.role && String(user.role) === roleKey) return true;
    return Array.isArray(user.additionalRoles) && user.additionalRoles.map(String).includes(roleKey);
  });
}

/** A task matches the chapter filter on its own stored chapterId. */
export function taskMatchesChapter(task: FilterableTask, chapterId: string): boolean {
  if (!chapterId || chapterId === 'all') return true;
  return typeof task.chapterId === 'string' && task.chapterId === chapterId;
}

function startOfLocalDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Match for the Type filter dropdown. 'all' matches everything. */
export function taskMatchesType(task: FilterableTask, type: TaskTypeFilter, now: Date): boolean {
  switch (type) {
    case 'all':
      return true;
    case 'overdue':
      return isTaskEffectivelyOverdue(task, now);
    case 'due-today': {
      const eff = effectiveTaskDeadline(task);
      return eff !== null && startOfLocalDay(eff).getTime() === startOfLocalDay(now).getTime();
    }
    case 'due-this-week': {
      const eff = effectiveTaskDeadline(task);
      if (eff === null) return false;
      const start = startOfLocalDay(now).getTime();
      const end = start + 7 * 24 * 60 * 60 * 1000; // through the end of the 7th day out
      return eff.getTime() >= start && eff.getTime() < end;
    }
    case 'standalone':
      return !task.workflowId;
    case 'workflow-steps':
      return !!task.workflowId;
    default:
      return true;
  }
}
