import {
  effectiveTaskDeadline,
  isTaskEffectivelyOverdue,
  taskMatchesChapter,
  taskMatchesRole,
  taskMatchesType,
  type FilterableTask,
  type RoleBearer,
} from '../task-filters';

const NOW = new Date('2026-11-07T18:00:00+05:00');
const PAST = new Date('2026-11-07T12:00:00+05:00');
const FUTURE = new Date('2026-11-09T18:00:00+05:00');
// Local-day-relative dates (the helper works in the viewer's local
// calendar days, so the day-boundary tests must too, in any timezone).
const localDay = (daysFromNow: number, h = 12, m = 0) =>
  new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + daysFromNow, h, m);

const users: Record<string, RoleBearer> = {
  u1: { role: 'chapter_vice_president', additionalRoles: [] },
  u2: { role: 'member_basic', additionalRoles: ['custom_marketing_deputy_social_media'] },
  u3: { role: 'member_basic', additionalRoles: [] },
};

describe('taskMatchesRole', () => {
  it('matches when an assignee holds the role as primary', () => {
    const task: FilterableTask = { assigneeIds: ['u3', 'u1'] };
    expect(taskMatchesRole(task, users, 'chapter_vice_president')).toBe(true);
  });

  it('matches when an assignee holds the role only in additionalRoles', () => {
    const task: FilterableTask = { assigneeIds: ['u2'] };
    expect(taskMatchesRole(task, users, 'custom_marketing_deputy_social_media')).toBe(true);
  });

  it('does not match when no assignee holds the role', () => {
    const task: FilterableTask = { assigneeIds: ['u2', 'u3'] };
    expect(taskMatchesRole(task, users, 'chapter_vice_president')).toBe(false);
  });

  it('falls back to assigneeId when assigneeIds is empty or absent', () => {
    expect(taskMatchesRole({ assigneeId: 'u1', assigneeIds: [] }, users, 'chapter_vice_president')).toBe(true);
    expect(taskMatchesRole({ assigneeId: 'u2' }, users, 'custom_marketing_deputy_social_media')).toBe(true);
  });

  it('does not match unknown assignees, and an empty role key matches everything', () => {
    expect(taskMatchesRole({ assigneeIds: ['nobody'] }, users, 'chapter_vice_president')).toBe(false);
    expect(taskMatchesRole({ assigneeIds: ['nobody'] }, users, '')).toBe(true);
  });
});

describe('taskMatchesChapter', () => {
  it('matches on the task record chapterId', () => {
    expect(taskMatchesChapter({ chapterId: 'seds-ist-chapter' }, 'seds-ist-chapter')).toBe(true);
    expect(taskMatchesChapter({ chapterId: 'seds-ist-chapter' }, 'other-chapter')).toBe(false);
  });

  it('does not match tasks with a missing or non-string chapterId', () => {
    expect(taskMatchesChapter({}, 'seds-ist-chapter')).toBe(false);
    expect(taskMatchesChapter({ chapterId: null }, 'seds-ist-chapter')).toBe(false);
    expect(taskMatchesChapter({ chapterId: { id: 'seds-ist-chapter' } as any }, 'seds-ist-chapter')).toBe(false);
  });

  it("'all' matches everything", () => {
    expect(taskMatchesChapter({}, 'all')).toBe(true);
    expect(taskMatchesChapter({ chapterId: 'x' }, 'all')).toBe(true);
  });
});

describe('effectiveTaskDeadline', () => {
  it('prefers individualDeadline over the parent deadline', () => {
    expect(effectiveTaskDeadline({ deadline: PAST, individualDeadline: FUTURE })?.getTime()).toBe(FUTURE.getTime());
    expect(effectiveTaskDeadline({ deadline: FUTURE, individualDeadline: PAST })?.getTime()).toBe(PAST.getTime());
  });

  it('falls back to deadline and accepts string dates; invalid values give null', () => {
    expect(effectiveTaskDeadline({ deadline: PAST })?.getTime()).toBe(PAST.getTime());
    expect(effectiveTaskDeadline({ deadline: '2026-11-09T18:00:00+05:00' })?.getTime()).toBe(FUTURE.getTime());
    expect(effectiveTaskDeadline({ deadline: 'not-a-date' })).toBeNull();
    expect(effectiveTaskDeadline({})).toBeNull();
  });
});

describe('isTaskEffectivelyOverdue', () => {
  it('stored overdue status counts even with a future deadline', () => {
    expect(isTaskEffectivelyOverdue({ status: 'overdue', deadline: FUTURE }, NOW)).toBe(true);
  });

  it('open tasks past their effective deadline are overdue', () => {
    expect(isTaskEffectivelyOverdue({ status: 'pending', deadline: PAST }, NOW)).toBe(true);
    expect(isTaskEffectivelyOverdue({ status: 'in-progress', deadline: PAST }, NOW)).toBe(true);
    expect(isTaskEffectivelyOverdue({ status: 'pending', deadline: FUTURE }, NOW)).toBe(false);
  });

  it('submitted-for-review is exempt: its clock is frozen even past the deadline', () => {
    expect(isTaskEffectivelyOverdue({ status: 'submitted-for-review', deadline: PAST }, NOW)).toBe(false);
  });

  it('completed tasks are never overdue', () => {
    expect(isTaskEffectivelyOverdue({ status: 'completed', deadline: PAST }, NOW)).toBe(false);
  });

  it('individualDeadline takes precedence over the parent deadline both ways', () => {
    // Parent deadline passed but the step's own deadline is ahead: not overdue.
    expect(isTaskEffectivelyOverdue({ status: 'pending', deadline: PAST, individualDeadline: FUTURE }, NOW)).toBe(false);
    // Parent deadline ahead but the step's own deadline passed: overdue.
    expect(isTaskEffectivelyOverdue({ status: 'pending', deadline: FUTURE, individualDeadline: PAST }, NOW)).toBe(true);
  });

  it('a task with no deadline is not overdue', () => {
    expect(isTaskEffectivelyOverdue({ status: 'pending' }, NOW)).toBe(false);
  });
});

describe('taskMatchesType', () => {
  it('overdue delegates to the effective-overdue rule', () => {
    expect(taskMatchesType({ status: 'pending', deadline: PAST }, 'overdue', NOW)).toBe(true);
    expect(taskMatchesType({ status: 'submitted-for-review', deadline: PAST }, 'overdue', NOW)).toBe(false);
  });

  it('due-today matches only deadlines on the same local day', () => {
    expect(taskMatchesType({ status: 'pending', deadline: localDay(0, 23, 59) }, 'due-today', NOW)).toBe(true);
    expect(taskMatchesType({ status: 'pending', deadline: localDay(1, 0, 30) }, 'due-today', NOW)).toBe(false);
    expect(taskMatchesType({ status: 'pending', deadline: localDay(0, 1, 0) }, 'due-today', NOW)).toBe(true); // earlier today still counts
    expect(taskMatchesType({ status: 'pending', deadline: localDay(-1, 23, 0) }, 'due-today', NOW)).toBe(false);
  });

  it('due-this-week covers today through the next 7 days, not beyond, not the past', () => {
    expect(taskMatchesType({ status: 'pending', deadline: localDay(6, 23, 59) }, 'due-this-week', NOW)).toBe(true);
    expect(taskMatchesType({ status: 'pending', deadline: localDay(8, 12, 0) }, 'due-this-week', NOW)).toBe(false);
    expect(taskMatchesType({ status: 'pending', deadline: localDay(-1, 12, 0) }, 'due-this-week', NOW)).toBe(false);
    expect(taskMatchesType({ status: 'pending' }, 'due-this-week', NOW)).toBe(false);
  });

  it('standalone vs workflow steps split on workflowId', () => {
    expect(taskMatchesType({ status: 'pending' }, 'standalone', NOW)).toBe(true);
    expect(taskMatchesType({ status: 'pending', workflowId: 'wf_1' }, 'standalone', NOW)).toBe(false);
    expect(taskMatchesType({ status: 'pending', workflowId: 'wf_1' }, 'workflow-steps', NOW)).toBe(true);
    expect(taskMatchesType({ status: 'pending', workflowId: null }, 'workflow-steps', NOW)).toBe(false);
  });

  it("'all' matches everything", () => {
    expect(taskMatchesType({ status: 'pending', deadline: PAST }, 'all', NOW)).toBe(true);
  });
});
