/**
 * Tests for the leave window date helpers (src/lib/server/leave-dates.ts).
 * All judgements are Asia/Karachi calendar dates; leave windows are
 * inclusive of both the start and the end date.
 */
import {
  karachiTodayString,
  leaveHasStarted,
  leaveWindowPhase,
  normalizeLeaveDateString,
} from '../leave-dates';

describe('karachiTodayString', () => {
  test('renders the Karachi date for an instant late in the Karachi evening', () => {
    // 18:30 UTC = 23:30 PKT, still Oct 28 in Karachi.
    expect(karachiTodayString(new Date('2026-10-28T18:30:00Z'))).toBe('2026-10-28');
  });

  test('rolls to the next Karachi date just after Karachi midnight', () => {
    // 19:30 UTC = 00:30 PKT on Oct 29.
    expect(karachiTodayString(new Date('2026-10-28T19:30:00Z'))).toBe('2026-10-29');
  });

  test('renders the Karachi date for a mid-day instant', () => {
    // 10:00 UTC = 15:00 PKT.
    expect(karachiTodayString(new Date('2026-10-28T10:00:00Z'))).toBe('2026-10-28');
  });
});

describe('normalizeLeaveDateString', () => {
  test('passes a date-only string through', () => {
    expect(normalizeLeaveDateString('2026-11-03')).toBe('2026-11-03');
  });

  test('takes the date part of an ISO datetime string', () => {
    expect(normalizeLeaveDateString('2026-11-03T00:00:00.000Z')).toBe('2026-11-03');
  });

  test('converts a Date instant to its Karachi calendar date', () => {
    // Midnight UTC = 05:00 PKT the same day.
    expect(normalizeLeaveDateString(new Date('2026-11-03T00:00:00Z'))).toBe('2026-11-03');
    // 20:00 UTC = 01:00 PKT the NEXT day.
    expect(normalizeLeaveDateString(new Date('2026-11-03T20:00:00Z'))).toBe('2026-11-04');
  });

  test('converts a Timestamp-like value via toDate', () => {
    const ts = { toDate: () => new Date('2026-11-03T00:00:00Z') };
    expect(normalizeLeaveDateString(ts)).toBe('2026-11-03');
  });

  test('converts a { seconds } value', () => {
    const seconds = Math.floor(Date.parse('2026-11-03T00:00:00Z') / 1000);
    expect(normalizeLeaveDateString({ seconds })).toBe('2026-11-03');
  });

  test('returns null for unusable values', () => {
    expect(normalizeLeaveDateString(null)).toBeNull();
    expect(normalizeLeaveDateString(undefined)).toBeNull();
    expect(normalizeLeaveDateString('not-a-date')).toBeNull();
    expect(normalizeLeaveDateString(42)).toBeNull();
    expect(normalizeLeaveDateString({})).toBeNull();
  });
});

describe('leaveWindowPhase', () => {
  const today = '2026-10-28';

  test('a leave starting after today is future', () => {
    expect(leaveWindowPhase('2026-10-29', '2026-10-30', today)).toBe('future');
  });

  test('a leave starting today is in-window (start date is inclusive)', () => {
    expect(leaveWindowPhase('2026-10-28', '2026-10-30', today)).toBe('in-window');
  });

  test('a leave ending today is still in-window (end date is inclusive)', () => {
    expect(leaveWindowPhase('2026-10-26', '2026-10-28', today)).toBe('in-window');
  });

  test('a leave whose end date has passed is ended', () => {
    expect(leaveWindowPhase('2026-10-26', '2026-10-27', today)).toBe('ended');
  });

  test('an unparseable window is unknown', () => {
    expect(leaveWindowPhase(null, '2026-10-27', today)).toBe('unknown');
    expect(leaveWindowPhase('2026-10-26', 'garbage', today)).toBe('unknown');
  });
});

describe('leaveHasStarted', () => {
  const today = '2026-10-28';

  test('true for a start date in the past', () => {
    expect(leaveHasStarted('2026-10-20', today)).toBe(true);
  });

  test('true when the leave starts today', () => {
    expect(leaveHasStarted('2026-10-28', today)).toBe(true);
  });

  test('false for a future start date', () => {
    expect(leaveHasStarted('2026-11-05', today)).toBe(false);
  });

  test('true for an unparseable start date (legacy fallback)', () => {
    expect(leaveHasStarted(null, today)).toBe(true);
    expect(leaveHasStarted(undefined, today)).toBe(true);
  });
});
