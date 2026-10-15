/**
 * Slice 17: Tests for cron + gamification leave exemption.
 *
 * Contract tests for the leave exemption specified in the adaptation guide
 * (Steps 4 and 5): an approved leave covering a task deadline means no
 * warning, no points deduction, no blacklist count, and no
 * overdueProcessed stamp for that assignee; the gamification transaction
 * awards full points with penaltyToApply 0 and no late count increment.
 *
 * IMPORTANT: these tests are SELF CONTAINED and import nothing from the
 * repo. That is deliberate, not an oversight:
 *
 * 1. The shared helper `src/lib/server/leave-exemption.ts` does NOT exist
 *    yet (verified: no file, no import, no `leave_exempt` reference
 *    anywhere under src/ at the time these tests were written). There is
 *    nothing to import.
 * 2. The cron handler (`src/app/api/cron/check-deadlines/route.ts`) has
 *    zero leave references today, and its current code stamps the whole
 *    task `overdueProcessed: true` BEFORE the per-assignee loop, so a
 *    full-handler test against the CURRENT handler would fail by design.
 *    Mocking the whole handler (firebase-admin, NextResponse,
 *    notificationService, verifyAuthentication) to test a code path that
 *    does not exist yet would test the mock, not the code.
 *
 * What this file does instead: it contains CONTRACT COPIES of the two
 * pieces the implementation must provide, copied from the guide spec and
 * from the current code they will plug into:
 *
 * - `isExemptFromDeadlinePenalty` mirrors the guide Step 4 rule. When
 *   `src/lib/server/leave-exemption.ts` lands, delete the local copy here
 *   and import the real helper. Every test in Section 1 must then pass
 *   unchanged. If any test fails against the real helper, the helper
 *   does not match the spec, not the test.
 * - `computeAwardWithLeave` mirrors the penalty math in
 *   `src/lib/server/gamification-transaction.ts` (isLate, penaltyToApply,
 *   finalPoints, tasksCompletedLateCount, ledger entry) plus the Step 5
 *   exemption. When Step 5 lands, the same swap applies.
 * - `simulateCronRun` mirrors the INTENDED post-fix cron loop: per
 *   assignee exemption check before any warning or penalty write, and
 *   the overdueProcessed stamp only after the loop, conditional on the
 *   per-assignee outcome. It is the executable form of the Step 4 spec.
 *   It is NOT a test of the current handler.
 *
 * GAPS this file does NOT cover (see NOTES.md):
 * - No end to end test runs the real cron POST handler.
 * - No end to end test runs the real executeGamificationTransaction with
 *   a leave-exempt user, because the transaction has no leave check yet.
 * - No Firestore rules test, no double-penalty (cron plus approval)
 *   test, no refund behavior test. Refunds are explicitly out of scope:
 *   a cron penalty issued BEFORE the leave was approved is NOT
 *   auto-refunded by Step 4 or Step 5.
 *
 * No em dashes anywhere in this file, including test names.
 */

type DateLike =
  | Date
  | string
  | number
  | { toMillis: () => number }
  | { toDate: () => Date }
  | null
  | undefined;

type UserData = {
  isOnVacation?: boolean;
  vacationMode?: boolean;
  vacationStartDate?: DateLike;
  vacationEndDate?: DateLike;
  leaveRequestId?: string | null;
};

type TaskData = {
  deadline?: DateLike;
  individualDeadline?: DateLike;
  leaveHold?: boolean;
  leaveHoldReason?: string;
  redirectedLeaveRequestId?: string | null;
};

/* ------------------------------------------------------------------ */
/* Section 1: exemption decision. CONTRACT COPY of the Step 4 rule.  */
/* Delete this copy and import the real helper when it lands.         */
/* ------------------------------------------------------------------ */

function toMs(value: DateLike): number {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return new Date(value).getTime();
  if (typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    return (value as { toMillis: () => number }).toMillis();
  }
  if (typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().getTime();
  }
  return NaN;
}

function isExemptFromDeadlinePenalty(
  userData: UserData,
  taskData: TaskData
): { exempt: boolean; reason: string; leaveRequestId?: string } {
  const leaveRequestId =
    userData.leaveRequestId || taskData.redirectedLeaveRequestId || undefined;

  // Coordinator correction: Step 3 (auto-redirect / leaveHold) was
  // skipped for v1. leaveHold is NOT an exemption signal: the helper
  // ignores it entirely. Only the approved leave window exempts.

  // Both flag spellings count as one flag. The guide requires both to
  // be set on approve and both cleared on return; the check must accept
  // either so a half-set legacy state cannot penalize a member on leave.
  const onLeave = userData.isOnVacation === true || userData.vacationMode === true;
  if (!onLeave) {
    return { exempt: false, reason: 'user is not on approved leave', leaveRequestId };
  }

  // The deadline that matters is the workflow step deadline when one
  // exists, otherwise the task deadline. This matches the cron and the
  // gamification transaction, which both prefer individualDeadline.
  const deadlineMs = toMs(taskData.individualDeadline ?? taskData.deadline);
  if (!Number.isFinite(deadlineMs)) {
    return { exempt: false, reason: 'task has no usable deadline', leaveRequestId };
  }

  const startMs = toMs(userData.vacationStartDate);
  const endMs = toMs(userData.vacationEndDate);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return {
      exempt: false,
      reason: 'on leave but no approved leave window on the user record',
      leaveRequestId,
    };
  }

  // Window check is INCLUSIVE on both ends. A deadline exactly on the
  // start or end date falls inside the approved leave.
  if (deadlineMs >= startMs && deadlineMs <= endMs) {
    return {
      exempt: true,
      reason:
        'on approved leave' +
        (leaveRequestId ? ` (leaveRequestId ${leaveRequestId})` : '') +
        ', deadline inside leave window; not marked processed so a later run can process it after return',
      leaveRequestId,
    };
  }
  return {
    exempt: false,
    reason: 'on leave but deadline is outside the approved leave window',
    leaveRequestId,
  };
}

/* ------------------------------------------------------------------ */
/* Section 2: gamification penalty math. CONTRACT COPY of the Step 5  */
/* rule layered on the current transaction math. Delete the copy and   */
/* test through the real transaction when Step 5 lands.               */
/* ------------------------------------------------------------------ */

type AwardInput = {
  effectivePoints: number;
  penaltyPoints: number;
  isLate: boolean;
  exempt: boolean;
  leaveRequestId?: string;
};

function computeAwardWithLeave(input: AwardInput) {
  // Current transaction math (gamification-transaction.ts):
  //   penaltyToApply = isLate && penaltyPoints > 0 ? penaltyPoints : 0
  //   finalPoints = max(0, effectivePoints - penaltyToApply)
  // Step 5 adds the exemption first: exempt means penalty 0 AND no late
  // count increment AND completed_late false in the ledger.
  const penaltyToApply =
    input.exempt ? 0 : input.isLate && input.penaltyPoints > 0 ? input.penaltyPoints : 0;
  const finalPoints = Math.max(0, input.effectivePoints - penaltyToApply);
  const completedLate = input.isLate && !input.exempt;
  const lateCountDelta = completedLate ? 1 : 0;
  const ledger = {
    points_awarded: finalPoints,
    points_before_penalty: input.effectivePoints,
    penalty_applied: penaltyToApply,
    completed_late: completedLate,
    leave_exempt: input.exempt,
    ...(input.exempt && input.leaveRequestId
      ? { leaveRequestId: input.leaveRequestId }
      : {}),
  };
  return { finalPoints, penaltyToApply, completedLate, lateCountDelta, ledger };
}

/* ------------------------------------------------------------------ */
/* Section 3: cron per-assignee loop. CONTRACT COPY of the INTENDED   */
/* post-fix cron behavior (Step 4). Not a test of the current handler, */
/* which stamps overdueProcessed before the loop and has no leave      */
/* check.                                                              */
/* ------------------------------------------------------------------ */

type SimUser = {
  points: number;
  warningCount: number;
  warnings: Array<{ taskId: string; reason: string }>;
  userData: UserData;
};

type SimTask = TaskData & {
  id: string;
  title: string;
  assigneeIds: string[];
  status: string;
  overdueProcessed?: boolean;
  processedAssigneeIds?: string[];
};

type CronResult = {
  warningsIssued: number;
  pointsAudit: Array<{ userId: string; delta: number; taskId: string }>;
  skippedDetails: Array<{
    taskId: string;
    title: string;
    assigneeId?: string;
    reason: string;
  }>;
};

function simulateCronRun(
  tasks: SimTask[],
  users: Record<string, SimUser>,
  penaltyPoints: number
): CronResult {
  const result: CronResult = { warningsIssued: 0, pointsAudit: [], skippedDetails: [] };
  for (const task of tasks) {
    if (task.overdueProcessed === true) continue;
    if (task.assigneeIds.length === 0) {
      task.overdueProcessed = false;
      result.skippedDetails.push({
        taskId: task.id,
        title: task.title,
        reason:
          'no assignees assigned; no one to warn. Not marked processed so a retry can pick it up if assignees are added later.',
      });
      continue;
    }
    // Coordinator correction: the shipped handler stamps
    // overdueProcessed AFTER the loop when AT LEAST ONE assignee was
    // actually processed (not only when every assignee was). A mixed
    // task is stamped once a non-exempt assignee is processed; the
    // exempt assignee in that task is NOT revisited later (known v1
    // limitation). No per-assignee marker is persisted.
    const processed: string[] = [...(task.processedAssigneeIds ?? [])];
    let processedThisRun = 0;
    for (const assigneeId of task.assigneeIds) {
      if (processed.includes(assigneeId)) continue;
      const user = users[assigneeId];
      if (!user) {
        result.skippedDetails.push({
          taskId: task.id,
          title: task.title,
          assigneeId,
          reason: 'user record not found; cannot issue warning or penalty.',
        });
        continue;
      }
      const decision = isExemptFromDeadlinePenalty(user.userData, task);
      if (decision.exempt) {
        result.skippedDetails.push({
          taskId: task.id,
          title: task.title,
          assigneeId,
          reason: decision.reason,
        });
        continue;
      }
      user.warnings.push({
        taskId: task.id,
        reason: `Missed deadline for task: ${task.title}`,
      });
      user.warningCount += 1;
      user.points -= penaltyPoints;
      result.pointsAudit.push({ userId: assigneeId, delta: -penaltyPoints, taskId: task.id });
      result.warningsIssued += 1;
      processed.push(assigneeId);
      processedThisRun += 1;
    }
    task.processedAssigneeIds = processed;
    // Whole-task stamp when at least one assignee was actually processed
    // this run. An all-exempt task stays unstamped and is revisited.
    // A mixed task IS stamped, so its exempt assignee is not revisited.
    task.overdueProcessed = processedThisRun > 0;
    if (processedThisRun > 0) task.status = 'overdue';
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Shared fixtures                                                     */
/* ------------------------------------------------------------------ */

const LEAVE_START = new Date('2026-10-10T00:00:00Z');
const LEAVE_END = new Date('2026-10-16T23:59:59Z');
const DEADLINE_INSIDE = new Date('2026-10-13T12:00:00Z');
const DEADLINE_BEFORE = new Date('2026-10-05T12:00:00Z');
const DEADLINE_AFTER = new Date('2026-10-20T12:00:00Z');

function onLeaveUser(overrides: Partial<UserData> = {}): UserData {
  return {
    isOnVacation: true,
    vacationMode: true,
    vacationStartDate: LEAVE_START,
    vacationEndDate: LEAVE_END,
    leaveRequestId: 'leave-req-1',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Section 1 tests: exemption decision                                */
/* ------------------------------------------------------------------ */

describe('isExemptFromDeadlinePenalty', () => {
  test('deadline inside window with flag on is exempt', () => {
    const result = isExemptFromDeadlinePenalty(onLeaveUser(), { deadline: DEADLINE_INSIDE });
    expect(result.exempt).toBe(true);
    expect(result.leaveRequestId).toBe('leave-req-1');
  });

  test('deadline exactly on the leave start date is exempt, window is inclusive', () => {
    const result = isExemptFromDeadlinePenalty(onLeaveUser(), { deadline: LEAVE_START });
    expect(result.exempt).toBe(true);
  });

  test('deadline exactly on the leave end date is exempt, window is inclusive', () => {
    const result = isExemptFromDeadlinePenalty(onLeaveUser(), { deadline: LEAVE_END });
    expect(result.exempt).toBe(true);
  });

  test('deadline before the window is not exempt', () => {
    const result = isExemptFromDeadlinePenalty(onLeaveUser(), { deadline: DEADLINE_BEFORE });
    expect(result.exempt).toBe(false);
    expect(result.reason).toMatch(/outside.*leave window/);
  });

  test('deadline after the window is not exempt', () => {
    const result = isExemptFromDeadlinePenalty(onLeaveUser(), { deadline: DEADLINE_AFTER });
    expect(result.exempt).toBe(false);
  });

  test('flag off with deadline inside the window is not exempt', () => {
    const result = isExemptFromDeadlinePenalty(
      { vacationStartDate: LEAVE_START, vacationEndDate: LEAVE_END },
      { deadline: DEADLINE_INSIDE }
    );
    expect(result.exempt).toBe(false);
  });

  test('vacationMode twin flag alone counts as on leave', () => {
    const result = isExemptFromDeadlinePenalty(
      {
        vacationMode: true,
        vacationStartDate: LEAVE_START,
        vacationEndDate: LEAVE_END,
        leaveRequestId: 'leave-req-1',
      },
      { deadline: DEADLINE_INSIDE }
    );
    expect(result.exempt).toBe(true);
  });

  test('individualDeadline inside the window exempts even when task deadline is outside', () => {
    const result = isExemptFromDeadlinePenalty(onLeaveUser(), {
      deadline: DEADLINE_AFTER,
      individualDeadline: DEADLINE_INSIDE,
    });
    expect(result.exempt).toBe(true);
  });

  test('individualDeadline outside the window does not exempt even when task deadline is inside', () => {
    const result = isExemptFromDeadlinePenalty(onLeaveUser(), {
      deadline: DEADLINE_INSIDE,
      individualDeadline: DEADLINE_AFTER,
    });
    expect(result.exempt).toBe(false);
  });

  test('leaveHold does NOT exempt when the flag is off (Step 3 skipped, leaveHold is not an exemption signal)', () => {
    const result = isExemptFromDeadlinePenalty(
      { isOnVacation: false },
      {
        deadline: DEADLINE_INSIDE,
        leaveHold: true,
        leaveHoldReason: 'no-covering-officer',
        redirectedLeaveRequestId: 'leave-req-1',
      }
    );
    expect(result.exempt).toBe(false);
  });

  test('leaveHold with no leave evidence does not exempt', () => {
    const result = isExemptFromDeadlinePenalty(
      { isOnVacation: false },
      { deadline: DEADLINE_INSIDE, leaveHold: true }
    );
    expect(result.exempt).toBe(false);
  });

  test('flag on but no leave window on the user record does not exempt', () => {
    const result = isExemptFromDeadlinePenalty(
      { isOnVacation: true, leaveRequestId: 'leave-req-1' },
      { deadline: DEADLINE_INSIDE }
    );
    expect(result.exempt).toBe(false);
  });

  test('task with no deadline does not exempt', () => {
    const result = isExemptFromDeadlinePenalty(onLeaveUser(), {});
    expect(result.exempt).toBe(false);
  });

  test('exempt reason names leave and carries the leave request id', () => {
    const result = isExemptFromDeadlinePenalty(onLeaveUser(), { deadline: DEADLINE_INSIDE });
    expect(result.reason).toMatch(/leave/i);
    expect(result.reason).toContain('leave-req-1');
    expect(result.reason).toMatch(/not marked processed/);
  });

  test('covering officer who received the redirected task is not exempt, decision is not applicable to them', () => {
    const coveringOfficer: UserData = { isOnVacation: false };
    const result = isExemptFromDeadlinePenalty(coveringOfficer, { deadline: DEADLINE_INSIDE });
    expect(result.exempt).toBe(false);
  });

  test('string and Firestore-like timestamp dates parse the same as Date objects', () => {
    const stringForm = isExemptFromDeadlinePenalty(
      {
        isOnVacation: true,
        vacationStartDate: LEAVE_START.toISOString(),
        vacationEndDate: LEAVE_END.toISOString(),
      },
      { deadline: DEADLINE_INSIDE.toISOString() }
    );
    expect(stringForm.exempt).toBe(true);
    const timestampForm = isExemptFromDeadlinePenalty(
      {
        isOnVacation: true,
        vacationStartDate: { toMillis: () => LEAVE_START.getTime() },
        vacationEndDate: { toMillis: () => LEAVE_END.getTime() },
      },
      { deadline: { toMillis: () => DEADLINE_INSIDE.getTime() } }
    );
    expect(timestampForm.exempt).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Section 2 tests: gamification penalty math                         */
/* ------------------------------------------------------------------ */

describe('gamification late penalty with leave exemption', () => {
  test('exempt late completion awards full points, finalPoints equals effectivePoints', () => {
    const result = computeAwardWithLeave({
      effectivePoints: 10,
      penaltyPoints: 5,
      isLate: true,
      exempt: true,
      leaveRequestId: 'leave-req-1',
    });
    expect(result.finalPoints).toBe(10);
  });

  test('exempt late completion applies zero penalty', () => {
    const result = computeAwardWithLeave({
      effectivePoints: 10,
      penaltyPoints: 5,
      isLate: true,
      exempt: true,
      leaveRequestId: 'leave-req-1',
    });
    expect(result.penaltyToApply).toBe(0);
  });

  test('exempt late completion leaves tasksCompletedLateCount unchanged', () => {
    const result = computeAwardWithLeave({
      effectivePoints: 10,
      penaltyPoints: 5,
      isLate: true,
      exempt: true,
      leaveRequestId: 'leave-req-1',
    });
    expect(result.lateCountDelta).toBe(0);
    expect(result.completedLate).toBe(false);
  });

  test('exempt late completion ledger entry carries leave_exempt true and the request id', () => {
    const result = computeAwardWithLeave({
      effectivePoints: 10,
      penaltyPoints: 5,
      isLate: true,
      exempt: true,
      leaveRequestId: 'leave-req-1',
    });
    expect(result.ledger.leave_exempt).toBe(true);
    expect(result.ledger.leaveRequestId).toBe('leave-req-1');
    expect(result.ledger.penalty_applied).toBe(0);
    expect(result.ledger.completed_late).toBe(false);
  });

  test('non-exempt late completion applies the penalty normally', () => {
    const result = computeAwardWithLeave({
      effectivePoints: 10,
      penaltyPoints: 5,
      isLate: true,
      exempt: false,
    });
    expect(result.penaltyToApply).toBe(5);
    expect(result.finalPoints).toBe(5);
    expect(result.lateCountDelta).toBe(1);
    expect(result.completedLate).toBe(true);
    expect(result.ledger.leave_exempt).toBe(false);
    expect(result.ledger.penalty_applied).toBe(5);
  });

  test('on-time completion applies no penalty with or without leave', () => {
    const onLeave = computeAwardWithLeave({
      effectivePoints: 10,
      penaltyPoints: 5,
      isLate: false,
      exempt: true,
      leaveRequestId: 'leave-req-1',
    });
    expect(onLeave.penaltyToApply).toBe(0);
    expect(onLeave.finalPoints).toBe(10);
    expect(onLeave.lateCountDelta).toBe(0);
    const normal = computeAwardWithLeave({
      effectivePoints: 10,
      penaltyPoints: 5,
      isLate: false,
      exempt: false,
    });
    expect(normal.penaltyToApply).toBe(0);
    expect(normal.finalPoints).toBe(10);
  });

  test('non-exempt penalty larger than the award floors finalPoints at zero', () => {
    const result = computeAwardWithLeave({
      effectivePoints: 3,
      penaltyPoints: 5,
      isLate: true,
      exempt: false,
    });
    expect(result.finalPoints).toBe(0);
    expect(result.penaltyToApply).toBe(5);
  });

  test('exempt delegatee path uses the same math, full shared points and zero penalty', () => {
    const result = computeAwardWithLeave({
      effectivePoints: 4,
      penaltyPoints: 5,
      isLate: true,
      exempt: true,
      leaveRequestId: 'leave-req-1',
    });
    expect(result.finalPoints).toBe(4);
    expect(result.penaltyToApply).toBe(0);
    expect(result.ledger.leave_exempt).toBe(true);
  });

  test('non-exempt delegatee path applies the penalty normally', () => {
    const result = computeAwardWithLeave({
      effectivePoints: 4,
      penaltyPoints: 5,
      isLate: true,
      exempt: false,
    });
    expect(result.finalPoints).toBe(0);
    expect(result.penaltyToApply).toBe(5);
  });
});

/* ------------------------------------------------------------------ */
/* Section 3 tests: cron per-assignee loop                            */
/* ------------------------------------------------------------------ */

describe('cron check-deadlines with leave exemption', () => {
  test('sole assignee on approved leave with deadline inside window: no warning, no points change, no overdueProcessed stamp, skippedDetails entry naming leave', () => {
    const users: Record<string, SimUser> = {
      'leaver-uid': {
        points: 50,
        warningCount: 0,
        warnings: [],
        userData: onLeaveUser(),
      },
    };
    const tasks: SimTask[] = [
      {
        id: 'task-1',
        title: 'Poster draft',
        assigneeIds: ['leaver-uid'],
        status: 'pending',
        deadline: DEADLINE_INSIDE,
      },
    ];
    const result = simulateCronRun(tasks, users, 5);

    expect(result.warningsIssued).toBe(0);
    expect(result.pointsAudit).toEqual([]);
    expect(users['leaver-uid'].points).toBe(50);
    expect(users['leaver-uid'].warningCount).toBe(0);
    expect(users['leaver-uid'].warnings).toEqual([]);
    expect(tasks[0].overdueProcessed).toBe(false);
    expect(tasks[0].status).toBe('pending');
    expect(result.skippedDetails).toHaveLength(1);
    expect(result.skippedDetails[0].taskId).toBe('task-1');
    expect(result.skippedDetails[0].assigneeId).toBe('leaver-uid');
    expect(result.skippedDetails[0].reason).toMatch(/leave/i);
    expect(result.skippedDetails[0].reason).toContain('leave-req-1');
    expect(result.skippedDetails[0].reason).toMatch(/not marked processed/);
  });

  test('sole assignee with deadline outside the window: warning plus penalty applied normally', () => {
    const users: Record<string, SimUser> = {
      'leaver-uid': {
        points: 50,
        warningCount: 0,
        warnings: [],
        userData: onLeaveUser(),
      },
    };
    const tasks: SimTask[] = [
      {
        id: 'task-2',
        title: 'Poster draft',
        assigneeIds: ['leaver-uid'],
        status: 'pending',
        deadline: DEADLINE_AFTER,
      },
    ];
    const result = simulateCronRun(tasks, users, 5);

    expect(result.warningsIssued).toBe(1);
    expect(users['leaver-uid'].points).toBe(45);
    expect(users['leaver-uid'].warningCount).toBe(1);
    expect(users['leaver-uid'].warnings).toHaveLength(1);
    expect(result.pointsAudit).toEqual([{ userId: 'leaver-uid', delta: -5, taskId: 'task-2' }]);
    expect(tasks[0].overdueProcessed).toBe(true);
    expect(tasks[0].status).toBe('overdue');
    expect(result.skippedDetails).toEqual([]);
  });

  test('mixed assignees: exempt skipped, non-exempt penalized, task IS stamped once a non-exempt assignee is processed (exempt assignee not revisited, known v1 limitation)', () => {
    const users: Record<string, SimUser> = {
      'leaver-uid': {
        points: 50,
        warningCount: 0,
        warnings: [],
        userData: onLeaveUser(),
      },
      'worker-uid': {
        points: 40,
        warningCount: 0,
        warnings: [],
        userData: { isOnVacation: false },
      },
    };
    const tasks: SimTask[] = [
      {
        id: 'task-3',
        title: 'Shared deliverable',
        assigneeIds: ['leaver-uid', 'worker-uid'],
        status: 'pending',
        deadline: DEADLINE_INSIDE,
      },
    ];
    const result = simulateCronRun(tasks, users, 5);

    expect(result.warningsIssued).toBe(1);
    expect(users['leaver-uid'].points).toBe(50);
    expect(users['leaver-uid'].warningCount).toBe(0);
    expect(users['worker-uid'].points).toBe(35);
    expect(users['worker-uid'].warningCount).toBe(1);
    expect(tasks[0].overdueProcessed).toBe(true);
    expect(tasks[0].status).toBe('overdue');
    expect(tasks[0].processedAssigneeIds).toEqual(['worker-uid']);
    const skip = result.skippedDetails.find((s) => s.assigneeId === 'leaver-uid');
    expect(skip).toBeDefined();
    expect(skip!.reason).toMatch(/leave/i);
  });

  test('member whose leave ended before the deadline is penalized normally, window check not just flag check', () => {
    const users: Record<string, SimUser> = {
      'leaver-uid': {
        points: 50,
        warningCount: 0,
        warnings: [],
        // Flag still on (stale, return not yet processed) but the
        // approved window ended before the deadline.
        userData: onLeaveUser(),
      },
    };
    const tasks: SimTask[] = [
      {
        id: 'task-4',
        title: 'Late deliverable',
        assigneeIds: ['leaver-uid'],
        status: 'pending',
        deadline: DEADLINE_AFTER,
      },
    ];
    const result = simulateCronRun(tasks, users, 5);
    expect(result.warningsIssued).toBe(1);
    expect(users['leaver-uid'].points).toBe(45);
    expect(tasks[0].overdueProcessed).toBe(true);
  });

  test('task with no assignees is skipped and not stamped processed', () => {
    const tasks: SimTask[] = [
      {
        id: 'task-5',
        title: 'Orphan task',
        assigneeIds: [],
        status: 'pending',
        deadline: DEADLINE_INSIDE,
      },
    ];
    const result = simulateCronRun(tasks, {}, 5);
    expect(result.warningsIssued).toBe(0);
    expect(tasks[0].overdueProcessed).toBe(false);
    expect(result.skippedDetails[0].reason).toMatch(/no assignees/);
  });

  test('already processed task is not warned or penalized a second time', () => {
    const users: Record<string, SimUser> = {
      'worker-uid': {
        points: 40,
        warningCount: 1,
        warnings: [{ taskId: 'task-6', reason: 'Missed deadline for task: Done' }],
        userData: { isOnVacation: false },
      },
    };
    const tasks: SimTask[] = [
      {
        id: 'task-6',
        title: 'Done',
        assigneeIds: ['worker-uid'],
        status: 'overdue',
        overdueProcessed: true,
        deadline: DEADLINE_INSIDE,
      },
    ];
    const result = simulateCronRun(tasks, users, 5);
    expect(result.warningsIssued).toBe(0);
    expect(users['worker-uid'].points).toBe(40);
    expect(users['worker-uid'].warningCount).toBe(1);
  });

  test('cron exemption keys on individualDeadline when present', () => {
    const users: Record<string, SimUser> = {
      'leaver-uid': {
        points: 50,
        warningCount: 0,
        warnings: [],
        userData: onLeaveUser(),
      },
    };
    const tasks: SimTask[] = [
      {
        id: 'task-7',
        title: 'Workflow step',
        assigneeIds: ['leaver-uid'],
        status: 'pending',
        deadline: DEADLINE_AFTER,
        individualDeadline: DEADLINE_INSIDE,
      },
    ];
    const result = simulateCronRun(tasks, users, 5);
    expect(result.warningsIssued).toBe(0);
    expect(users['leaver-uid'].points).toBe(50);
    expect(tasks[0].overdueProcessed).toBe(false);
    expect(result.skippedDetails).toHaveLength(1);
    expect(result.skippedDetails[0].reason).toMatch(/leave/i);
  });
});
