/** Firestore -> JSON serialization for compliance API responses. */

import { tsToDate } from './cron';

/** Deep-converts Timestamp-like values ({ toDate }) and Dates to ISO strings. */
export function datesToIso(value: unknown): unknown {
  if (value == null) return value ?? null;
  // Plain strings are already JSON values and pass through verbatim:
  // this serializer's contract covers Timestamp-like values and Dates
  // only. Adapter-served timestamps arrive as ISO strings, which are
  // already in final serialized form (the store seam's serializeToken
  // pins the same parity: ISO strings pass through untouched). Routing
  // strings through a date parser instead would rewrite non-date
  // string fields (ids, template keys) that happen to parse as dates.
  if (typeof value === 'string') return value;
  const asDate = tsToDate(value);
  if (asDate) return asDate.toISOString();
  if (Array.isArray(value)) return value.map(datesToIso);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = datesToIso(v);
    }
    return out;
  }
  return value;
}

export function obligationToJson(id: string, data: Record<string, any>): Record<string, unknown> {
  return { id, ...(datesToIso(data) as Record<string, unknown>) };
}

export function noticeToJson(id: string, data: Record<string, any>): Record<string, unknown> {
  return { id, ...(datesToIso(data) as Record<string, unknown>) };
}
