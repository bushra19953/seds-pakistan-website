/**
 * Notice periods and Business Day arithmetic (Phase 3, Meetings CORE).
 *
 * Pure module: no I/O, no Firebase / Firestore / Next imports. Importable by
 * client, server, and tests alike (meetings_core_interfaces.md section 0).
 *
 * Implements the binding contract in meetings_core_interfaces.md section 2b,
 * sourced from drafts/ws-a.md section 3.2 (Doc 07 secs 3.1 to 3.3, P-02):
 *
 * - Minimum notice per body type + meeting type (NOTICE_PERIODS below).
 * - Board emergency is 48 hours and ONLY for the Board, gated on a linked
 *   Consent record whose status is decided (granted | conditional in the
 *   Phase 2 consent system; this module never reads Consents itself, the
 *   caller passes the decided state in as `consentDecided`).
 * - An adjourned meeting inherits the original notice: no new period.
 * - Deemed receipt is the next Business Day in Asia/Karachi (PKT).
 *
 * Type locations (worktree reality vs contract section 2a): the contract
 * places BodyType and MeetingType in src/lib/governance/types.ts. BodyType
 * does live there; MeetingType currently lives in
 * src/lib/governance/meeting-lifecycle.ts (same string union, salvaged
 * worker 5). Both are imported as types only, so there is no runtime
 * dependency and no signature change.
 *
 * Consent-state encoding for validateNotice (contract section 2b input has
 * exactly one consent field, `consentDecided?: boolean`):
 * - undefined  = no Consent is linked to the meeting -> "consent_required".
 * - false      = a Consent is linked but not yet decided (pending, refused,
 *                or expired in Phase 2 terms) -> "consent_not_decided".
 * - true       = a Consent is linked and decided -> the gate passes and only
 *                the 48-hour timing check applies.
 * The field is ignored for every non-emergency meeting.
 *
 * Failure precedence in validateNotice (first match wins, so a caller never
 * has to guess which 422 to surface):
 *   emergency_board_only > consent_required > consent_not_decided
 *   > notice_too_short.
 * For consent failures, `earliestAllowed` still carries the time-based
 * earliest (noticeSentAt + 48h): consent is an additional gate on top of the
 * timing rule, not a replacement for it.
 *
 * Business Day (ws-a section 3.2): Monday to Friday in PKT, excluding dates
 * in the caller-supplied holiday list. The spec DOES specify the weekend
 * (Mon-Fri working week, so Saturday and Sunday are non-business); no
 * Fri/Sat-weekend assumption is made. v1 ships NO hardcoded Pakistan holiday
 * list: `holidays` defaults to [] and callers pass PKT calendar dates as
 * "YYYY-MM-DD" strings (settings/governance.holidays when present).
 *
 * Plain ASCII only. No em dashes.
 */

import type { BodyType } from './types';
import type { MeetingType } from './meeting-lifecycle';

export type { BodyType, MeetingType };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------
// Notice period table (contract section 2b / ws-a section 3.2)
// ---------------------------------------------------------------------------

export interface NoticeRule {
  bodyType: BodyType;
  meetingType: MeetingType;
  minDays: number | null;
  minHours: number | null;
}

function rule(
  bodyType: BodyType,
  meetingType: MeetingType,
  minDays: number | null,
  minHours: number | null = null,
): NoticeRule {
  return { bodyType, meetingType, minDays, minHours };
}

/**
 * Every bodyType x meetingType combination is listed explicitly so lookups
 * are total: a null/null entry means "no minimum period is defined for this
 * combination" (adjourned sittings inherit the original notice; board agm is
 * n/a because the Board does not hold the AGM; non-Board emergency is listed
 * null because it is rejected outright by validateNotice, never timed).
 */
export const NOTICE_PERIODS: readonly NoticeRule[] = [
  // Board of Governors: ordinary / special 14 days; emergency 48 hours.
  rule('board', 'ordinary', 14),
  rule('board', 'special', 14),
  rule('board', 'emergency', null, 48),
  rule('board', 'adjourned', null),
  rule('board', 'agm', null),
  // National Executive Council: ordinary / special 7 days.
  rule('nec', 'ordinary', 7),
  rule('nec', 'special', 7),
  rule('nec', 'emergency', null),
  rule('nec', 'adjourned', null),
  rule('nec', 'agm', null),
  // National Council: ordinary / special 7 days.
  rule('council', 'ordinary', 7),
  rule('council', 'special', 7),
  rule('council', 'emergency', null),
  rule('council', 'adjourned', null),
  rule('council', 'agm', null),
  // Council of Chapters: ordinary / special 7 days.
  rule('council_of_chapters', 'ordinary', 7),
  rule('council_of_chapters', 'special', 7),
  rule('council_of_chapters', 'emergency', null),
  rule('council_of_chapters', 'adjourned', null),
  rule('council_of_chapters', 'agm', null),
  // General Body: AGM 21 days; special meeting of Full Members 14 days.
  rule('general_body', 'agm', 21),
  rule('general_body', 'special', 14),
  rule('general_body', 'ordinary', null),
  rule('general_body', 'emergency', null),
  rule('general_body', 'adjourned', null),
  // Chapter Executive Committee: ordinary / special 5 days.
  rule('chapter_committee', 'ordinary', 5),
  rule('chapter_committee', 'special', 5),
  rule('chapter_committee', 'emergency', null),
  rule('chapter_committee', 'adjourned', null),
  rule('chapter_committee', 'agm', null),
];

/**
 * Minimum notice in milliseconds for a body + meeting type, or null when no
 * new period applies (adjourned / undefined combinations / non-Board
 * emergency, which validateNotice rejects before timing is considered).
 */
export function requiredNoticeMs(bodyType: BodyType, meetingType: MeetingType): number | null {
  const found = NOTICE_PERIODS.find((r) => r.bodyType === bodyType && r.meetingType === meetingType);
  if (!found) return null;
  if (found.minDays === null && found.minHours === null) return null;
  return (found.minDays ?? 0) * DAY_MS + (found.minHours ?? 0) * HOUR_MS;
}

/** Earliest a meeting of this kind may be scheduled if notice is sent at `now`. */
export function earliestSchedulableAt(
  bodyType: BodyType,
  meetingType: MeetingType,
  now: Date,
): Date | null {
  const required = requiredNoticeMs(bodyType, meetingType);
  if (required === null) return null;
  return new Date(now.getTime() + required);
}

// ---------------------------------------------------------------------------
// Notice validation (contract section 2b)
// ---------------------------------------------------------------------------

export type ValidateNoticeResult =
  | { ok: true }
  | {
      ok: false;
      error_code: 'notice_too_short' | 'consent_required' | 'consent_not_decided' | 'emergency_board_only';
      earliestAllowed: Date | null;
    };

export function validateNotice(input: {
  bodyType: BodyType;
  meetingType: MeetingType;
  scheduledAt: Date;
  noticeSentAt: Date;
  consentDecided?: boolean;
}): ValidateNoticeResult {
  const { bodyType, meetingType, scheduledAt, noticeSentAt } = input;

  // An adjourned sitting reconvenes under the original notice (ws-a 3.2):
  // no new period is ever enforced for it, for any body.
  if (meetingType === 'adjourned') return { ok: true };

  // Emergency meetings exist only for the Board (ws-a 3.2 / contract 2b).
  if (meetingType === 'emergency' && bodyType !== 'board') {
    return { ok: false, error_code: 'emergency_board_only', earliestAllowed: null };
  }

  const required = requiredNoticeMs(bodyType, meetingType);
  const earliestAllowed = required === null ? null : new Date(noticeSentAt.getTime() + required);

  // Board emergency Consent gate (checked before timing; see header for the
  // consentDecided encoding and the precedence rationale).
  if (bodyType === 'board' && meetingType === 'emergency') {
    if (input.consentDecided === undefined) {
      return { ok: false, error_code: 'consent_required', earliestAllowed };
    }
    if (input.consentDecided === false) {
      return { ok: false, error_code: 'consent_not_decided', earliestAllowed };
    }
  }

  if (required === null) return { ok: true };

  // Exactly at the minimum is allowed; strictly before it is not.
  if (scheduledAt.getTime() < noticeSentAt.getTime() + required) {
    return { ok: false, error_code: 'notice_too_short', earliestAllowed };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Business Days in Asia/Karachi (contract section 2b / ws-a section 3.2)
// ---------------------------------------------------------------------------

const PKT_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Karachi',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

interface PktCalendarDay {
  /** PKT calendar date key, "YYYY-MM-DD". Holiday lists use this format. */
  key: string;
  /** Day of week of the PKT calendar date: 0 = Sunday ... 6 = Saturday. */
  weekday: number;
}

function pktCalendarDay(date: Date): PktCalendarDay {
  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of PKT_FORMAT.formatToParts(date)) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
  }
  const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Weekday of that calendar date (computed in UTC so the host timezone and
  // DST can never shift it).
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { key, weekday };
}

/** True when the PKT calendar day of `datePKT` is Mon-Fri and not a holiday. */
export function isBusinessDay(datePKT: Date, holidays: string[] = []): boolean {
  const { key, weekday } = pktCalendarDay(datePKT);
  if (weekday === 0 || weekday === 6) return false; // Sunday / Saturday
  return !holidays.includes(key);
}

/**
 * The next Business Day strictly after the PKT calendar day of `datePKT`,
 * preserving the time of day. PKT is fixed at UTC+5 with no DST, so stepping
 * by exactly 24 hours always lands on the same PKT time the next PKT day.
 */
export function nextBusinessDay(datePKT: Date, holidays: string[] = []): Date {
  let candidate = new Date(datePKT.getTime() + DAY_MS);
  while (!isBusinessDay(candidate, holidays)) {
    candidate = new Date(candidate.getTime() + DAY_MS);
  }
  return candidate;
}

/**
 * `datePKT` moved by `days` Business Days (forward for positive, backward
 * for negative). Adding 0 returns a copy of the input unchanged, even when
 * it falls on a non-business day.
 */
export function addBusinessDays(datePKT: Date, days: number, holidays: string[] = []): Date {
  let result = new Date(datePKT.getTime());
  if (days === 0) return result;
  const stepMs = days > 0 ? DAY_MS : -DAY_MS;
  let remaining = Math.abs(days);
  while (remaining > 0) {
    result = new Date(result.getTime() + stepMs);
    if (isBusinessDay(result, holidays)) remaining -= 1;
  }
  return result;
}

/**
 * Deemed receipt of a notice (ws-a 3.2): the next Business Day in PKT after
 * the notice was sent.
 */
export function deemedReceivedAt(noticeSentAt: Date, holidays: string[] = []): Date {
  return nextBusinessDay(noticeSentAt, holidays);
}
