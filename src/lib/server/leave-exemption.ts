/**
 * leave-exemption.ts
 *
 * Shared deadline-penalty exemption helper for approved leave.
 *
 * Target location in the repo: src/lib/server/leave-exemption.ts
 *
 * Pure function. No Firestore reads, no network, no side effects.
 * Fully unit-testable: both callers (the check-deadlines cron and the
 * gamification late-penalty transaction) call this one rule so the
 * two penalty paths cannot drift apart.
 *
 * Rule: a user is exempt from a deadline penalty for a task ONLY when
 *   (a) the user is flagged on vacation: isOnVacation === true OR
 *       vacationMode === true, AND
 *   (b) the task deadline falls inside the approved leave window:
 *       vacationStartDate <= deadline <= vacationEndDate
 *       where deadline = taskData.individualDeadline || taskData.deadline.
 *
 * There is NO leaveHold logic in this helper. Step 3 (redirect-out /
 * leaveHold) was skipped for the leave MVP, so this helper does not
 * read leaveHold, leaveHoldReason, or redirectedLeaveRequestId. A task
 * with leaveHold: true is NOT exempt by this helper unless the flag
 * plus window rule above is also satisfied.
 *
 * nowMs is accepted for caller compatibility (cron and gamification
 * callers already pass "now") but is intentionally NOT used. Exemption
 * depends only on the deadline versus the leave window, not on the
 * current time, so a task whose deadline fell inside an approved leave
 * stays exempt when it is evaluated after the member returns.
 *
 * Malformed inputs never throw. Any input this helper cannot evaluate
 * returns { exempt: false } with a clear reason.
 *
 * Timezone: Asia/Karachi (UTC+5, no daylight saving). Date-only
 * vacation bounds are interpreted as Karachi wall time: a date-only
 * start means 00:00:00.000 Karachi, a date-only end means
 * 23:59:59.999 Karachi. A date-only deadline means 23:59:59.999
 * Karachi (a deadline on a date is due by the end of that date).
 * Datetimes without an explicit offset (for example
 * "2026-10-20T10:00:00") are also read as Karachi wall time.
 * Datetimes with an explicit offset or Z are absolute instants and
 * are used as-is.
 *
 * No em dashes used in this file by convention.
 */

export type LeaveExemptionResult = {
  exempt: boolean;
  reason: string;
  leaveRequestId?: string;
};

/** Asia/Karachi is UTC+5 all year. No daylight saving. */
const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

type DateRole = "start" | "end" | "deadline";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function isValidDateParts(
  year: number,
  month: number,
  day: number,
): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * Convert a YYYY-MM-DD date-only value to ms.
 * Role decides which end of the Karachi day it means.
 */
function parseDateOnlyToMs(value: string, role: DateRole): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidDateParts(year, month, day)) {
    return null;
  }
  const utcMidnight = Date.UTC(year, month - 1, day);
  if (role === "start") {
    // 00:00:00.000 Karachi = UTC midnight minus 5h.
    return utcMidnight - KARACHI_OFFSET_MS;
  }
  // "end" and "deadline": 23:59:59.999 Karachi.
  return utcMidnight + MS_PER_DAY - 1 - KARACHI_OFFSET_MS;
}

/**
 * Parse a datetime string with no offset (for example
 * "2026-10-20T10:00:00" or "2026-10-20 10:00:00.500") as Karachi
 * wall time. Returns null when the string does not match this shape.
 */
function parseNaiveDateTimeAsKarachi(value: string): number | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/.exec(
      value,
    );
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const fraction = match[7] === undefined ? 0 : Number(match[7].padEnd(3, "0").slice(0, 3));
  if (!isValidDateParts(year, month, day)) {
    return null;
  }
  if (hour > 23 || minute > 59 || second > 60) {
    return null;
  }
  const utcAsIfUtc = Date.UTC(year, month - 1, day, hour, minute, second, fraction);
  const probe = new Date(utcAsIfUtc);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    probe.getUTCHours() !== hour ||
    probe.getUTCMinutes() !== minute
  ) {
    return null;
  }
  return utcAsIfUtc - KARACHI_OFFSET_MS;
}

/**
 * Parse one date/time value to epoch ms, or null when it cannot be
 * parsed. Accepted shapes: Firestore Timestamp (an object with a
 * toDate() function, or seconds/nanoseconds fields), Date, ISO
 * string, YYYY-MM-DD string, numeric string holding ms, or number ms.
 */
function parseToMs(value: unknown, role: DateRole): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return null;
    }
    // Date-only: role decides start-of-day vs end-of-day.
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return parseDateOnlyToMs(trimmed, role);
    }
    // A bare integer string is epoch ms.
    if (/^-?\d+$/.test(trimmed)) {
      const ms = Number(trimmed);
      return Number.isFinite(ms) ? ms : null;
    }
    // Datetime with an explicit offset or Z is an absolute instant.
    if (/([+-]\d{2}:?\d{2}|Z)$/.test(trimmed)) {
      const ms = Date.parse(trimmed);
      return Number.isFinite(ms) ? ms : null;
    }
    // Naive datetime (no offset) means Karachi wall time.
    const karachiMs = parseNaiveDateTimeAsKarachi(trimmed);
    if (karachiMs !== null) {
      return karachiMs;
    }
    // Last resort: let Date.parse handle any other recognised shape.
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? ms : null;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Firestore Timestamp: prefer toDate(), fall back to seconds.
    if (typeof obj.toDate === "function") {
      try {
        const asDate = (obj.toDate as () => unknown)();
        if (asDate instanceof Date) {
          const ms = asDate.getTime();
          return Number.isFinite(ms) ? ms : null;
        }
      } catch {
        return null;
      }
    }
    const seconds =
      typeof obj.seconds === "number"
        ? obj.seconds
        : typeof obj._seconds === "number"
          ? obj._seconds
          : null;
    if (seconds !== null && Number.isFinite(seconds)) {
      const nanos =
        typeof obj.nanoseconds === "number"
          ? obj.nanoseconds
          : typeof obj._nanoseconds === "number"
            ? obj._nanoseconds
            : 0;
      const extraMs =
        Number.isFinite(nanos) && nanos > 0 ? Math.floor(nanos / 1e6) : 0;
      return seconds * 1000 + extraMs;
    }
    return null;
  }

  return null;
}

/**
 * True when the user is exempt from the deadline penalty for this task.
 *
 * Inputs are plain objects (typed as any at the call sites, because
 * callers pass raw Firestore user/task docs). Never throws.
 */
export function isExemptFromDeadlinePenalty(
  userData: any,
  taskData: any,
  nowMs?: unknown,
): LeaveExemptionResult {
  // nowMs is accepted for caller compatibility and intentionally unused.
  // Exemption depends only on deadline vs leave window, not on now.
  void nowMs;

  try {
    if (!isPlainObject(userData)) {
      return {
        exempt: false,
        reason: "Invalid input: userData is missing or not an object.",
      };
    }
    if (!isPlainObject(taskData)) {
      return {
        exempt: false,
        reason: "Invalid input: taskData is missing or not an object.",
      };
    }

    // Strict boolean check. Truthy lookalikes such as "true", 1, or
    // "yes" do NOT count: only a real true flag exempts.
    const onVacation =
      userData.isOnVacation === true || userData.vacationMode === true;
    if (!onVacation) {
      return {
        exempt: false,
        reason:
          "User is not on vacation: neither isOnVacation nor vacationMode is true.",
      };
    }

    const windowStartMs = parseToMs(userData.vacationStartDate, "start");
    const windowEndMs = parseToMs(userData.vacationEndDate, "end");
    if (windowStartMs === null || windowEndMs === null) {
      return {
        exempt: false,
        reason:
          "No approved leave window: vacationStartDate or vacationEndDate is missing or invalid.",
      };
    }
    if (windowStartMs > windowEndMs) {
      return {
        exempt: false,
        reason:
          "Leave window is invalid: vacationStartDate is after vacationEndDate.",
      };
    }

    const deadlineRaw =
      (taskData as Record<string, unknown>).individualDeadline ||
      (taskData as Record<string, unknown>).deadline;
    const deadlineMs = parseToMs(deadlineRaw, "deadline");
    if (deadlineMs === null) {
      return {
        exempt: false,
        reason:
          "No usable deadline: task has no individualDeadline or deadline, or the deadline is invalid.",
      };
    }

    if (deadlineMs < windowStartMs) {
      return {
        exempt: false,
        reason: "Deadline is before the approved leave window.",
      };
    }
    if (deadlineMs > windowEndMs) {
      return {
        exempt: false,
        reason: "Deadline is after the approved leave window.",
      };
    }

    const result: LeaveExemptionResult = {
      exempt: true,
      reason: "Exempt: deadline falls inside the approved leave window.",
    };
    if (
      typeof userData.leaveRequestId === "string" &&
      userData.leaveRequestId.trim() !== ""
    ) {
      result.leaveRequestId = userData.leaveRequestId.trim();
    }
    return result;
  } catch {
    return {
      exempt: false,
      reason: "Invalid input: exemption could not be evaluated.",
    };
  }
}
