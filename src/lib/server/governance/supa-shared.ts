/**
 * Shared plumbing for the governance Supabase seams (meetings /
 * decisions / motions cluster, plan cluster_meetings_PLAN.md §1, §3).
 *
 * This module is NOT a fifth seam: it holds only the adapter
 * resolution, id generation, and date revival helpers that the four
 * group seams (decisions-supa.ts [G4], meetings-supa.ts [G1],
 * motions-supa.ts [G2], minutes-circular-supa.ts [G3]) share, so the
 * four seams cannot drift apart on these rules.
 *
 * Flag / fallback contract (all four groups):
 * - `govSupaAdapterFor(surface)` returns an adapter ONLY when
 *   `useSupa(surface)` is on AND a Supabase client is configured, or
 *   when a test injected one via `__setGovSupaAdapterForTests`.
 *   Otherwise it returns null and callers build the Firestore stores
 *   exactly as before this migration (flag OFF = byte-identical).
 * - Seam store classes take their Firestore counterpart as a fallback:
 *   any adapter error inside a seam method delegates that call to the
 *   Firestore implementation, so an adapter failure mid-rollout
 *   degrades to today's behaviour instead of failing the request.
 *
 * Date rules (plan §3, standing rules 1-2):
 * - Writes: JS Dates are stored by the adapter as canonical UTC ISO
 *   strings (ms precision, `Z`) — the adapter's normalizeForStorage
 *   does this; seams never hand-serialise dates.
 * - Reads: `reviveDatesDeep` turns ISO instant strings (and any
 *   Timestamp-like values the adapter rehydrated) back into real Date
 *   objects before data reaches a service, mirroring what the
 *   Firestore stores' `toDate()` conversions produce today. Fields
 *   that are epoch-ms NUMBERS by design (urgent records' *Ms fields)
 *   are untouched.
 */

import { getSupaAdapter, getSupaClient, useSupa } from "@/lib/supa";
import type { SupaAdapter } from "@/lib/supa";

export type GovSupaAdapter = SupaAdapter;

let injectedAdapter: GovSupaAdapter | null | undefined;

/** Test injection point (mock adapters only; never a live client). */
export function __setGovSupaAdapterForTests(adapter: GovSupaAdapter | null | undefined): void {
  injectedAdapter = adapter;
}

/**
 * The adapter for `surface`, or null when the surface flag is OFF,
 * Supabase is unconfigured, or resolution fails for any reason.
 * Never throws.
 */
export function govSupaAdapterFor(surface: string): GovSupaAdapter | null {
  if (injectedAdapter !== undefined) return injectedAdapter;
  try {
    if (!useSupa(surface)) return null;
    if (!getSupaClient()) return null;
    return getSupaAdapter();
  } catch {
    return null;
  }
}

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Firestore-shaped auto-id: 20 chars from the Firestore alphabet.
 * Downstream code treats ids as opaque strings, but tests and logs
 * snapshot their shape (plan §1-G2), so the seam generates the same
 * shape client-side wherever Firestore's `doc().id` did.
 */
export function newFirestoreId(): string {
  let id = "";
  for (let i = 0; i < 20; i++) {
    id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return id;
}

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Deep date revival for seam reads: ISO instant strings become Dates,
 * Timestamp-like values ({ toDate }) become Dates via toDate(), and
 * everything else recurses or passes through untouched. NOT applied
 * to the governance-votes facade path (plan §2-G2: getVote returns the
 * stored shape raw; the ISO-for-Timestamp delta there is flagged, not
 * faked).
 */
export function reviveDatesDeep<T>(value: T): T {
  if (typeof value === "string") {
    if (ISO_INSTANT_RE.test(value)) {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return d as T;
    }
    return value;
  }
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    return value.map((v) => reviveDatesDeep(v)) as T;
  }
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec.toDate === "function") {
      try {
        const d = (rec.toDate as () => Date)();
        if (d instanceof Date && !Number.isNaN(d.getTime())) return d as T;
      } catch {
        /* fall through to structural recursion */
      }
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) out[k] = reviveDatesDeep(v);
    return out as T;
  }
  return value;
}

/** Strip the adapter's flattened `id` off a read doc, returning the body. */
export function stripDocId(doc: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...data } = doc;
  void _id;
  return data;
}

/**
 * Sanitise a service payload for the adapter: FieldValue sentinels
 * (serverTimestamp & friends, recognised by `_methodName`) become the
 * seam-generated write instant (plan §3 rules for H-1/H-2/H-4/H-6 —
 * server-time semantics live at the seam, never the caller's clock),
 * and Timestamp-like values become Dates (which the adapter then
 * stores as ISO). `undefined` values are dropped, as Firestore set()
 * ignores them in this codebase's payloads.
 */
export function sanitizeForSupaWrite(value: unknown, now: Date = new Date()): unknown {
  if (value === undefined) return undefined;
  if (value instanceof Date) return value;
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec._methodName === "string") return now;
    if (typeof rec.toDate === "function") {
      try {
        return (rec.toDate as () => Date)();
      } catch {
        return value;
      }
    }
    if (Array.isArray(value)) return value.map((v) => sanitizeForSupaWrite(v, now));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      const converted = sanitizeForSupaWrite(v, now);
      if (converted !== undefined) out[k] = converted;
    }
    return out;
  }
  return value;
}
