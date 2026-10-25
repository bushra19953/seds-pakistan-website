/**
 * Shared helpers for the public/misc Supabase seams (migration steps 6 + 11:
 * organizations, site-state, intake windows, public skills, forms,
 * resources). Per-surface seam modules live next to this file and own
 * their flag name, read protocol, and mirrors; this module only carries
 * the date/serialization helpers every one of them needs.
 *
 * Storage-shape ruling (adapter contract): Supabase rows carry ISO
 * strings for timestamps; legacy dumped rows may carry
 * {_seconds,_nanoseconds}, which the adapter rehydrates to a
 * SupaTimestamp (toDate()/toMillis()). The helpers below accept every
 * shape the Firestore code paths accepted, plus those two.
 */

/** Any stored date shape -> Date (or null when unparseable/absent). */
export function publicMiscDateToDate(v: any): Date | null {
  if (!v) return null;
  if (typeof v?.toDate === 'function') {
    try { return v.toDate(); } catch { return null; }
  }
  if (v instanceof Date) return v;
  if (typeof v === 'string') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'number') return new Date(v);
  const seconds = v._seconds ?? v.seconds;
  if (typeof seconds === 'number') {
    const nanos = v._nanoseconds ?? v.nanoseconds ?? 0;
    return new Date(seconds * 1000 + nanos / 1_000_000);
  }
  return null;
}

export function publicMiscDateToIso(v: any): string | null {
  const d = publicMiscDateToDate(v);
  return d ? d.toISOString() : null;
}

/**
 * Deep-serialize a Firestore/Admin-SDK document body for a JSON route
 * response: Timestamp-like values (toDate) and Dates become ISO strings,
 * everything else recurses or passes through. Used by the NEW routes in
 * this build (forms, resources) whose Firestore path must produce the
 * same wire shape as their Supabase path (where dates are already ISO).
 */
export function serializePublicMiscValue(v: any): any {
  if (v === null || v === undefined) return v ?? null;
  if (typeof v?.toDate === 'function') {
    try { return v.toDate().toISOString(); } catch { return null; }
  }
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(serializePublicMiscValue);
  if (typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) out[k] = serializePublicMiscValue(val);
    return out;
  }
  return v;
}

export function serializePublicMiscDoc(data: Record<string, any>): Record<string, any> {
  return serializePublicMiscValue(data) as Record<string, any>;
}
