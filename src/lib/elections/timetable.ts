/**
 * Pure election timetable logic (spec Section 3.2).
 * No Firebase imports; all times are epoch millis.
 *
 * Rules (Procedure Manual Sec 7.1, 7.2, 7.4; Constitution / Calendar):
 * - timetable published no later than electionDay - 30 days (T-30);
 *   publication after that is accepted ONLY with a recorded late reason
 *   and the miss is flagged, never silently rewritten (spec 6.1 step 3).
 * - nominations open no later than electionDay - 21 days (default
 *   exactly electionDay - 21 days).
 * - nominations close no later than electionDay - 7 days (default
 *   exactly electionDay - 7 days).
 * - vetting deadline = nominationClose + 3 days (Sec 7.4).
 * - certificate deadline = count end + 24 hours (Sec 7.9).
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface TimetableMillis {
  electionDay: number;
  timetablePublishedAt: number | null;
  timetableLateReason: string | null;
  nominationOpenAt: number;
  nominationCloseAt: number;
  vettingDeadlineAt: number;
  candidateListDate: number;
  candidateListPublishedAt: number | null;
  pollOpenAt: number;
  pollCloseAt: number;
  challengeWindowClosesAt: number | null;
  certificateDeadlineAt: number | null;
}

export interface TimetableViolation {
  field: string;
  rule: string;
  message: string;
}

export interface TimetableValidation {
  valid: boolean;
  violations: TimetableViolation[];
  /** True when publication missed T-30 but a late reason was recorded. */
  publicationMissFlagged: boolean;
}

/**
 * Derive the default timetable for an election day. Poll hours default
 * to 09:00-17:00 UTC on election day; the certified-list date defaults
 * to the vetting deadline (the first moment certification can complete).
 */
export function deriveTimetable(electionDayMillis: number): TimetableMillis {
  const dayStart = startOfUtcDay(electionDayMillis);
  const nominationOpenAt = dayStart - 21 * DAY_MS;
  const nominationCloseAt = dayStart - 7 * DAY_MS;
  const vettingDeadlineAt = nominationCloseAt + 3 * DAY_MS;
  return {
    electionDay: dayStart,
    timetablePublishedAt: null,
    timetableLateReason: null,
    nominationOpenAt,
    nominationCloseAt,
    vettingDeadlineAt,
    candidateListDate: vettingDeadlineAt,
    candidateListPublishedAt: null,
    pollOpenAt: dayStart + 9 * 60 * 60 * 1000,
    pollCloseAt: dayStart + 17 * 60 * 60 * 1000,
    challengeWindowClosesAt: null,
    certificateDeadlineAt: null,
  };
}

export function startOfUtcDay(millis: number): number {
  const d = new Date(millis);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Latest lawful publication instant: electionDay - 30 days. */
export function timetablePublicationDeadline(electionDayMillis: number): number {
  return startOfUtcDay(electionDayMillis) - 30 * DAY_MS;
}

export function vettingDeadline(nominationCloseAtMillis: number): number {
  return nominationCloseAtMillis + 3 * DAY_MS;
}

export function certificateDeadline(countEndMillis: number): number {
  return countEndMillis + 24 * 60 * 60 * 1000;
}

/** DEFAULT (spec 12.2): challenge window is 7 days from declaration. */
export const CHALLENGE_WINDOW_MS = 7 * DAY_MS;

export function challengeWindowClose(declaredAtMillis: number): number {
  return declaredAtMillis + CHALLENGE_WINDOW_MS;
}

/**
 * Validate a timetable. `nowMillis` is the instant of validation (for
 * publication checks, pass the publication instant).
 */
export function validateTimetable(
  tt: TimetableMillis,
  opts: { publicationLateReason?: string | null } = {},
): TimetableValidation {
  const violations: TimetableViolation[] = [];
  const dayStart = startOfUtcDay(tt.electionDay);

  if (tt.nominationOpenAt > dayStart - 21 * DAY_MS) {
    violations.push({
      field: "nominationOpenAt",
      rule: "T-21",
      message: "Nominations must open no later than 21 days before election day.",
    });
  }
  if (tt.nominationCloseAt > dayStart - 7 * DAY_MS) {
    violations.push({
      field: "nominationCloseAt",
      rule: "T-7",
      message: "Nominations must close no later than 7 days before election day.",
    });
  }
  if (tt.nominationCloseAt <= tt.nominationOpenAt) {
    violations.push({
      field: "nominationCloseAt",
      rule: "window",
      message: "Nomination close must be after nomination open.",
    });
  }
  if (tt.vettingDeadlineAt !== tt.nominationCloseAt + 3 * DAY_MS) {
    violations.push({
      field: "vettingDeadlineAt",
      rule: "vetting+3d",
      message: "Vetting deadline must be nomination close plus 3 days (Sec 7.4).",
    });
  }
  if (tt.pollOpenAt < dayStart || tt.pollCloseAt <= tt.pollOpenAt) {
    violations.push({
      field: "pollOpenAt",
      rule: "poll-hours",
      message: "Poll must open on election day and close after it opens.",
    });
  }

  let publicationMissFlagged = false;
  if (tt.timetablePublishedAt !== null) {
    const deadline = timetablePublicationDeadline(tt.electionDay);
    if (tt.timetablePublishedAt > deadline) {
      const lateReason = opts.publicationLateReason ?? tt.timetableLateReason;
      if (lateReason && lateReason.trim().length > 0) {
        publicationMissFlagged = true;
      } else {
        violations.push({
          field: "timetablePublishedAt",
          rule: "T-30",
          message:
            "Timetable published after the T-30 deadline without a recorded late reason.",
        });
      }
    }
  }

  return { valid: violations.length === 0, violations, publicationMissFlagged };
}
