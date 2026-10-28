/**
 * Tests for isExemptFromDeadlinePenalty (record-based) and the pure
 * window matcher isExemptForLeaveWindow.
 *
 * Run: npx jest src/lib/server/__tests__/leave-exemption.test.ts
 *
 * HELPER UNDER TEST:
 *   src/lib/server/leave-exemption.ts
 *   isExemptFromDeadlinePenalty(db, uid, taskData, nowMs?)
 *     -> Promise<{ exempt: boolean, reason: string, leaveRequestId?: string }>
 *
 * RULE UNDER TEST:
 *   Exempt when a granted leave record for the assignee covers the
 *   task deadline: a doc in `leave_requests` with userId == uid and
 *   status 'approved' or 'completed' whose window
 *   (startDate <= deadline <= endDate, inclusive) contains the
 *   deadline, where the deadline is taskData.individualDeadline when
 *   present, otherwise taskData.deadline.
 *
 *   The decision comes from the RECORDS, never from the member's
 *   live user-doc flags. That is the regression this suite exists to
 *   pin: returning from leave clears the flags, and a deadline that
 *   fell inside a granted leave must STILL be exempt afterwards.
 *   These tests therefore pass no user doc at all; the only inputs
 *   are the fake Firestore contents, the uid, and the task.
 *
 * FAKE FIRESTORE:
 *   The fake deliberately returns ALL seeded records for the queried
 *   user WITHOUT applying the status filter, and records every query
 *   clause instead. That way the tests prove two things separately:
 *   (1) the helper ASKS with the right bounded query (userId
 *   equality, status in approved/completed, a limit, exactly one
 *   get), and (2) the helper's DECISION is correct even if handed
 *   records the real query would have filtered out (rejected,
 *   cancelled, pending records never exempt).
 *
 * DELIBERATE NON-GOALS:
 *   - Exact reason strings are not pinned, only that reason is a
 *     non-empty string.
 *   - leaveHold behavior is not pinned here; it belongs to the
 *     cron-level slice, not this helper slice.
 */

import {
  isExemptFromDeadlinePenalty,
  isExemptForLeaveWindow,
} from '../leave-exemption';

const UID = 'user-1';
const OTHER_UID = 'user-2';

// Date-only leave window used by most fixtures (leave_requests
// stores startDate/endDate as YYYY-MM-DD strings):
// 2026-10-10 through 2026-10-20 inclusive, Asia/Karachi.
const LEAVE_START = '2026-10-10';
const LEAVE_END = '2026-10-20';

const INSIDE_ISO = '2026-10-15T12:00:00.000Z';
const BEFORE_ISO = '2026-10-09T12:00:00.000Z';
const AFTER_ISO = '2026-10-21T12:00:00.000Z';

const APPROVED_ID = 'leave-approved-1';
const COMPLETED_ID = 'leave-completed-1';

type FakeRecord = { id: string; data: Record<string, any> };

/**
 * Build a fake Admin Firestore whose leave_requests collection
 * returns the seeded records for the queried uid (status filter NOT
 * applied by the fake; see the header). `queries` captures every
 * clause so tests can pin the query shape.
 */
function makeFakeDb(recordsByUid: Record<string, FakeRecord[]>) {
  const queries: Array<{
    collection: string;
    wheres: Array<[string, string, unknown]>;
    limitValue: number | null;
    getCalls: number;
  }> = [];

  const db = {
    collection(name: string) {
      const query: any = {
        collection: name,
        wheres: [] as Array<[string, string, unknown]>,
        limitValue: null as number | null,
        getCalls: 0,
      };
      queries.push(query);
      query.where = (field: string, op: string, value: unknown) => {
        query.wheres.push([field, op, value]);
        return query;
      };
      query.limit = (n: number) => {
        query.limitValue = n;
        return query;
      };
      query.get = async () => {
        query.getCalls += 1;
        const uidWhere = query.wheres.find(([f]: [string]) => f === 'userId');
        const uid = uidWhere ? String(uidWhere[2]) : '';
        const records = recordsByUid[uid] || [];
        const limited =
          query.limitValue !== null
            ? records.slice(0, query.limitValue)
            : records;
        return {
          docs: limited.map((r) => ({ id: r.id, data: () => r.data })),
          empty: limited.length === 0,
          size: limited.length,
        };
      };
      return query;
    },
  };

  return { db, queries };
}

function leaveRecord(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    userId: UID,
    status: 'approved',
    leaveType: 'annual',
    startDate: LEAVE_START,
    endDate: LEAVE_END,
    reason: 'test leave',
    ...overrides,
  };
}

function dbWithApprovedLeave() {
  return makeFakeDb({
    [UID]: [{ id: APPROVED_ID, data: leaveRecord() }],
  });
}

function makeTask(overrides: Record<string, any> = {}): any {
  return {
    deadline: INSIDE_ISO,
    ...overrides,
  };
}

function expectNonEmptyReason(result: any): void {
  expect(typeof result.reason).toBe('string');
  expect(result.reason.length).toBeGreaterThan(0);
}

// Minimal Firestore Timestamp stand-in for the pure-matcher tests.
function makeTimestamp(ms: number): any {
  return {
    seconds: Math.floor(ms / 1000),
    nanoseconds: (ms % 1000) * 1e6,
    toMillis: () => ms,
    toDate: () => new Date(ms),
  };
}

describe('isExemptFromDeadlinePenalty: exempt from granted leave records', () => {
  test('exempts while on leave: approved record covers the deadline', async () => {
    const { db } = dbWithApprovedLeave();
    const result = await isExemptFromDeadlinePenalty(db, UID, makeTask());
    expect(result.exempt).toBe(true);
    expect(result.leaveRequestId).toBe(APPROVED_ID);
    expectNonEmptyReason(result);
  });

  test('THE BUG CASE: still exempts AFTER the member returns (record completed, flags gone)', async () => {
    // After a return, the leave record's status is 'completed' and
    // the user doc's flags/window are cleared. The old helper read
    // the flags, so this evaluation recorded the miss. The helper
    // now takes no user doc at all: the completed record alone must
    // exempt, even when "now" is long after the leave ended.
    const { db } = makeFakeDb({
      [UID]: [
        {
          id: COMPLETED_ID,
          data: leaveRecord({
            status: 'completed',
            returnedAt: '2026-10-21T09:00:00.000Z',
          }),
        },
      ],
    });
    const longAfterReturn = Date.parse('2026-11-01T00:00:00.000Z');
    const result = await isExemptFromDeadlinePenalty(
      db,
      UID,
      makeTask(),
      longAfterReturn,
    );
    expect(result.exempt).toBe(true);
    expect(result.leaveRequestId).toBe(COMPLETED_ID);
    expectNonEmptyReason(result);
  });

  test('exempts when the deadline equals the first day of the leave', async () => {
    const { db } = dbWithApprovedLeave();
    const result = await isExemptFromDeadlinePenalty(
      db,
      UID,
      makeTask({ deadline: '2026-10-10' }),
    );
    expect(result.exempt).toBe(true);
    expectNonEmptyReason(result);
  });

  test('exempts when the deadline equals the last day of the leave', async () => {
    const { db } = dbWithApprovedLeave();
    const result = await isExemptFromDeadlinePenalty(
      db,
      UID,
      makeTask({ deadline: '2026-10-20' }),
    );
    expect(result.exempt).toBe(true);
    expectNonEmptyReason(result);
  });

  test('exempts via a second record when the first granted leave does not cover', async () => {
    const { db } = makeFakeDb({
      [UID]: [
        {
          id: 'leave-jan',
          data: leaveRecord({ startDate: '2026-01-05', endDate: '2026-01-09' }),
        },
        { id: APPROVED_ID, data: leaveRecord() },
      ],
    });
    const result = await isExemptFromDeadlinePenalty(db, UID, makeTask());
    expect(result.exempt).toBe(true);
    expect(result.leaveRequestId).toBe(APPROVED_ID);
  });
});

describe('isExemptFromDeadlinePenalty: not exempt', () => {
  test('does not exempt when no leave exists at all', async () => {
    const { db } = makeFakeDb({ [UID]: [] });
    const result = await isExemptFromDeadlinePenalty(db, UID, makeTask());
    expect(result.exempt).toBe(false);
    expect(result.leaveRequestId).toBeUndefined();
    expectNonEmptyReason(result);
  });

  test('does not exempt a different user who has no leave', async () => {
    const { db } = dbWithApprovedLeave();
    const result = await isExemptFromDeadlinePenalty(db, OTHER_UID, makeTask());
    expect(result.exempt).toBe(false);
    expectNonEmptyReason(result);
  });

  test('does not exempt when the deadline is before the approved window', async () => {
    const { db } = dbWithApprovedLeave();
    const result = await isExemptFromDeadlinePenalty(
      db,
      UID,
      makeTask({ deadline: BEFORE_ISO }),
    );
    expect(result.exempt).toBe(false);
    expect(result.leaveRequestId).toBeUndefined();
    expectNonEmptyReason(result);
  });

  test('does not exempt when the deadline is after the approved window', async () => {
    const { db } = dbWithApprovedLeave();
    const result = await isExemptFromDeadlinePenalty(
      db,
      UID,
      makeTask({ deadline: AFTER_ISO }),
    );
    expect(result.exempt).toBe(false);
    expect(result.leaveRequestId).toBeUndefined();
    expectNonEmptyReason(result);
  });

  test('does not exempt when the only covering leave was REJECTED', async () => {
    const { db } = makeFakeDb({
      [UID]: [
        { id: 'leave-rejected', data: leaveRecord({ status: 'rejected' }) },
      ],
    });
    const result = await isExemptFromDeadlinePenalty(db, UID, makeTask());
    expect(result.exempt).toBe(false);
    expect(result.leaveRequestId).toBeUndefined();
    expectNonEmptyReason(result);
  });

  test('does not exempt when the only covering leave was CANCELLED', async () => {
    const { db } = makeFakeDb({
      [UID]: [
        { id: 'leave-cancelled', data: leaveRecord({ status: 'cancelled' }) },
      ],
    });
    const result = await isExemptFromDeadlinePenalty(db, UID, makeTask());
    expect(result.exempt).toBe(false);
    expect(result.leaveRequestId).toBeUndefined();
    expectNonEmptyReason(result);
  });

  test('does not exempt when the only covering leave is still PENDING', async () => {
    const { db } = makeFakeDb({
      [UID]: [
        { id: 'leave-pending', data: leaveRecord({ status: 'pending' }) },
      ],
    });
    const result = await isExemptFromDeadlinePenalty(db, UID, makeTask());
    expect(result.exempt).toBe(false);
    expectNonEmptyReason(result);
  });

  test('a rejected covering leave does not block a granted non-covering one from being ignored correctly', async () => {
    const { db } = makeFakeDb({
      [UID]: [
        { id: 'leave-rejected', data: leaveRecord({ status: 'rejected' }) },
        {
          id: 'leave-jan',
          data: leaveRecord({ startDate: '2026-01-05', endDate: '2026-01-09' }),
        },
      ],
    });
    const result = await isExemptFromDeadlinePenalty(db, UID, makeTask());
    expect(result.exempt).toBe(false);
    expect(result.leaveRequestId).toBeUndefined();
  });
});

describe('isExemptFromDeadlinePenalty: query discipline', () => {
  test('issues exactly one bounded query: leave_requests by userId and granted statuses, with a limit', async () => {
    const { db, queries } = dbWithApprovedLeave();
    await isExemptFromDeadlinePenalty(db, UID, makeTask());
    expect(queries).toHaveLength(1);
    const q = queries[0];
    expect(q.collection).toBe('leave_requests');
    expect(q.wheres).toContainEqual(['userId', '==', UID]);
    const statusWhere = q.wheres.find(([f]) => f === 'status');
    expect(statusWhere).toBeDefined();
    expect(statusWhere![1]).toBe('in');
    expect([...(statusWhere![2] as string[])].sort()).toEqual([
      'approved',
      'completed',
    ]);
    expect(typeof q.limitValue).toBe('number');
    expect(q.limitValue!).toBeGreaterThan(0);
    expect(q.getCalls).toBe(1);
  });

  test('issues NO query when the task has no usable deadline', async () => {
    const { db, queries } = dbWithApprovedLeave();
    const result = await isExemptFromDeadlinePenalty(db, UID, {
      title: 'no deadline here',
    });
    expect(result.exempt).toBe(false);
    expect(queries).toHaveLength(0);
    expectNonEmptyReason(result);
  });
});

describe('isExemptFromDeadlinePenalty: deadline selection and formats', () => {
  test('individualDeadline wins over deadline', async () => {
    const { db } = dbWithApprovedLeave();
    const inside = await isExemptFromDeadlinePenalty(
      db,
      UID,
      makeTask({ deadline: AFTER_ISO, individualDeadline: INSIDE_ISO }),
    );
    expect(inside.exempt).toBe(true);

    const outside = await isExemptFromDeadlinePenalty(
      db,
      UID,
      makeTask({ deadline: INSIDE_ISO, individualDeadline: AFTER_ISO }),
    );
    expect(outside.exempt).toBe(false);
  });

  test('handles the deadline as a Firestore Timestamp object', async () => {
    const { db } = dbWithApprovedLeave();
    const result = await isExemptFromDeadlinePenalty(
      db,
      UID,
      makeTask({ deadline: makeTimestamp(Date.parse(INSIDE_ISO)) }),
    );
    expect(result.exempt).toBe(true);
  });

  test('handles the deadline as epoch milliseconds', async () => {
    const { db } = dbWithApprovedLeave();
    const result = await isExemptFromDeadlinePenalty(
      db,
      UID,
      makeTask({ deadline: Date.parse(INSIDE_ISO) }),
    );
    expect(result.exempt).toBe(true);
  });

  test('a date-only deadline on the day after the leave ends is not exempt', async () => {
    const { db } = dbWithApprovedLeave();
    const result = await isExemptFromDeadlinePenalty(
      db,
      UID,
      makeTask({ deadline: '2026-10-21' }),
    );
    expect(result.exempt).toBe(false);
  });
});

describe('isExemptFromDeadlinePenalty: malformed inputs never throw', () => {
  test('missing or blank uid returns false without a query', async () => {
    const { db, queries } = dbWithApprovedLeave();
    await expect(
      isExemptFromDeadlinePenalty(db, '', makeTask()),
    ).resolves.toMatchObject({ exempt: false });
    await expect(
      isExemptFromDeadlinePenalty(db, '   ', makeTask()),
    ).resolves.toMatchObject({ exempt: false });
    await expect(
      isExemptFromDeadlinePenalty(db, undefined as any, makeTask()),
    ).resolves.toMatchObject({ exempt: false });
    expect(queries).toHaveLength(0);
  });

  test('null task returns false', async () => {
    const { db } = dbWithApprovedLeave();
    await expect(
      isExemptFromDeadlinePenalty(db, UID, null),
    ).resolves.toMatchObject({ exempt: false });
  });

  test('null db returns false', async () => {
    await expect(
      isExemptFromDeadlinePenalty(null, UID, makeTask()),
    ).resolves.toMatchObject({ exempt: false });
  });

  test('a failing query returns false and does not throw', async () => {
    const failingDb = {
      collection: () => ({
        where() {
          return this;
        },
        limit() {
          return this;
        },
        get: async () => {
          throw new Error('firestore unavailable');
        },
      }),
    };
    const result = await isExemptFromDeadlinePenalty(
      failingDb,
      UID,
      makeTask(),
    );
    expect(result.exempt).toBe(false);
    expectNonEmptyReason(result);
  });

  test('records with garbage windows are skipped, not fatal', async () => {
    const { db } = makeFakeDb({
      [UID]: [
        {
          id: 'leave-garbage',
          data: leaveRecord({ startDate: 'not-a-date', endDate: 'also-not' }),
        },
        { id: APPROVED_ID, data: leaveRecord() },
      ],
    });
    const result = await isExemptFromDeadlinePenalty(db, UID, makeTask());
    expect(result.exempt).toBe(true);
    expect(result.leaveRequestId).toBe(APPROVED_ID);
  });
});

describe('isExemptForLeaveWindow: pure window matcher', () => {
  const window = { startDate: LEAVE_START, endDate: LEAVE_END };

  test('matches a deadline inside a date-only window (record field names)', () => {
    const result = isExemptForLeaveWindow(window, makeTask());
    expect(result.exempt).toBe(true);
    expectNonEmptyReason(result);
  });

  test('matches windows carried under the legacy user-doc field names', () => {
    const result = isExemptForLeaveWindow(
      { vacationStartDate: LEAVE_START, vacationEndDate: LEAVE_END },
      makeTask(),
    );
    expect(result.exempt).toBe(true);
  });

  test('date representations are interchangeable', () => {
    const startMs = Date.parse('2026-10-10T00:00:00.000Z');
    const endMs = Date.parse('2026-10-20T23:59:59.999Z');
    const variants = [
      { startDate: makeTimestamp(startMs), endDate: makeTimestamp(endMs) },
      { startDate: new Date(startMs), endDate: new Date(endMs) },
      {
        startDate: '2026-10-10T00:00:00.000Z',
        endDate: '2026-10-20T23:59:59.999Z',
      },
    ];
    for (const v of variants) {
      expect(isExemptForLeaveWindow(v, makeTask()).exempt).toBe(true);
    }
  });

  test('consults no flag: a window object with flags set false still matches on the window alone', () => {
    // The matcher answers a window question only. In production it is
    // fed granted leave records; the flag fields play no part either
    // way.
    const result = isExemptForLeaveWindow(
      { ...window, isOnVacation: false, vacationMode: false },
      makeTask(),
    );
    expect(result.exempt).toBe(true);
  });

  test('does not match outside the window or with an unusable window', () => {
    expect(
      isExemptForLeaveWindow(window, makeTask({ deadline: AFTER_ISO })).exempt,
    ).toBe(false);
    expect(isExemptForLeaveWindow({}, makeTask()).exempt).toBe(false);
    expect(isExemptForLeaveWindow(null, makeTask()).exempt).toBe(false);
    expect(isExemptForLeaveWindow(window, null).exempt).toBe(false);
  });
});
