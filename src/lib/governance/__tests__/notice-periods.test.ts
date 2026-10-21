/**
 * Tests for src/lib/governance/notice-periods.ts
 * Spec: meetings_core_interfaces.md section 2b (ws-a section 3.2).
 *
 * Fixed dates only (no reliance on today). All timestamps are given with an
 * explicit +05:00 (PKT) offset so the PKT calendar day is unambiguous on any
 * host timezone.
 *
 * Calendar anchors used below (verified):
 *   2026-10-16 Friday, 2026-10-17 Saturday, 2026-10-18 Sunday,
 *   2026-10-19 Monday, 2026-10-20 Tuesday, 2026-10-21 Wednesday,
 *   2026-10-22 Thursday, 2026-10-23 Friday, 2026-10-26 Monday.
 * The module's weekend definition is Saturday + Sunday
 * (business days are Monday to Friday in PKT).
 */
import {
  NOTICE_PERIODS,
  addBusinessDays,
  deemedReceivedAt,
  earliestSchedulableAt,
  isBusinessDay,
  nextBusinessDay,
  requiredNoticeMs,
  validateNotice,
  type BodyType,
  type MeetingType,
} from '../notice-periods';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** PKT timestamp helper: pkt('2026-10-16', '10:00') */
function pkt(date: string, time = '10:00'): Date {
  return new Date(`${date}T${time}:00+05:00`);
}

// ---------------------------------------------------------------------------
// NOTICE_PERIODS table + requiredNoticeMs: every row
// ---------------------------------------------------------------------------

// [bodyType, meetingType, expectedMs] for all 30 rows in the table.
const EXPECTED: Array<[BodyType, MeetingType, number | null]> = [
  // Board of Governors: ordinary / special 14 days; emergency 48 hours.
  ['board', 'ordinary', 14 * DAY_MS],
  ['board', 'special', 14 * DAY_MS],
  ['board', 'emergency', 48 * HOUR_MS],
  ['board', 'adjourned', null], // inherits the original notice, no new period
  ['board', 'agm', null],
  // National Executive Council: ordinary / special 7 days.
  ['nec', 'ordinary', 7 * DAY_MS],
  ['nec', 'special', 7 * DAY_MS],
  ['nec', 'emergency', null],
  ['nec', 'adjourned', null],
  ['nec', 'agm', null],
  // National Council: ordinary / special 7 days.
  ['council', 'ordinary', 7 * DAY_MS],
  ['council', 'special', 7 * DAY_MS],
  ['council', 'emergency', null],
  ['council', 'adjourned', null],
  ['council', 'agm', null],
  // Council of Chapters: ordinary / special 7 days.
  ['council_of_chapters', 'ordinary', 7 * DAY_MS],
  ['council_of_chapters', 'special', 7 * DAY_MS],
  ['council_of_chapters', 'emergency', null],
  ['council_of_chapters', 'adjourned', null],
  ['council_of_chapters', 'agm', null],
  // General Body: AGM 21 days; special meeting of Full Members 14 days.
  ['general_body', 'agm', 21 * DAY_MS],
  ['general_body', 'special', 14 * DAY_MS],
  ['general_body', 'ordinary', null],
  ['general_body', 'emergency', null],
  ['general_body', 'adjourned', null],
  // Chapter Executive Committee: ordinary / special 5 days.
  ['chapter_committee', 'ordinary', 5 * DAY_MS],
  ['chapter_committee', 'special', 5 * DAY_MS],
  ['chapter_committee', 'emergency', null],
  ['chapter_committee', 'adjourned', null],
  ['chapter_committee', 'agm', null],
];

describe('NOTICE_PERIODS / requiredNoticeMs', () => {
  it('the table lists every bodyType x meetingType combination exactly once (30 rows)', () => {
    expect(NOTICE_PERIODS).toHaveLength(30);
    const keys = NOTICE_PERIODS.map((r) => `${r.bodyType}:${r.meetingType}`);
    expect(new Set(keys).size).toBe(30);
    for (const [bodyType, meetingType] of EXPECTED) {
      expect(keys).toContain(`${bodyType}:${meetingType}`);
    }
  });

  it.each(EXPECTED)('%s / %s resolves via requiredNoticeMs to %s ms', (bodyType, meetingType, expectedMs) => {
    expect(requiredNoticeMs(bodyType, meetingType)).toBe(expectedMs);
  });

  it('the raw table rows carry the same periods in days / hours form', () => {
    const row = (b: BodyType, m: MeetingType) =>
      NOTICE_PERIODS.find((r) => r.bodyType === b && r.meetingType === m);
    expect(row('board', 'ordinary')).toMatchObject({ minDays: 14, minHours: null });
    expect(row('board', 'emergency')).toMatchObject({ minDays: null, minHours: 48 });
    // Board adjourned: null / null = inherits the original notice.
    expect(row('board', 'adjourned')).toMatchObject({ minDays: null, minHours: null });
    expect(row('general_body', 'agm')).toMatchObject({ minDays: 21, minHours: null });
    expect(row('general_body', 'special')).toMatchObject({ minDays: 14, minHours: null });
    expect(row('chapter_committee', 'ordinary')).toMatchObject({ minDays: 5, minHours: null });
    expect(row('nec', 'special')).toMatchObject({ minDays: 7, minHours: null });
  });

  it('earliestSchedulableAt adds the required period, and is null when no period applies', () => {
    const now = pkt('2026-10-01', '09:00');
    expect(earliestSchedulableAt('board', 'ordinary', now)?.getTime()).toBe(pkt('2026-10-15', '09:00').getTime());
    expect(earliestSchedulableAt('board', 'emergency', now)?.getTime()).toBe(pkt('2026-10-03', '09:00').getTime());
    expect(earliestSchedulableAt('general_body', 'agm', now)?.getTime()).toBe(pkt('2026-10-22', '09:00').getTime());
    expect(earliestSchedulableAt('chapter_committee', 'special', now)?.getTime()).toBe(pkt('2026-10-06', '09:00').getTime());
    // Adjourned inherits: no earliest date is produced.
    expect(earliestSchedulableAt('board', 'adjourned', now)).toBeNull();
    expect(earliestSchedulableAt('nec', 'adjourned', now)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateNotice
// ---------------------------------------------------------------------------

describe('validateNotice', () => {
  const sent = pkt('2026-10-01', '09:00'); // notice sent Thu 2026-10-01 09:00 PKT

  it('too-short notice -> notice_too_short with the correct earliestAllowed', () => {
    // NEC ordinary needs 7 days: earliest is 2026-10-08 09:00 PKT.
    const r = validateNotice({
      bodyType: 'nec',
      meetingType: 'ordinary',
      noticeSentAt: sent,
      scheduledAt: pkt('2026-10-07', '09:00'),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error_code).toBe('notice_too_short');
      expect(r.earliestAllowed?.getTime()).toBe(pkt('2026-10-08', '09:00').getTime());
    }
  });

  it('one millisecond before the minimum is still too short', () => {
    const earliest = pkt('2026-10-08', '09:00');
    const r = validateNotice({
      bodyType: 'nec',
      meetingType: 'ordinary',
      noticeSentAt: sent,
      scheduledAt: new Date(earliest.getTime() - 1),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe('notice_too_short');
  });

  it('exactly at the minimum is allowed', () => {
    expect(
      validateNotice({
        bodyType: 'nec',
        meetingType: 'ordinary',
        noticeSentAt: sent,
        scheduledAt: pkt('2026-10-08', '09:00'), // exactly sent + 7 days
      }),
    ).toEqual({ ok: true });
    expect(
      validateNotice({
        bodyType: 'general_body',
        meetingType: 'agm',
        noticeSentAt: sent,
        scheduledAt: pkt('2026-10-22', '09:00'), // exactly sent + 21 days
      }),
    ).toEqual({ ok: true });
    expect(
      validateNotice({
        bodyType: 'chapter_committee',
        meetingType: 'ordinary',
        noticeSentAt: sent,
        scheduledAt: pkt('2026-10-06', '09:00'), // exactly sent + 5 days
      }),
    ).toEqual({ ok: true });
  });

  it('after the minimum is allowed', () => {
    expect(
      validateNotice({
        bodyType: 'council',
        meetingType: 'special',
        noticeSentAt: sent,
        scheduledAt: pkt('2026-10-20', '09:00'),
      }),
    ).toEqual({ ok: true });
  });

  it('non-emergency Board meeting inside the ordinary 14-day period -> notice_too_short', () => {
    // Board ordinary / special need 14 days: earliest is 2026-10-15 09:00 PKT.
    for (const meetingType of ['ordinary', 'special'] as const) {
      const r = validateNotice({
        bodyType: 'board',
        meetingType,
        noticeSentAt: sent,
        scheduledAt: pkt('2026-10-10', '09:00'),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error_code).toBe('notice_too_short');
        expect(r.earliestAllowed?.getTime()).toBe(pkt('2026-10-15', '09:00').getTime());
      }
    }
  });

  it('adjourned sittings inherit the original notice: always ok, even reconvening immediately', () => {
    for (const bodyType of ['board', 'nec', 'general_body'] as const) {
      expect(
        validateNotice({
          bodyType,
          meetingType: 'adjourned',
          noticeSentAt: sent,
          scheduledAt: sent, // zero new notice at all
        }),
      ).toEqual({ ok: true });
    }
  });

  describe('Board emergency at 48 hours', () => {
    const at48h = pkt('2026-10-03', '09:00'); // exactly sent + 48h

    it('no consent linked (consentDecided undefined) -> consent_required', () => {
      const r = validateNotice({
        bodyType: 'board',
        meetingType: 'emergency',
        noticeSentAt: sent,
        scheduledAt: at48h,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error_code).toBe('consent_required');
        // earliestAllowed still carries the time-based earliest (sent + 48h).
        expect(r.earliestAllowed?.getTime()).toBe(at48h.getTime());
      }
    });

    it('consent linked but not decided (consentDecided false) -> consent_not_decided', () => {
      const r = validateNotice({
        bodyType: 'board',
        meetingType: 'emergency',
        noticeSentAt: sent,
        scheduledAt: at48h,
        consentDecided: false,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error_code).toBe('consent_not_decided');
        expect(r.earliestAllowed?.getTime()).toBe(at48h.getTime());
      }
    });

    it('decided consent at exactly 48 hours -> ok', () => {
      expect(
        validateNotice({
          bodyType: 'board',
          meetingType: 'emergency',
          noticeSentAt: sent,
          scheduledAt: at48h,
          consentDecided: true,
        }),
      ).toEqual({ ok: true });
    });

    it('decided consent but scheduled before 48 hours -> notice_too_short', () => {
      const r = validateNotice({
        bodyType: 'board',
        meetingType: 'emergency',
        noticeSentAt: sent,
        scheduledAt: pkt('2026-10-02', '09:00'), // only 24h
        consentDecided: true,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error_code).toBe('notice_too_short');
        expect(r.earliestAllowed?.getTime()).toBe(at48h.getTime());
      }
    });

    it('consent gate takes precedence over timing: no consent + too short -> consent_required', () => {
      const r = validateNotice({
        bodyType: 'board',
        meetingType: 'emergency',
        noticeSentAt: sent,
        scheduledAt: pkt('2026-10-02', '09:00'),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error_code).toBe('consent_required');
    });
  });

  it('emergency for a non-Board body -> emergency_board_only (all other bodies)', () => {
    for (const bodyType of ['nec', 'council', 'council_of_chapters', 'general_body', 'chapter_committee'] as const) {
      const r = validateNotice({
        bodyType,
        meetingType: 'emergency',
        noticeSentAt: sent,
        // Far in the future and with decided consent: still rejected outright.
        scheduledAt: pkt('2026-11-01', '09:00'),
        consentDecided: true,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error_code).toBe('emergency_board_only');
        expect(r.earliestAllowed).toBeNull();
      }
    }
  });

  it('emergency_board_only takes precedence over the consent gate for non-Board bodies', () => {
    const r = validateNotice({
      bodyType: 'nec',
      meetingType: 'emergency',
      noticeSentAt: sent,
      scheduledAt: pkt('2026-10-03', '09:00'),
      // no consentDecided: would be consent_required if the Board gate applied
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe('emergency_board_only');
  });

  it('consentDecided is ignored for non-emergency meetings', () => {
    expect(
      validateNotice({
        bodyType: 'board',
        meetingType: 'ordinary',
        noticeSentAt: sent,
        scheduledAt: pkt('2026-10-15', '09:00'), // exactly 14 days
        consentDecided: false,
      }),
    ).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Business days in PKT (weekend = Saturday + Sunday, per the module)
// ---------------------------------------------------------------------------

describe('isBusinessDay / nextBusinessDay', () => {
  it('Monday to Friday are business days; Saturday and Sunday are not', () => {
    expect(isBusinessDay(pkt('2026-10-16'))).toBe(true); // Friday
    expect(isBusinessDay(pkt('2026-10-17'))).toBe(false); // Saturday
    expect(isBusinessDay(pkt('2026-10-18'))).toBe(false); // Sunday
    expect(isBusinessDay(pkt('2026-10-19'))).toBe(true); // Monday
    expect(isBusinessDay(pkt('2026-10-20'))).toBe(true); // Tuesday
    expect(isBusinessDay(pkt('2026-10-21'))).toBe(true); // Wednesday
    expect(isBusinessDay(pkt('2026-10-22'))).toBe(true); // Thursday
  });

  it('the PKT calendar day decides, not the UTC / host day', () => {
    // 2026-10-16T23:30Z is already Saturday 2026-10-17 04:30 in PKT.
    expect(isBusinessDay(new Date('2026-10-16T23:30:00Z'))).toBe(false);
    // 2026-10-19T01:00Z is Monday 2026-10-19 06:00 in PKT.
    expect(isBusinessDay(new Date('2026-10-19T01:00:00Z'))).toBe(true);
  });

  it('a weekday in the holiday list is not a business day', () => {
    expect(isBusinessDay(pkt('2026-10-19'), ['2026-10-19'])).toBe(false); // Monday holiday
    expect(isBusinessDay(pkt('2026-10-19'), ['2026-10-20'])).toBe(true); // different day listed
    expect(isBusinessDay(pkt('2026-10-19'))).toBe(true); // default list is empty
  });

  it('nextBusinessDay is strictly the next day when it is a business day, preserving time of day', () => {
    expect(nextBusinessDay(pkt('2026-10-15', '09:30')).getTime()).toBe(pkt('2026-10-16', '09:30').getTime()); // Thu -> Fri
    expect(nextBusinessDay(pkt('2026-10-19', '09:30')).getTime()).toBe(pkt('2026-10-20', '09:30').getTime()); // Mon -> Tue
  });

  it('nextBusinessDay skips the Saturday / Sunday weekend', () => {
    expect(nextBusinessDay(pkt('2026-10-16')).getTime()).toBe(pkt('2026-10-19').getTime()); // Fri -> Mon
    expect(nextBusinessDay(pkt('2026-10-17')).getTime()).toBe(pkt('2026-10-19').getTime()); // Sat -> Mon
    expect(nextBusinessDay(pkt('2026-10-18')).getTime()).toBe(pkt('2026-10-19').getTime()); // Sun -> Mon
  });

  it('nextBusinessDay skips holidays as well as weekends', () => {
    // Friday -> Monday is a holiday -> Tuesday.
    expect(nextBusinessDay(pkt('2026-10-16'), ['2026-10-19']).getTime()).toBe(pkt('2026-10-20').getTime());
  });
});

describe('addBusinessDays', () => {
  it('adds business days across a weekend: Friday + 1 = Monday, Friday + 3 = Wednesday', () => {
    const fri = pkt('2026-10-16', '11:00');
    expect(addBusinessDays(fri, 1).getTime()).toBe(pkt('2026-10-19', '11:00').getTime());
    expect(addBusinessDays(fri, 3).getTime()).toBe(pkt('2026-10-21', '11:00').getTime());
    expect(addBusinessDays(fri, 5).getTime()).toBe(pkt('2026-10-23', '11:00').getTime()); // the following Friday
  });

  it('counts forward from a weekday without touching the weekend', () => {
    expect(addBusinessDays(pkt('2026-10-19'), 2).getTime()).toBe(pkt('2026-10-21').getTime()); // Mon + 2 = Wed
  });

  it('skips holidays while adding', () => {
    // Friday + 1 with Monday a holiday lands on Tuesday.
    expect(addBusinessDays(pkt('2026-10-16'), 1, ['2026-10-19']).getTime()).toBe(pkt('2026-10-20').getTime());
  });

  it('adding 0 returns the same instant, even on a non-business day', () => {
    const sat = pkt('2026-10-17', '08:00');
    const r = addBusinessDays(sat, 0);
    expect(r.getTime()).toBe(sat.getTime());
    expect(r).not.toBe(sat); // a copy, not the same object
  });

  it('negative counts move backward across a weekend: Monday - 1 = Friday', () => {
    expect(addBusinessDays(pkt('2026-10-19'), -1).getTime()).toBe(pkt('2026-10-16').getTime());
    expect(addBusinessDays(pkt('2026-10-21'), -3).getTime()).toBe(pkt('2026-10-16').getTime()); // Wed - 3 = Fri before
  });
});

// ---------------------------------------------------------------------------
// deemedReceivedAt = next business day in PKT
// ---------------------------------------------------------------------------

describe('deemedReceivedAt', () => {
  it('a notice sent on Friday is deemed received on the next business day (Monday)', () => {
    const sentAt = pkt('2026-10-16', '15:45'); // Friday
    const received = deemedReceivedAt(sentAt);
    expect(received.getTime()).toBe(pkt('2026-10-19', '15:45').getTime()); // Monday, same time
    expect(received.getTime()).toBe(nextBusinessDay(sentAt).getTime());
  });

  it('a notice sent on a weekday is deemed received the next business day', () => {
    expect(deemedReceivedAt(pkt('2026-10-20', '09:00')).getTime()).toBe(pkt('2026-10-21', '09:00').getTime()); // Tue -> Wed
    expect(deemedReceivedAt(pkt('2026-10-17', '09:00')).getTime()).toBe(pkt('2026-10-19', '09:00').getTime()); // Sat -> Mon
  });

  it('a holiday on the next business day pushes deemed receipt past it', () => {
    // Sent Friday; Monday 2026-10-19 is a holiday, so deemed received Tuesday.
    expect(deemedReceivedAt(pkt('2026-10-16', '12:00'), ['2026-10-19']).getTime()).toBe(
      pkt('2026-10-20', '12:00').getTime(),
    );
    // Sent Wednesday; Thursday 2026-10-22 is a holiday, so deemed received Friday.
    expect(deemedReceivedAt(pkt('2026-10-21', '12:00'), ['2026-10-22']).getTime()).toBe(
      pkt('2026-10-23', '12:00').getTime(),
    );
  });
});
