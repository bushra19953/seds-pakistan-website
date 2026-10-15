import { format, formatDistanceToNow } from 'date-fns';

/**
 * Safe conversion of various date-like objects to milliseconds.
 * Handles Firebase Timestamps, Javascript Dates, ISO strings, and numbers.
 */
export const toMillis = (val: any): number => {
  if (!val) return 0;
  
  // Firebase-like Timestamp (Admin or Client SDK)
  if (typeof val.toMillis === 'function') {
    return val.toMillis();
  }
  
  // Plain object with seconds (Firebase-like)
  if (val && typeof val === 'object' && typeof val.seconds === 'number') {
    return val.seconds * 1000 + (val.nanoseconds || 0) / 1000000;
  }
  
  // Javascript Date
  if (val instanceof Date) {
    return val.getTime();
  }
  
  // String or Number
  if (typeof val === 'string' || typeof val === 'number') {
    const d = new Date(val);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }
  
  return 0;
};

/**
 * Safe conversion of various date-like objects to a native Javascript Date.
 * Handles Firebase Timestamps, Javascript Dates, ISO strings, and numbers.
 */
export function toDate(val: any): Date | null {
  if (!val) return null;
  
  // Javascript Date
  if (val instanceof Date) {
    // Check if it's a valid Date object
    return isNaN(val.getTime()) ? null : val;
  }
  
  // Firebase-like Timestamp (Admin or Client SDK)
  if (typeof val.toDate === 'function') {
    return val.toDate();
  }
  
  // Plain object with seconds (Firebase-like)
  if (val && typeof val === 'object' && typeof val.seconds === 'number') {
    return new Date(val.seconds * 1000 + (val.nanoseconds || 0) / 1000000);
  }
  
  // String or Number (ISO string, timestamp number, etc.)
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Safely formats a date with a fallback string if invalid.
 */
export function safeFormat(val: any, formatStr: string, fallback = '—'): string {
  const d = toDate(val);
  if (!d) return fallback;
  try {
    return format(d, formatStr);
  } catch (err) {
    console.warn('[safeFormat] Error formatting date:', err);
    return fallback;
  }
}

/**
 * Safely formats a distance to now with a fallback string if invalid.
 */
export function safeFormatDistance(val: any, options?: { addSuffix?: boolean }, fallback = '—'): string {
  const d = toDate(val);
  if (!d) return fallback;
  try {
    return formatDistanceToNow(d, options);
  } catch (err) {
    console.warn('[safeFormatDistance] Error formatting date distance:', err);
    return fallback;
  }
}

/**
 * Zero-padded countdown parts for rendering a deadline countdown.
 *
 * `closed` is true whenever the remaining time is zero, negative, NaN, or
 * infinite. In that state every unit is "00", so a countdown UI can never
 * render garbage like "-1 days" after a deadline passes. When `closed` is
 * true the UI should show its "Applications Closed" (or equivalent) copy
 * instead of the numbers.
 */
export interface CountdownParts {
  /** Zero-padded days remaining (not capped, e.g. "120"). */
  days: string;
  /** Zero-padded hours (00-23). */
  hours: string;
  /** Zero-padded minutes (00-59). */
  minutes: string;
  /** Zero-padded seconds (00-59). */
  seconds: string;
  /** True when the deadline has passed; all units are "00". */
  closed: boolean;
}

const pad2 = (value: number): string =>
  String(Math.max(0, Math.floor(value))).padStart(2, '0');

/**
 * Formats a remaining-time duration in milliseconds into zero-padded
 * countdown parts. Pure function: no timers, no side effects.
 *
 * @param ms Remaining milliseconds until the deadline. Zero, negative,
 * NaN, or infinite input yields the Closed state.
 */
export function formatCountdown(ms: number): CountdownParts {
  if (!Number.isFinite(ms) || ms <= 0) {
    return { days: '00', hours: '00', minutes: '00', seconds: '00', closed: true };
  }
  const totalSeconds = Math.floor(ms / 1000);
  return {
    days: pad2(totalSeconds / 86400),
    hours: pad2((totalSeconds % 86400) / 3600),
    minutes: pad2((totalSeconds % 3600) / 60),
    seconds: pad2(totalSeconds % 60),
    closed: false,
  };
}

/**
 * True when a countdown has no time left (zero or negative remaining
 * milliseconds). Convenience wrapper around formatCountdown for deadline
 * gating; never throws on NaN or infinite input.
 */
export function isCountdownClosed(ms: number): boolean {
  return formatCountdown(ms).closed;
}

/**
 * Formats a deadline as a PKT cutoff line, e.g.
 * "Saturday, Oct 17 at 11:59 PM PKT".
 *
 * Uses the Asia/Karachi timezone explicitly so the label is correct
 * regardless of the viewer's device timezone. Accepts the same inputs as
 * toDate (Firebase Timestamps, Dates, ISO strings, numbers). Returns a
 * neutral fallback when the deadline cannot be parsed.
 */
export function formatCutoffLinePKT(deadline: any): string {
  const d = toDate(deadline);
  if (!d) return 'Cutoff date to be announced';
  const datePart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Karachi',
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  }).format(d);
  const timePart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Karachi',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
  return `${datePart} at ${timePart} PKT`;
}
