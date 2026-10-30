/**
 * leave-exemption.ts
 *
 * Shared deadline-penalty exemption helper for approved leave.
 *
 * Target location in the repo: src/lib/server/leave-exemption.ts
 *
 * Both penalty paths (the check-deadlines cron and the gamification
 * late-penalty transaction) call this one rule so they cannot drift
 * apart.
 *
 * Rule: a user is exempt from a deadline penalty for a task ONLY when
 * an APPROVED leave record covers the task deadline:
 *   - the record lives in the Firestore `leave_requests` collection,
 *   - it belongs to the assignee (`userId == uid`),
 *   - its status means the leave was granted: `approved` (leave
 *     granted, possibly still running) or `completed` (leave granted
 *     and since ended, normally by the member returning), AND
 *   - record.startDate <= deadline <= record.endDate, where
 *     deadline = taskData.individualDeadline || taskData.deadline.
 *
 * The exemption is judged from the leave RECORDS, never from the
 * member's live user-doc flags. Returning from leave clears
 * `isOnVacation` / `vacationMode` and the stamped window on the user
 * doc, but it does not un-grant the leave: a deadline that fell
 * inside an approved leave window stays exempt when it is evaluated
 * after the member returns. (An earlier version of this helper read
 * the live flags plus the stamped window, so the first cron run
 * after a return re-evaluated in-window deadlines with the flag off
 * and recorded the miss after all. The records are the source of
 * truth; the flags are only a display/assignment gate.)
 *
 * Reads: exactly one bounded query per evaluation:
 *   leave_requests where userId == uid
 *                  and status in ('approved', 'completed')
 *                  limit 100
 * backed by the (userId, status) composite index. No other reads.
 *
 * RBT2-B4: leave is Supabase-PRIMARY, so the bounded query is issued
 * seam-first through the leave seam (hr-leave tryListLeaveRequests)
 * with the identical where/limit; the Firestore query above runs only
 * when the seam is disabled or errors. Before this, the helper read
 * Firestore unconditionally even though every other leave surface
 * treats Supabase as primary (a consistency bug as well as a read
 * cost: a leave granted on the primary could be invisible here).
 *
 * There is NO leaveHold logic in this helper. Step 3 (redirect-out /
 * leaveHold) was skipped for the leave MVP, so this helper does not
 * read leaveHold, leaveHoldReason, or redirectedLeaveRequestId. A
 * task with leaveHold: true is NOT exempt by this helper unless an
 * approved leave record covers its deadline under the rule above.
 *
 * nowMs is accepted for caller compatibility (cron and gamification
 * callers already pass "now") but is intentionally NOT used.
 * Exemption depends only on the deadline versus the granted leave
 * windows, not on the current time.
 *
 * Malformed inputs never throw. Any input this helper cannot
 * evaluate (missing uid, unusable task deadline, a failed query)
 * returns { exempt: false } with a clear reason.
 *
 * Timezone: Asia/Karachi (UTC+5, no daylight saving). Date-only
 * leave bounds are interpreted as Karachi wall time: a date-only
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

import { tryListLeaveRequests } from "@/lib/supa-seams/hr-leave";

export type LeaveExemptionResult = {
  exempt: boolean;
  reason: string;
  leaveRequestId?: string;
};

/** Asia/Karachi is UTC+5 all year. No daylight saving. */
const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Collection holding the leave records this helper judges from. */
const LEAVE_REQUESTS_COLLECTION = "leave_requests";

/** Statuses that mean the leave was granted. */
const GRANTED_LEAVE_STATUSES = ["approved", "completed"] as const;

/**
 * Upper bound on granted leave records read per evaluation. One
 * member's granted leaves are a handful per year; 100 is a hard
 * bound, not an expected count.
 */
const MAX_LEAVE_RECORDS_PER_EVALUATION = 100;

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

/** The task deadline this helper judges: individualDeadline wins. */
function parseTaskDeadlineMs(taskData: Record<string, unknown>): number | null {
  const deadlineRaw = taskData.individualDeadline || taskData.deadline;
  return parseToMs(deadlineRaw, "deadline");
}

/**
 * Pure window match, shared by the record-based entry point below
 * and pinned directly by the seam contract tests: does the task
 * deadline fall inside the leave window carried by `windowData`?
 *
 * `windowData` is any object carrying the window bounds. Leave
 * records name them `startDate` / `endDate`; the legacy user-doc
 * stamp names them `vacationStartDate` / `vacationEndDate`. Both
 * namings are read here because the question this function answers
 * is only about the window; WHICH windows count is decided by the
 * caller (the production entry point passes granted leave records
 * only). No on-leave flag is consulted: a window alone, with no
 * granted record behind it, grants nothing in production.
 *
 * Inputs are plain objects (typed as any at the call sites, because
 * callers pass raw Firestore docs). Never throws.
 */
export function isExemptForLeaveWindow(
  windowData: any,
  taskData: any,
): LeaveExemptionResult {
  try {
    if (!isPlainObject(windowData)) {
      return {
        exempt: false,
        reason: "Invalid input: leave window data is missing or not an object.",
      };
    }
    if (!isPlainObject(taskData)) {
      return {
        exempt: false,
        reason: "Invalid input: taskData is missing or not an object.",
      };
    }

    const windowStartMs = parseToMs(
      windowData.startDate ?? windowData.vacationStartDate,
      "start",
    );
    const windowEndMs = parseToMs(
      windowData.endDate ?? windowData.vacationEndDate,
      "end",
    );
    if (windowStartMs === null || windowEndMs === null) {
      return {
        exempt: false,
        reason:
          "No approved leave window: the leave start or end date is missing or invalid.",
      };
    }
    if (windowStartMs > windowEndMs) {
      return {
        exempt: false,
        reason:
          "Leave window is invalid: the leave start date is after the end date.",
      };
    }

    const deadlineMs = parseTaskDeadlineMs(taskData);
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
      typeof windowData.leaveRequestId === "string" &&
      windowData.leaveRequestId.trim() !== ""
    ) {
      result.leaveRequestId = windowData.leaveRequestId.trim();
    }
    return result;
  } catch {
    return {
      exempt: false,
      reason: "Invalid input: exemption could not be evaluated.",
    };
  }
}

/**
 * True when the assignee is exempt from the deadline penalty for
 * this task, judged from their granted leave records.
 *
 * `db` is the Admin Firestore handle (typed as any, like the other
 * inputs, because call sites pass the live Firestore instance and
 * tests pass a structural fake). Exactly one bounded query is
 * issued, and only after the task deadline has been parsed: a task
 * with no usable deadline is never exempt and costs no read.
 *
 * Never throws: a failed query returns { exempt: false }, matching
 * the long-standing contract that an evaluation this helper cannot
 * complete grants no exemption (both callers also guard their own
 * call sites).
 */
export async function isExemptFromDeadlinePenalty(
  db: any,
  uid: string,
  taskData: any,
  nowMs?: unknown,
): Promise<LeaveExemptionResult> {
  // nowMs is accepted for caller compatibility and intentionally unused.
  // Exemption depends only on deadline vs granted leave windows, not on now.
  void nowMs;

  try {
    if (typeof uid !== "string" || uid.trim() === "") {
      return {
        exempt: false,
        reason: "Invalid input: assignee uid is missing or not a string.",
      };
    }
    if (!isPlainObject(taskData)) {
      return {
        exempt: false,
        reason: "Invalid input: taskData is missing or not an object.",
      };
    }
    if (parseTaskDeadlineMs(taskData) === null) {
      return {
        exempt: false,
        reason:
          "No usable deadline: task has no individualDeadline or deadline, or the deadline is invalid.",
      };
    }
    if (!db || typeof db.collection !== "function") {
      return {
        exempt: false,
        reason: "Invalid input: no Firestore handle was provided.",
      };
    }

    // RBT2-B4: seam-first (leave is Supabase-primary). The seam list
    // carries the identical filters and bound; its docs are reshaped
    // to the { id, data() } form the evaluation loop below consumes,
    // so the judgment itself is byte-identical on either source. Only
    // a disabled/errored seam reaches the Firestore query.
    let docs: any[] | null = null;
    const seamResult = await tryListLeaveRequests({
      where: [
        ["userId", "==", uid],
        ["status", "in", [...GRANTED_LEAVE_STATUSES]],
      ],
      limit: MAX_LEAVE_RECORDS_PER_EVALUATION,
    }).catch(() => null);
    if (seamResult && seamResult.status === "ok") {
      docs = seamResult.value.map((doc: any) => {
        const { id, ...fields } = doc ?? {};
        return { id, data: () => fields };
      });
    }

    if (docs === null) {
      let snapshot: any;
      try {
        snapshot = await db
          .collection(LEAVE_REQUESTS_COLLECTION)
          .where("userId", "==", uid)
          .where("status", "in", [...GRANTED_LEAVE_STATUSES])
          .limit(MAX_LEAVE_RECORDS_PER_EVALUATION)
          .get();
      } catch {
        return {
          exempt: false,
          reason:
            "Leave records could not be read; exemption could not be evaluated.",
        };
      }

      docs = snapshot && Array.isArray(snapshot.docs) ? snapshot.docs : [];
    }
    // docs is always set here (the seam arm assigns, and the
    // Firestore arm assigns or returns from its catch); the ??
    // only satisfies the type checker.
    const settledDocs = docs ?? [];
    if (settledDocs.length === 0) {
      return {
        exempt: false,
        reason: "No approved leave records exist for this assignee.",
      };
    }

    for (const doc of settledDocs) {
      const record = typeof doc?.data === "function" ? doc.data() : null;
      if (!isPlainObject(record)) {
        continue;
      }
      // The query already filters on granted statuses; re-checking
      // here keeps the rule true even if a caller or a fake hands
      // this helper an unfiltered snapshot.
      if (!GRANTED_LEAVE_STATUSES.includes(record.status as any)) {
        continue;
      }
      const match = isExemptForLeaveWindow(record, taskData);
      if (match.exempt) {
        return {
          exempt: true,
          reason: match.reason,
          leaveRequestId:
            typeof doc.id === "string" && doc.id !== ""
              ? doc.id
              : match.leaveRequestId,
        };
      }
    }

    return {
      exempt: false,
      reason:
        "Deadline does not fall inside any approved leave window for this assignee.",
    };
  } catch {
    return {
      exempt: false,
      reason: "Invalid input: exemption could not be evaluated.",
    };
  }
}
