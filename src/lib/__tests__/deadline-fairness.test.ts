/**
 * @jest-environment node
 *
 * Deadline fairness helpers (founder rule, 2026-10-26):
 *  - time in 'submitted-for-review' never counts against the assignee;
 *  - lateness is judged on the submission instant, not the approval
 *    instant;
 *  - direct completions with no submission keep the completion-instant
 *    judgment.
 */
import {
  taskTimeToMs,
  effectiveDeadlineMs,
  statusExemptsOverdue,
  countsAsOverdue,
  judgeCompletionLateness,
} from '../deadline-fairness';

const HOUR = 60 * 60 * 1000;
const DEADLINE = Date.parse('2026-10-27T00:34:00.000Z'); // 05:34 PKT
const SUBMITTED_ON_TIME = Date.parse('2026-10-26T14:00:00.000Z'); // ~10h early
const APPROVED_LATE = Date.parse('2026-10-27T07:00:00.000Z'); // after the deadline

function fakeTs(ms: number) {
  return { toMillis: () => ms, toDate: () => new Date(ms), seconds: Math.floor(ms / 1000), nanoseconds: 0 };
}

describe('taskTimeToMs', () => {
  it('accepts Timestamp-like, Date, string, number, and { seconds } shapes', () => {
    expect(taskTimeToMs(fakeTs(DEADLINE))).toBe(DEADLINE);
    expect(taskTimeToMs(new Date(DEADLINE))).toBe(DEADLINE);
    expect(taskTimeToMs('2026-10-27T00:34:00.000Z')).toBe(DEADLINE);
    expect(taskTimeToMs(DEADLINE)).toBe(DEADLINE);
    expect(taskTimeToMs({ seconds: Math.floor(DEADLINE / 1000) })).toBe(Math.floor(DEADLINE / 1000) * 1000);
  });

  it('returns null for unusable values', () => {
    expect(taskTimeToMs(null)).toBeNull();
    expect(taskTimeToMs(undefined)).toBeNull();
    expect(taskTimeToMs('')).toBeNull();
    expect(taskTimeToMs('not-a-date')).toBeNull();
    expect(taskTimeToMs({})).toBeNull();
  });
});

describe('effectiveDeadlineMs', () => {
  it('prefers individualDeadline over deadline', () => {
    expect(effectiveDeadlineMs({ deadline: DEADLINE + HOUR, individualDeadline: DEADLINE })).toBe(DEADLINE);
    expect(effectiveDeadlineMs({ deadline: DEADLINE })).toBe(DEADLINE);
    expect(effectiveDeadlineMs({})).toBeNull();
  });
});

describe('statusExemptsOverdue / countsAsOverdue', () => {
  it('a submitted-for-review task past its deadline is NOT overdue', () => {
    const task = { status: 'submitted-for-review', individualDeadline: DEADLINE };
    expect(statusExemptsOverdue(task.status)).toBe(true);
    expect(countsAsOverdue(task, APPROVED_LATE)).toBe(false);
  });

  it('terminal tasks are never overdue', () => {
    expect(countsAsOverdue({ status: 'completed', deadline: DEADLINE }, APPROVED_LATE)).toBe(false);
    expect(countsAsOverdue({ status: 'approved', deadline: DEADLINE }, APPROVED_LATE)).toBe(false);
  });

  it('an untouched task past its deadline IS overdue', () => {
    expect(countsAsOverdue({ status: 'pending', deadline: DEADLINE }, APPROVED_LATE)).toBe(true);
    expect(countsAsOverdue({ status: 'in-progress', individualDeadline: DEADLINE }, APPROVED_LATE)).toBe(true);
    expect(countsAsOverdue({ status: 'pending', deadline: DEADLINE }, DEADLINE - HOUR)).toBe(false);
  });
});

describe('judgeCompletionLateness', () => {
  it("Ahmed's case: submitted ~10h early, approved after the deadline -> NOT late", () => {
    const task = {
      status: 'submitted-for-review',
      individualDeadline: fakeTs(DEADLINE),
      submittedAt: fakeTs(SUBMITTED_ON_TIME),
      penaltyPoints: 10,
    };
    const verdict = judgeCompletionLateness(task, APPROVED_LATE);
    expect(verdict.judgedOn).toBe('submittedAt');
    expect(verdict.judgedAtMs).toBe(SUBMITTED_ON_TIME);
    expect(verdict.isLate).toBe(false);
  });

  it('a genuinely late submission stays late even if approved instantly', () => {
    const task = {
      status: 'submitted-for-review',
      individualDeadline: DEADLINE,
      submittedAt: DEADLINE + HOUR,
    };
    const verdict = judgeCompletionLateness(task, DEADLINE + HOUR + 1000);
    expect(verdict.judgedOn).toBe('submittedAt');
    expect(verdict.isLate).toBe(true);
  });

  it('no submission record: completion instant decides (historic behavior)', () => {
    const task = { status: 'pending', deadline: DEADLINE };
    expect(judgeCompletionLateness(task, APPROVED_LATE).isLate).toBe(true);
    expect(judgeCompletionLateness(task, APPROVED_LATE).judgedOn).toBe('completion');
    expect(judgeCompletionLateness(task, DEADLINE - HOUR).isLate).toBe(false);
  });

  it('no deadline: never late', () => {
    expect(judgeCompletionLateness({ submittedAt: SUBMITTED_ON_TIME }, APPROVED_LATE).isLate).toBe(false);
  });

  it('resubmission after a return is judged against the NEW deadline the reviewer set', () => {
    // Returned with a new deadline of 2026-10-28T13:00Z, resubmitted
    // before it, approved after the ORIGINAL deadline: not late.
    const task = {
      status: 'submitted-for-review',
      individualDeadline: Date.parse('2026-10-28T13:00:00.000Z'),
      submittedAt: Date.parse('2026-10-28T06:00:00.000Z'),
      firstSubmittedAt: SUBMITTED_ON_TIME,
    };
    const verdict = judgeCompletionLateness(task, Date.parse('2026-10-28T15:00:00.000Z'));
    expect(verdict.isLate).toBe(false);
  });
});
