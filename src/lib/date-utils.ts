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
