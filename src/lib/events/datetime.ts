/**
 * Event date-time conversions: Asia/Karachi wall clock <-> UTC instant.
 *
 * Platform convention (the same one src/app/api/admin/intake-windows/shared.ts
 * documents for intake windows): event times are AUTHORED as wall-clock times
 * in Asia/Karachi and STORED as absolute instants (Firestore Timestamps, UTC).
 * Pakistan does not observe DST, so the offset is a fixed +05:00 and the
 * conversions below are pure arithmetic on UTC getters — they never consult
 * the runtime's local timezone, so a create -> edit -> save -> edit round trip
 * returns the identical stored instant in any browser timezone.
 *
 * The bug this replaces: the form submit path parsed the datetime-local
 * strings with `new Date(str)` (browser-local), the edit form rehydrated
 * with `toISOString().slice(0, 10)` (UTC, time-of-day discarded), and the
 * inputs re-rendered values through `new Date(v).toISOString().slice(0, 16)`
 * (UTC wall clock shown in a local-time control). No hop inverted another,
 * so every save could shift the stored instant and repeated saves compounded.
 */

export const EVENT_TIMEZONE = 'Asia/Karachi';
export const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

const WALL_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Parse a PKT wall-time string 'YYYY-MM-DDTHH:mm' (optional ':ss'; a bare
 * 'YYYY-MM-DD' means PKT midnight) to a UTC epoch ms. Returns null for
 * anything else, including strings carrying their own offset: the wire
 * format is wall time in Asia/Karachi only.
 */
export function pktWallTimeToUtcMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = WALL_TIME_RE.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = m[4] ? Number(m[4]) : 0;
  const minute = m[5] ? Number(m[5]) : 0;
  const second = m[6] ? Number(m[6]) : 0;
  if (
    month < 1 || month > 12 || day < 1 || day > 31 ||
    hour > 23 || minute > 59 || second > 59
  ) {
    return null;
  }
  const wallAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  // Round-trip check rejects overflow dates like Feb 30.
  const dt = new Date(wallAsUtcMs);
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day ||
    dt.getUTCHours() !== hour ||
    dt.getUTCMinutes() !== minute ||
    dt.getUTCSeconds() !== second
  ) {
    return null;
  }
  return wallAsUtcMs - PKT_OFFSET_MS;
}

/**
 * Format a UTC epoch ms as a PKT wall-time string 'YYYY-MM-DDTHH:mm'
 * (':ss' appended only when the instant carries non-zero seconds, so
 * re-saving a legacy value with seconds stays an exact round trip).
 * Exact inverse of pktWallTimeToUtcMs.
 */
export function utcMsToPktWallTime(ms: number): string {
  const dt = new Date(ms + PKT_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  const base =
    `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}` +
    `T${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}`;
  const seconds = dt.getUTCSeconds();
  return seconds ? `${base}:${p(seconds)}` : base;
}

/**
 * Normalize any stored date-ish value (Firestore Timestamp, serialized
 * { seconds } object, Date, epoch ms, ISO instant string) to epoch ms.
 * Returns null when there is no valid instant.
 */
export function eventInstantToMs(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === 'string') {
    const t = new Date(value).getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === 'object') {
    const v = value as {
      toMillis?: () => number;
      toDate?: () => Date;
      seconds?: number;
      nanoseconds?: number;
    };
    if (typeof v.toMillis === 'function') {
      try {
        const t = v.toMillis();
        return typeof t === 'number' && !Number.isNaN(t) ? t : null;
      } catch {
        return null;
      }
    }
    if (typeof v.toDate === 'function') {
      try {
        const t = v.toDate()?.getTime();
        return typeof t === 'number' && !Number.isNaN(t) ? t : null;
      } catch {
        return null;
      }
    }
    if (typeof v.seconds === 'number') {
      return v.seconds * 1000 + (typeof v.nanoseconds === 'number' ? v.nanoseconds / 1e6 : 0);
    }
  }
  return null;
}

/** Stored instant -> datetime-local field value (PKT wall time), '' if none. */
export function dateToPktWallTime(value: unknown): string {
  const ms = eventInstantToMs(value);
  return ms == null ? '' : utcMsToPktWallTime(ms);
}

/** PKT wall-time field value -> Date for storage, null if empty/invalid. */
export function pktWallTimeToDate(value: unknown): Date | null {
  const ms = pktWallTimeToUtcMs(value);
  return ms == null ? null : new Date(ms);
}

export type EventDateVariant =
  | 'long'
  | 'weekdayLong'
  | 'datePadded'
  | 'date'
  | 'dateTime24';

const VARIANT_OPTIONS: Record<EventDateVariant, Intl.DateTimeFormatOptions> = {
  // 'MMMM d, yyyy • h:mm a'
  long: {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  },
  // 'EEEE, MMMM d, yyyy • h:mm a'
  weekdayLong: {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  },
  // 'MMM dd, yyyy'
  datePadded: { month: 'short', day: '2-digit', year: 'numeric' },
  // 'MMM d, yyyy'
  date: { month: 'short', day: 'numeric', year: 'numeric' },
  // 'MMM dd, yyyy HH:mm'
  dateTime24: {
    month: 'short', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  },
};

/**
 * Render a stored instant in Asia/Karachi, matching the shapes the event
 * surfaces previously produced with date-fns in the viewer's local zone.
 * Returns null when the value carries no valid instant (callers substitute
 * their own fallback text).
 */
export function formatEventInstantInPkt(
  value: unknown,
  variant: EventDateVariant,
): string | null {
  const ms = eventInstantToMs(value);
  if (ms == null) return null;
  const parts: Record<string, string> = {};
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: EVENT_TIMEZONE,
    ...VARIANT_OPTIONS[variant],
  });
  for (const part of dtf.formatToParts(new Date(ms))) {
    parts[part.type] = part.value;
  }
  const datePart = `${parts.month} ${parts.day}, ${parts.year}`;
  if (variant === 'weekdayLong') {
    return `${parts.weekday}, ${datePart} • ${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
  }
  if (variant === 'long') {
    return `${datePart} • ${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
  }
  if (variant === 'dateTime24') {
    return `${datePart} ${parts.hour}:${parts.minute}`;
  }
  return datePart;
}
