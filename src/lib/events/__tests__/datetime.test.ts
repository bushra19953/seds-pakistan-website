/**
 * Pins the events date-time round trip (src/lib/events/datetime.ts).
 *
 * The helpers are pure UTC arithmetic with a fixed +05:00 offset, so every
 * expectation below is stated as an absolute UTC instant and must hold in
 * ANY runtime timezone. The final describe re-runs the core expectations
 * under several process.env.TZ values to prove the conversions never
 * consult local time.
 */
import {
  pktWallTimeToUtcMs,
  utcMsToPktWallTime,
  dateToPktWallTime,
  pktWallTimeToDate,
  eventInstantToMs,
  formatEventInstantInPkt,
} from '../datetime';

// 2026-10-25 10:00 PKT == 2026-10-25 05:00 UTC (the guide-pass values).
const START_MS = Date.UTC(2026, 9, 25, 5, 0);
const END_MS = Date.UTC(2026, 9, 25, 7, 0);

describe('pktWallTimeToUtcMs', () => {
  it('parses a PKT wall time to the UTC instant 5 hours earlier', () => {
    expect(pktWallTimeToUtcMs('2026-10-25T10:00')).toBe(START_MS);
    expect(pktWallTimeToUtcMs('2026-10-25T12:00')).toBe(END_MS);
  });

  it('parses a midnight wall time across the UTC day boundary', () => {
    // PKT midnight Oct 25 is Oct 24 19:00 UTC.
    expect(pktWallTimeToUtcMs('2026-10-25T00:00')).toBe(Date.UTC(2026, 9, 24, 19, 0));
  });

  it('treats a bare date as PKT midnight', () => {
    expect(pktWallTimeToUtcMs('2026-10-25')).toBe(Date.UTC(2026, 9, 24, 19, 0));
  });

  it('keeps non-zero seconds', () => {
    expect(pktWallTimeToUtcMs('2026-10-25T10:00:30')).toBe(START_MS + 30_000);
  });

  it('rejects invalid, overflow, and offset-carrying strings', () => {
    expect(pktWallTimeToUtcMs('')).toBeNull();
    expect(pktWallTimeToUtcMs('garbage')).toBeNull();
    expect(pktWallTimeToUtcMs('2026-02-30T10:00')).toBeNull();
    expect(pktWallTimeToUtcMs('2026-10-25T24:00')).toBeNull();
    expect(pktWallTimeToUtcMs('2026-10-25T10:00Z')).toBeNull();
    expect(pktWallTimeToUtcMs('2026-10-25T10:00+05:00')).toBeNull();
    expect(pktWallTimeToUtcMs(undefined)).toBeNull();
    expect(pktWallTimeToUtcMs(null)).toBeNull();
    expect(pktWallTimeToUtcMs(START_MS)).toBeNull();
  });

  it('compares entered wall clocks in one frame (end-after-start validation)', () => {
    // The create page rejects only endMs < startMs, both parsed here.
    const start = pktWallTimeToUtcMs('2026-10-25T10:00')!;
    const end = pktWallTimeToUtcMs('2026-10-25T12:00')!;
    expect(end < start).toBe(false);
    // Equal start/end is not "before" (matches the pre-fix `<` check).
    expect(pktWallTimeToUtcMs('2026-10-25T10:00')! < start).toBe(false);
    // A genuinely earlier end still compares as before.
    expect(pktWallTimeToUtcMs('2026-10-25T09:00')! < start).toBe(true);
    // End after midnight the next day is after a late start.
    expect(pktWallTimeToUtcMs('2026-10-26T01:00')! < pktWallTimeToUtcMs('2026-10-25T23:00')!).toBe(false);
  });
});

describe('utcMsToPktWallTime', () => {
  it('renders a UTC instant as the PKT wall time', () => {
    expect(utcMsToPktWallTime(START_MS)).toBe('2026-10-25T10:00');
    expect(utcMsToPktWallTime(END_MS)).toBe('2026-10-25T12:00');
  });

  it('renders PKT midnight on the PKT calendar date, not the UTC date', () => {
    expect(utcMsToPktWallTime(Date.UTC(2026, 9, 24, 19, 0))).toBe('2026-10-25T00:00');
  });

  it('appends seconds only when the instant carries them', () => {
    expect(utcMsToPktWallTime(START_MS + 30_000)).toBe('2026-10-25T10:00:30');
  });
});

describe('round trip: stored instant -> form value -> stored instant', () => {
  const cases: Array<[string, number]> = [
    ['guide-pass start', START_MS],
    ['guide-pass end', END_MS],
    ['PKT midnight', Date.UTC(2026, 9, 24, 19, 0)],
    ['PKT 23:59', Date.UTC(2026, 9, 25, 18, 59)],
    ['new year boundary', Date.UTC(2026, 11, 31, 19, 0)], // 2027-01-01 00:00 PKT
    ['legacy value with seconds', START_MS + 45_000],
  ];

  it.each(cases)('%s survives rehydrate -> submit unchanged', (_label, ms) => {
    const fieldValue = utcMsToPktWallTime(ms);
    expect(pktWallTimeToUtcMs(fieldValue)).toBe(ms);
  });

  it.each(cases)('%s is stable over repeated edit -> save cycles', (_label, ms) => {
    // The capacity-edit scenario: open the form, change an unrelated field,
    // submit the untouched date strings, reopen. N cycles, same instant.
    let current = ms;
    for (let i = 0; i < 3; i++) {
      const fieldValue = dateToPktWallTime({ seconds: current / 1000 });
      current = pktWallTimeToUtcMs(fieldValue)!;
    }
    expect(current).toBe(ms);
  });

  it('the wall-clock string the admin typed is the string the form reopens with', () => {
    // Create: typed '2026-10-25T10:00' -> stored START_MS.
    // Edit open: the field shows the same wall clock, not 00:00, not 05:00.
    expect(dateToPktWallTime({ seconds: START_MS / 1000 })).toBe('2026-10-25T10:00');
    expect(dateToPktWallTime(new Date(START_MS))).toBe('2026-10-25T10:00');
    expect(dateToPktWallTime(START_MS)).toBe('2026-10-25T10:00');
    expect(dateToPktWallTime(new Date(START_MS).toISOString())).toBe('2026-10-25T10:00');
    expect(dateToPktWallTime({ toDate: () => new Date(START_MS) })).toBe('2026-10-25T10:00');
  });
});

describe('eventInstantToMs / pktWallTimeToDate / empty values', () => {
  it('normalizes stored shapes and rejects junk', () => {
    expect(eventInstantToMs({ seconds: START_MS / 1000 })).toBe(START_MS);
    expect(eventInstantToMs({ toMillis: () => START_MS })).toBe(START_MS);
    expect(eventInstantToMs(undefined)).toBeNull();
    expect(eventInstantToMs('not a date')).toBeNull();
    expect(dateToPktWallTime(undefined)).toBe('');
    expect(dateToPktWallTime(null)).toBe('');
    expect(pktWallTimeToDate('')).toBeNull();
    expect(pktWallTimeToDate('2026-10-25T10:00')!.getTime()).toBe(START_MS);
  });
});

describe('formatEventInstantInPkt', () => {
  it('renders the entered wall clock for a Pakistan viewer', () => {
    expect(formatEventInstantInPkt({ seconds: START_MS / 1000 }, 'long'))
      .toBe('October 25, 2026 • 10:00 AM');
    expect(formatEventInstantInPkt({ seconds: END_MS / 1000 }, 'long'))
      .toBe('October 25, 2026 • 12:00 PM');
  });

  it('renders the ticket shape with weekday', () => {
    // 2026-10-25 is a Sunday.
    expect(formatEventInstantInPkt({ seconds: START_MS / 1000 }, 'weekdayLong'))
      .toBe('Sunday, October 25, 2026 • 10:00 AM');
    expect(formatEventInstantInPkt(undefined, 'weekdayLong')).toBeNull();
  });

  it('renders the admin shapes', () => {
    expect(formatEventInstantInPkt(START_MS, 'datePadded')).toBe('Oct 25, 2026');
    expect(formatEventInstantInPkt(START_MS, 'date')).toBe('Oct 25, 2026');
    expect(formatEventInstantInPkt(START_MS, 'dateTime24')).toBe('Oct 25, 2026 10:00');
    // PKT-midnight instant shows the PKT date (Oct 25), never Oct 24.
    expect(formatEventInstantInPkt(Date.UTC(2026, 9, 24, 19, 0), 'datePadded')).toBe('Oct 25, 2026');
    expect(formatEventInstantInPkt(Date.UTC(2026, 9, 24, 19, 0), 'dateTime24')).toBe('Oct 25, 2026 00:00');
  });

  it('returns null for missing/invalid values so callers use their fallback', () => {
    expect(formatEventInstantInPkt(undefined, 'long')).toBeNull();
    expect(formatEventInstantInPkt(null, 'date')).toBeNull();
    expect(formatEventInstantInPkt('junk', 'long')).toBeNull();
  });
});

describe('timezone independence', () => {
  const originalTz = process.env.TZ;
  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it.each(['Asia/Karachi', 'UTC', 'America/New_York', 'Pacific/Auckland'])(
    'round trip and rendering are identical under TZ=%s',
    (tz) => {
      process.env.TZ = tz;
      expect(pktWallTimeToUtcMs('2026-10-25T10:00')).toBe(START_MS);
      expect(utcMsToPktWallTime(START_MS)).toBe('2026-10-25T10:00');
      expect(formatEventInstantInPkt(START_MS, 'long')).toBe('October 25, 2026 • 10:00 AM');
      expect(formatEventInstantInPkt(START_MS, 'datePadded')).toBe('Oct 25, 2026');
    },
  );
});
