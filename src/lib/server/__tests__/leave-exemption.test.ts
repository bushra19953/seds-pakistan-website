/**
 * Tests for isExemptFromDeadlinePenalty.
 *
 * INSTALL: copy this file to
 *   src/lib/server/__tests__/leave-exemption.test.ts
 * in the repo, then run: npx jest src/lib/server/__tests__/leave-exemption.test.ts
 *
 * ASSUMED HELPER (from the slice brief):
 *   src/lib/server/leave-exemption.ts
 *   isExemptFromDeadlinePenalty(userData, taskData, nowMs?)
 *     -> { exempt: boolean, reason: string, leaveRequestId?: string }
 *
 * RULE UNDER TEST (adaptation guide, Step 4):
 *   Exempt when the user is on leave (isOnVacation OR vacationMode)
 *   AND the task deadline falls inside the approved leave window
 *   (vacationStartDate <= deadline <= vacationEndDate, inclusive),
 *   where the deadline is taskData.individualDeadline when present,
 *   otherwise taskData.deadline.
 *
 * DELIBERATE NON-GOALS (not pinned here, see NOTES.md):
 *   - Exact reason strings are not pinned, only that reason is a non-empty string.
 *   - nowMs behavior outside the window is not pinned, only that nowMs is
 *     accepted and does not change the deadline-based result when passed.
 *   - leaveHold behavior is not pinned here; it belongs to the cron-level
 *     slice, not this helper slice.
 */

import { isExemptFromDeadlinePenalty } from '../leave-exemption';

// Fixed window: 2026-10-10 00:00:00.000Z through 2026-10-20 23:59:59.999Z.
const LEAVE_START_ISO = '2026-10-10T00:00:00.000Z';
const LEAVE_END_ISO = '2026-10-20T23:59:59.999Z';
const LEAVE_START_MS = Date.parse(LEAVE_START_ISO);
const LEAVE_END_MS = Date.parse(LEAVE_END_ISO);

const INSIDE_ISO = '2026-10-15T12:00:00.000Z';
const INSIDE_MS = Date.parse(INSIDE_ISO);
const BEFORE_ISO = '2026-10-09T12:00:00.000Z';
const AFTER_ISO = '2026-10-21T12:00:00.000Z';

// Date-only window: 2026-10-10 through 2026-10-20 inclusive.
const DATE_ONLY_START = '2026-10-10';
const DATE_ONLY_END = '2026-10-20';

const LEAVE_REQUEST_ID = 'leave-123';

// Minimal Firestore Timestamp stand-in: real Timestamps expose toMillis,
// seconds, nanoseconds, and toDate. The helper must accept this shape.
function makeTimestamp(ms: number): any {
  return {
    seconds: Math.floor(ms / 1000),
    nanoseconds: (ms % 1000) * 1e6,
    toMillis: () => ms,
    toDate: () => new Date(ms),
  };
}

function makeUser(overrides: Record<string, any> = {}): any {
  return {
    isOnVacation: true,
    vacationStartDate: LEAVE_START_ISO,
    vacationEndDate: LEAVE_END_ISO,
    leaveRequestId: LEAVE_REQUEST_ID,
    ...overrides,
  };
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

describe('isExemptFromDeadlinePenalty: deadline inside window with flag on', () => {
  test('exempts when deadline is inside the window and isOnVacation is true', () => {
    const result = isExemptFromDeadlinePenalty(makeUser(), makeTask());
    expect(result.exempt).toBe(true);
    expectNonEmptyReason(result);
  });

  test('exempts when deadline equals the exact start instant', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser(),
      makeTask({ deadline: LEAVE_START_ISO })
    );
    expect(result.exempt).toBe(true);
    expectNonEmptyReason(result);
  });

  test('exempts when deadline equals the exact end instant', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser(),
      makeTask({ deadline: LEAVE_END_ISO })
    );
    expect(result.exempt).toBe(true);
    expectNonEmptyReason(result);
  });
});

describe('isExemptFromDeadlinePenalty: deadline outside window', () => {
  test('does not exempt when deadline is before the window', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser(),
      makeTask({ deadline: BEFORE_ISO })
    );
    expect(result.exempt).toBe(false);
    expect(result.leaveRequestId).toBeUndefined();
    expectNonEmptyReason(result);
  });

  test('does not exempt when deadline is after the window', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser(),
      makeTask({ deadline: AFTER_ISO })
    );
    expect(result.exempt).toBe(false);
    expect(result.leaveRequestId).toBeUndefined();
    expectNonEmptyReason(result);
  });

  test('does not exempt when deadline is 1ms before the start instant', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser(),
      makeTask({ deadline: LEAVE_START_MS - 1 })
    );
    expect(result.exempt).toBe(false);
    expectNonEmptyReason(result);
  });

  test('does not exempt when deadline is 1ms after the end instant', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser(),
      makeTask({ deadline: LEAVE_END_MS + 1 })
    );
    expect(result.exempt).toBe(false);
    expectNonEmptyReason(result);
  });
});

describe('isExemptFromDeadlinePenalty: flag off', () => {
  test('does not exempt when both flags are false even if deadline is inside', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser({ isOnVacation: false, vacationMode: false }),
      makeTask()
    );
    expect(result.exempt).toBe(false);
    expect(result.leaveRequestId).toBeUndefined();
    expectNonEmptyReason(result);
  });

  test('does not exempt when neither flag is set even if deadline is inside', () => {
    const result = isExemptFromDeadlinePenalty(
      {
        vacationStartDate: LEAVE_START_ISO,
        vacationEndDate: LEAVE_END_ISO,
        leaveRequestId: LEAVE_REQUEST_ID,
      },
      makeTask()
    );
    expect(result.exempt).toBe(false);
    expect(result.leaveRequestId).toBeUndefined();
    expectNonEmptyReason(result);
  });

  test('does not exempt when isOnVacation is false and vacationMode is missing', () => {
    const result = isExemptFromDeadlinePenalty(
      {
        isOnVacation: false,
        vacationStartDate: LEAVE_START_ISO,
        vacationEndDate: LEAVE_END_ISO,
      },
      makeTask()
    );
    expect(result.exempt).toBe(false);
    expectNonEmptyReason(result);
  });

  test('does not exempt when vacationMode is false and isOnVacation is missing', () => {
    const result = isExemptFromDeadlinePenalty(
      {
        vacationMode: false,
        vacationStartDate: LEAVE_START_ISO,
        vacationEndDate: LEAVE_END_ISO,
      },
      makeTask()
    );
    expect(result.exempt).toBe(false);
    expectNonEmptyReason(result);
  });
});

describe('isExemptFromDeadlinePenalty: no usable window', () => {
  test('does not exempt when flag is on but the window is missing entirely', () => {
    const result = isExemptFromDeadlinePenalty(
      { isOnVacation: true, leaveRequestId: LEAVE_REQUEST_ID },
      makeTask()
    );
    expect(result.exempt).toBe(false);
    expect(result.leaveRequestId).toBeUndefined();
    expectNonEmptyReason(result);
  });

  test('does not exempt when flag is on but only the start date is present', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser({ vacationEndDate: undefined }),
      makeTask()
    );
    expect(result.exempt).toBe(false);
    expectNonEmptyReason(result);
  });

  test('does not exempt when flag is on but only the end date is present', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser({ vacationStartDate: undefined }),
      makeTask()
    );
    expect(result.exempt).toBe(false);
    expectNonEmptyReason(result);
  });

  test('does not exempt when flag is on but the start date is null', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser({ vacationStartDate: null }),
      makeTask()
    );
    expect(result.exempt).toBe(false);
    expectNonEmptyReason(result);
  });

  test('does not exempt when flag is on but the end date is null', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser({ vacationEndDate: null }),
      makeTask()
    );
    expect(result.exempt).toBe(false);
    expectNonEmptyReason(result);
  });

  test('does not exempt when the end date is before the start date', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser({
        vacationStartDate: LEAVE_END_ISO,
        vacationEndDate: LEAVE_START_ISO,
      }),
      makeTask()
    );
    expect(result.exempt).toBe(false);
    expectNonEmptyReason(result);
  });
});

describe('isExemptFromDeadlinePenalty: individualDeadline precedence', () => {
  test('exempts when individualDeadline is inside even if deadline is outside', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser(),
      makeTask({ deadline: AFTER_ISO, individualDeadline: INSIDE_ISO })
    );
    expect(result.exempt).toBe(true);
    expect(result.leaveRequestId).toBe(LEAVE_REQUEST_ID);
    expectNonEmptyReason(result);
  });

  test('does not exempt when individualDeadline is outside even if deadline is inside', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser(),
      makeTask({ deadline: INSIDE_ISO, individualDeadline: AFTER_ISO })
    );
    expect(result.exempt).toBe(false);
    expect(result.leaveRequestId).toBeUndefined();
    expectNonEmptyReason(result);
  });

  test('exempts when individualDeadline is inside and deadline is missing', () => {
    const result = isExemptFromDeadlinePenalty(makeUser(), {
      individualDeadline: INSIDE_ISO,
    });
    expect(result.exempt).toBe(true);
    expectNonEmptyReason(result);
  });

  test('falls back to deadline when individualDeadline is undefined', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser(),
      makeTask({ deadline: INSIDE_ISO, individualDeadline: undefined })
    );
    expect(result.exempt).toBe(true);
    expectNonEmptyReason(result);
  });

  test('falls back to deadline when individualDeadline is null', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser(),
      makeTask({ deadline: INSIDE_ISO, individualDeadline: null })
    );
    expect(result.exempt).toBe(true);
    expectNonEmptyReason(result);
  });
});

describe('isExemptFromDeadlinePenalty: deadline input formats', () => {
  test('handles deadline as epoch milliseconds number', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser(),
      makeTask({ deadline: INSIDE_MS })
    );
    expect(result.exempt).toBe(true);
    expectNonEmptyReason(result);
  });

  test('handles deadline as ISO string', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser(),
      makeTask({ deadline: INSIDE_ISO })
    );
    expect(result.exempt).toBe(true);
    expectNonEmptyReason(result);
  });

  test('handles deadline as Date object', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser(),
      makeTask({ deadline: new Date(INSIDE_MS) })
    );
    expect(result.exempt).toBe(true);
    expectNonEmptyReason(result);
  });

  test('handles deadline as Firestore Timestamp object', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser(),
      makeTask({ deadline: makeTimestamp(INSIDE_MS) })
    );
    expect(result.exempt).toBe(true);
    expectNonEmptyReason(result);
  });
});

describe('isExemptFromDeadlinePenalty: window input formats', () => {
  test('handles window bounds as epoch milliseconds numbers', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser({
        vacationStartDate: LEAVE_START_MS,
        vacationEndDate: LEAVE_END_MS,
      }),
      makeTask()
    );
    expect(result.exempt).toBe(true);
    expectNonEmptyReason(result);
  });

  test('handles window bounds as Date objects', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser({
        vacationStartDate: new Date(LEAVE_START_MS),
        vacationEndDate: new Date(LEAVE_END_MS),
      }),
      makeTask()
    );
    expect(result.exempt).toBe(true);
    expectNonEmptyReason(result);
  });

  test('handles window bounds as Firestore Timestamp objects', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser({
        vacationStartDate: makeTimestamp(LEAVE_START_MS),
        vacationEndDate: makeTimestamp(LEAVE_END_MS),
      }),
      makeTask()
    );
    expect(result.exempt).toBe(true);
    expectNonEmptyReason(result);
  });

  test('handles mixed formats across start, end, and deadline', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser({
        vacationStartDate: makeTimestamp(LEAVE_START_MS),
        vacationEndDate: new Date(LEAVE_END_MS),
      }),
      makeTask({ deadline: INSIDE_MS })
    );
    expect(result.exempt).toBe(true);
    expectNonEmptyReason(result);
  });
});

describe('isExemptFromDeadlinePenalty: date-only window bounds', () => {
  test('treats a date-only end date as end of day, not midnight', () => {
    // If "2026-10-20" meant midnight at the start of that day, a noon
    // deadline on the end date would fall outside. End of day keeps it inside.
    const result = isExemptFromDeadlinePenalty(
      makeUser({
        vacationStartDate: DATE_ONLY_START,
        vacationEndDate: DATE_ONLY_END,
      }),
      makeTask({ deadline: '2026-10-20T12:00:00.000Z' })
    );
    expect(result.exempt).toBe(true);
    expectNonEmptyReason(result);
  });

  test('exempts a late evening deadline on the date-only end date', () => {
    // 18:00 UTC is 23:00 PKT, so this is inside end of day under either
    // a UTC or a PKT reading of the date-only end date.
    const result = isExemptFromDeadlinePenalty(
      makeUser({
        vacationStartDate: DATE_ONLY_START,
        vacationEndDate: DATE_ONLY_END,
      }),
      makeTask({ deadline: '2026-10-20T18:00:00.000Z' })
    );
    expect(result.exempt).toBe(true);
    expectNonEmptyReason(result);
  });

  test('does not exempt a deadline on the day after a date-only end date', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser({
        vacationStartDate: DATE_ONLY_START,
        vacationEndDate: DATE_ONLY_END,
      }),
      makeTask({ deadline: '2026-10-21T00:00:00.000Z' })
    );
    expect(result.exempt).toBe(false);
    expectNonEmptyReason(result);
  });

  test('treats a date-only start date as start of day', () => {
    const inside = isExemptFromDeadlinePenalty(
      makeUser({
        vacationStartDate: DATE_ONLY_START,
        vacationEndDate: DATE_ONLY_END,
      }),
      makeTask({ deadline: '2026-10-10T12:00:00.000Z' })
    );
    expect(inside.exempt).toBe(true);

    const before = isExemptFromDeadlinePenalty(
      makeUser({
        vacationStartDate: DATE_ONLY_START,
        vacationEndDate: DATE_ONLY_END,
      }),
      // Date-only bounds are Asia/Karachi: leave starting 2026-10-10
      // begins 2026-10-09 19:00 UTC. 18:59:59 UTC is 23:59:59 PKT on
      // Oct 9, still before the leave. (23:59:59 UTC would already be
      // Oct 10 in PKT and therefore inside the leave.)
      makeTask({ deadline: '2026-10-09T18:59:59.999Z' })
    );
    expect(before.exempt).toBe(false);
  });
});

describe('isExemptFromDeadlinePenalty: leaveRequestId passthrough', () => {
  test('passes through leaveRequestId when exempt', () => {
    const result = isExemptFromDeadlinePenalty(makeUser(), makeTask());
    expect(result.exempt).toBe(true);
    expect(result.leaveRequestId).toBe(LEAVE_REQUEST_ID);
  });

  test('does not pass through leaveRequestId when not exempt', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser(),
      makeTask({ deadline: AFTER_ISO })
    );
    expect(result.exempt).toBe(false);
    expect(result.leaveRequestId).toBeUndefined();
  });

  test('returns undefined leaveRequestId when exempt but no id is stored', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser({ leaveRequestId: undefined }),
      makeTask()
    );
    expect(result.exempt).toBe(true);
    expect(result.leaveRequestId).toBeUndefined();
  });
});

describe('isExemptFromDeadlinePenalty: vacationMode counts as on leave', () => {
  test('counts vacationMode alone as on leave', () => {
    const result = isExemptFromDeadlinePenalty(
      {
        vacationMode: true,
        vacationStartDate: LEAVE_START_ISO,
        vacationEndDate: LEAVE_END_ISO,
        leaveRequestId: LEAVE_REQUEST_ID,
      },
      makeTask()
    );
    expect(result.exempt).toBe(true);
    expect(result.leaveRequestId).toBe(LEAVE_REQUEST_ID);
    expectNonEmptyReason(result);
  });

  test('counts vacationMode true even when isOnVacation is explicitly false', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser({ isOnVacation: false, vacationMode: true }),
      makeTask()
    );
    expect(result.exempt).toBe(true);
    expectNonEmptyReason(result);
  });

  test('counts isOnVacation true even when vacationMode is explicitly false', () => {
    const result = isExemptFromDeadlinePenalty(
      makeUser({ isOnVacation: true, vacationMode: false }),
      makeTask()
    );
    expect(result.exempt).toBe(true);
    expectNonEmptyReason(result);
  });
});

describe('isExemptFromDeadlinePenalty: malformed inputs never throw', () => {
  test('returns false and does not throw when userData is null', () => {
    let result: any;
    expect(() => {
      result = isExemptFromDeadlinePenalty(null as any, makeTask());
    }).not.toThrow();
    expect(result.exempt).toBe(false);
    expectNonEmptyReason(result);
  });

  test('returns false and does not throw when taskData is null', () => {
    let result: any;
    expect(() => {
      result = isExemptFromDeadlinePenalty(makeUser(), null as any);
    }).not.toThrow();
    expect(result.exempt).toBe(false);
    expectNonEmptyReason(result);
  });

  test('returns false and does not throw when both inputs are null', () => {
    let result: any;
    expect(() => {
      result = isExemptFromDeadlinePenalty(null as any, null as any);
    }).not.toThrow();
    expect(result.exempt).toBe(false);
    expectNonEmptyReason(result);
  });

  test('returns false and does not throw when inputs are non-objects', () => {
    let first: any;
    let second: any;
    expect(() => {
      first = isExemptFromDeadlinePenalty('not-an-object' as any, 42 as any);
      second = isExemptFromDeadlinePenalty([] as any, [] as any);
    }).not.toThrow();
    expect(first.exempt).toBe(false);
    expect(second.exempt).toBe(false);
  });

  test('returns false and does not throw when deadline is an invalid date string', () => {
    let first: any;
    let second: any;
    expect(() => {
      first = isExemptFromDeadlinePenalty(
        makeUser(),
        makeTask({ deadline: 'not-a-date' })
      );
      second = isExemptFromDeadlinePenalty(
        makeUser(),
        makeTask({ deadline: '' })
      );
    }).not.toThrow();
    expect(first.exempt).toBe(false);
    expect(second.exempt).toBe(false);
  });

  test('returns false and does not throw when deadline is NaN or Infinity', () => {
    let nanResult: any;
    let infResult: any;
    let negInfResult: any;
    expect(() => {
      nanResult = isExemptFromDeadlinePenalty(
        makeUser(),
        makeTask({ deadline: NaN })
      );
      infResult = isExemptFromDeadlinePenalty(
        makeUser(),
        makeTask({ deadline: Infinity })
      );
      negInfResult = isExemptFromDeadlinePenalty(
        makeUser(),
        makeTask({ deadline: -Infinity })
      );
    }).not.toThrow();
    expect(nanResult.exempt).toBe(false);
    expect(infResult.exempt).toBe(false);
    expect(negInfResult.exempt).toBe(false);
  });

  test('returns false and does not throw when deadline is a plain object or array', () => {
    let objectResult: any;
    let arrayResult: any;
    let boolResult: any;
    expect(() => {
      objectResult = isExemptFromDeadlinePenalty(
        makeUser(),
        makeTask({ deadline: {} })
      );
      arrayResult = isExemptFromDeadlinePenalty(
        makeUser(),
        makeTask({ deadline: [] })
      );
      boolResult = isExemptFromDeadlinePenalty(
        makeUser(),
        makeTask({ deadline: true })
      );
    }).not.toThrow();
    expect(objectResult.exempt).toBe(false);
    expect(arrayResult.exempt).toBe(false);
    expect(boolResult.exempt).toBe(false);
  });

  test('returns false and does not throw when window bounds are invalid strings', () => {
    let first: any;
    let second: any;
    let third: any;
    expect(() => {
      first = isExemptFromDeadlinePenalty(
        makeUser({
          vacationStartDate: 'not-a-date',
          vacationEndDate: 'also-not-a-date',
        }),
        makeTask()
      );
      second = isExemptFromDeadlinePenalty(
        makeUser({ vacationEndDate: 'garbage' }),
        makeTask()
      );
      third = isExemptFromDeadlinePenalty(
        makeUser({ vacationStartDate: 'garbage' }),
        makeTask()
      );
    }).not.toThrow();
    expect(first.exempt).toBe(false);
    expect(second.exempt).toBe(false);
    expect(third.exempt).toBe(false);
  });

  test('returns false and does not throw when a Timestamp toMillis throws', () => {
    const throwingTimestamp = {
      toMillis: () => {
        throw new Error('boom');
      },
    };
    let deadlineResult: any;
    let windowResult: any;
    expect(() => {
      deadlineResult = isExemptFromDeadlinePenalty(
        makeUser(),
        makeTask({ deadline: throwingTimestamp })
      );
      windowResult = isExemptFromDeadlinePenalty(
        makeUser({ vacationStartDate: throwingTimestamp }),
        makeTask()
      );
    }).not.toThrow();
    expect(deadlineResult.exempt).toBe(false);
    expect(windowResult.exempt).toBe(false);
  });

  test('returns false and does not throw when flag values are non-boolean truthy values', () => {
    // Flags are booleans in Firestore. A truthy string or number must not
    // grant an exemption on its own, so the helper must check strict true.
    let stringResult: any;
    let numberResult: any;
    expect(() => {
      stringResult = isExemptFromDeadlinePenalty(
        makeUser({ isOnVacation: 'true' as any }),
        makeTask()
      );
      numberResult = isExemptFromDeadlinePenalty(
        makeUser({ isOnVacation: undefined, vacationMode: 1 as any }),
        makeTask()
      );
    }).not.toThrow();
    expect(stringResult.exempt).toBe(false);
    expect(numberResult.exempt).toBe(false);
  });

  test('returns a non-empty reason string even for malformed inputs', () => {
    const nullResult: any = isExemptFromDeadlinePenalty(null as any, null as any);
    expect(nullResult.exempt).toBe(false);
    expectNonEmptyReason(nullResult);

    const badDeadline: any = isExemptFromDeadlinePenalty(
      makeUser(),
      makeTask({ deadline: 'not-a-date' })
    );
    expect(badDeadline.exempt).toBe(false);
    expectNonEmptyReason(badDeadline);
  });

  test('accepts an explicit nowMs and still exempts when deadline is inside the window', () => {
    const result = isExemptFromDeadlinePenalty(makeUser(), makeTask(), INSIDE_MS);
    expect(result.exempt).toBe(true);
    expectNonEmptyReason(result);
  });

  test('works when nowMs is omitted', () => {
    const result = isExemptFromDeadlinePenalty(makeUser(), makeTask());
    expect(result.exempt).toBe(true);
    expect(result.leaveRequestId).toBe(LEAVE_REQUEST_ID);
    expectNonEmptyReason(result);
  });
});
