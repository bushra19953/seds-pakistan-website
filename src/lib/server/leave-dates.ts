// Date helpers for the leave lifecycle (defect fix, 2026-10-28).
//
// Leave windows are date-only ranges judged in Asia/Karachi wall
// time, the same convention as POST /api/leave (todayInKarachi in
// src/app/api/leave/route.ts) and the exemption helper. A leave
// covers its start date and its end date inclusively: it has
// started when Karachi today reaches the start date, and it has
// ended only once Karachi today is strictly past the end date.
//
// startDate / endDate are stored as YYYY-MM-DD strings
// (src/types/leave.ts), but legacy and seam-read docs can carry
// Date or Timestamp-like values, so every comparison goes through
// normalizeLeaveDateString first.
//
// No em dashes in this file. Plain ASCII only.

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * Today's date in Asia/Karachi as a YYYY-MM-DD string.
 * Identical approach to todayInKarachi() in src/app/api/leave.
 */
export function karachiTodayString(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** A Date instant rendered as its Asia/Karachi calendar date. */
export function karachiDateStringFromDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Normalize a stored leave date (string, Date, Firestore
 * Timestamp-like, or { seconds } object) to a YYYY-MM-DD string
 * in Asia/Karachi wall time. Returns null when the value carries
 * no usable date.
 */
export function normalizeLeaveDateString(value: unknown): string | null {
  if (typeof value === 'string') {
    const match = DATE_ONLY_PATTERN.exec(value.trim());
    return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : karachiDateStringFromDate(value);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.toDate === 'function') {
      try {
        const date = (record.toDate as () => Date)();
        return date instanceof Date && !Number.isNaN(date.getTime())
          ? karachiDateStringFromDate(date)
          : null;
      } catch {
        return null;
      }
    }
    if (typeof record.seconds === 'number') {
      return karachiDateStringFromDate(new Date(record.seconds * 1000));
    }
  }
  return null;
}

/**
 * True when the leave's start date has arrived (Karachi today is
 * on or after the start date). An unparseable start date counts
 * as started: legacy docs with odd date shapes keep the historic
 * approve-and-activate behaviour instead of being stranded
 * unactivatable. The lifecycle cron reports such docs as skipped
 * rather than guessing at their window.
 */
export function leaveHasStarted(startDate: unknown, today: string): boolean {
  const start = normalizeLeaveDateString(startDate);
  if (start === null) return true;
  return start <= today;
}

export type LeaveWindowPhase = 'future' | 'in-window' | 'ended' | 'unknown';

/**
 * Where a leave window sits relative to Karachi today.
 * - 'future':    starts after today; flags must be off.
 * - 'in-window': start <= today <= end; flags must be on.
 * - 'ended':     today is past the end date; the leave is over.
 * - 'unknown':   either date is unparseable.
 */
export function leaveWindowPhase(
  startDate: unknown,
  endDate: unknown,
  today: string,
): LeaveWindowPhase {
  const start = normalizeLeaveDateString(startDate);
  const end = normalizeLeaveDateString(endDate);
  if (start === null || end === null) return 'unknown';
  if (today < start) return 'future';
  if (today > end) return 'ended';
  return 'in-window';
}
