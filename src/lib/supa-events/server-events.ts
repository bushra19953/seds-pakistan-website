/**
 * Server-events seam for the Firestore -> Supabase migration (events cluster,
 * server core: publish route, auction bid route, public event page metadata).
 *
 * This module is the ONE place in the events server core that knows about
 * Supabase. Everything else (routes, the slug page) calls the functions below
 * and keeps speaking Firestore shapes.
 *
 * MERGE-TIME RE-POINT (one edit): the adapter (`src/lib/supa/`, branch
 * feat/supa-adapter) is not in this tree yet. When it lands, replace the body
 * of `resolveEventsAdapter()` with:
 *
 *   import { getSupaAdapter, getSupaClient, useSupa } from '@/lib/supa';
 *   if (!useSupa('events') || !getSupaClient()) return null;
 *   return getSupaAdapter();
 *
 * and delete the local flag parser + dynamic import below. The adapter
 * contract programmed against here is exactly the adapter's:
 *   getDoc/listDocs/countDocs/setDoc/updateDoc/deleteDoc(collectionPath, ...)
 * over `fs_*` jsonb landing tables (row: id text pk, firebase_uid,
 * parent_path, data jsonb, migrated_at), where a read returns
 * `{ id, ...data }` or null.
 *
 * Behavior contract:
 * - Flag OFF (SUPA_SURFACES does not name 'events'; the default), adapter
 *   unconfigured, adapter module absent, or adapter error: every function
 *   here reports "unavailable" / no-ops, and callers run the Firestore path
 *   byte-identically to before this seam existed.
 * - Flag ON: reads come from fs_events via the adapter; writes are
 *   dual-write — Firestore stays primary (callers do it first, unchanged),
 *   and the mirror helpers below copy the same change to Supabase. A mirror
 *   failure is logged and swallowed: it must never change a response whose
 *   Firestore write already succeeded.
 *
 * Timestamp normalization lives HERE and nowhere else: jsonb gives back
 * ISO-8601 strings (and the dump's serialized Timestamp objects as
 * {_seconds,_nanoseconds} / {seconds,nanoseconds}), while Firestore
 * consumers — including src/lib/events/datetime.ts, whose semantics are
 * unchanged — expect Timestamp-like values. `normalizeSupaData` converts
 * those representations, recursively, into Timestamp-like objects
 * ({ seconds, nanoseconds, toDate(), toMillis() }).
 */

/* ------------------------------------------------------------------ types */

/** Structural copy of the adapter contract (see header). */
export interface EventsSupaAdapter {
  getDoc(collectionPath: string, id: string): Promise<Record<string, unknown> | null>;
  listDocs(collectionPath: string, options?: unknown): Promise<Record<string, unknown>[]>;
  countDocs(collectionPath: string, where?: unknown): Promise<number>;
  setDoc(
    collectionPath: string,
    id: string,
    data: Record<string, unknown>,
    options?: { merge?: boolean },
  ): Promise<Record<string, unknown>>;
  updateDoc(
    collectionPath: string,
    id: string,
    updates: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  deleteDoc(collectionPath: string, id: string): Promise<void>;
}

export interface TimestampLike {
  seconds: number;
  nanoseconds: number;
  toDate: () => Date;
  toMillis: () => number;
}

/** Tri-state read result: `null` from the helpers below means "unavailable —
 * use Firestore". An object means Supabase answered authoritatively. */
export type SupaEventRead =
  | { found: true; data: Record<string, unknown> }
  | { found: false };

/* ------------------------------------------------------------- flag check */

/**
 * Local copy of the adapter's useSupa('events') semantics (SUPA_SURFACES,
 * comma list, '*' = all, case-insensitive). Deleted at merge time in favor
 * of the adapter's flags.ts (see header).
 */
export function eventsSupaEnabled(): boolean {
  const raw = process.env.SUPA_SURFACES;
  if (!raw) return false;
  const surfaces = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return surfaces.includes('*') || surfaces.includes('events');
}

/* ------------------------------------------------------- adapter resolve */

let injectedAdapter: EventsSupaAdapter | null | undefined;

/** Test seam: inject a mock adapter (or null to force "unavailable"). */
export function setEventsSupaAdapterForTests(
  adapter: EventsSupaAdapter | null | undefined,
): void {
  injectedAdapter = adapter;
}

/**
 * THE re-point site (see header). Returns the events adapter when the flag
 * is on and Supabase is configured, otherwise null. Never throws.
 */
export async function resolveEventsAdapter(): Promise<EventsSupaAdapter | null> {
  if (!eventsSupaEnabled()) return null;
  if (injectedAdapter !== undefined) return injectedAdapter;
  try {
    // Non-literal specifier on purpose: '@/lib/supa' does not exist in this
    // tree yet (it lands with feat/supa-adapter). At merge time this whole
    // block is replaced by the static import shown in the header.
    const specifier = '@/lib/supa';
    const mod = (await import(/* webpackIgnore: true */ specifier)) as {
      getSupaAdapter?: () => EventsSupaAdapter;
      getSupaClient?: () => unknown;
    };
    if (typeof mod.getSupaAdapter !== 'function' || typeof mod.getSupaClient !== 'function') {
      return null;
    }
    if (!mod.getSupaClient()) return null; // unconfigured -> Firestore fallback
    return mod.getSupaAdapter();
  } catch {
    return null;
  }
}

/* ------------------------------------------------- timestamp normalization */

const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

export function toTimestampLike(seconds: number, nanoseconds: number): TimestampLike {
  return {
    seconds,
    nanoseconds,
    toDate: () => new Date(seconds * 1000 + nanoseconds / 1e6),
    toMillis: () => seconds * 1000 + nanoseconds / 1e6,
  };
}

function isoToTimestampLike(iso: string): TimestampLike | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const seconds = Math.floor(ms / 1000);
  const nanoseconds = Math.round((ms - seconds * 1000) * 1e6);
  return toTimestampLike(seconds, nanoseconds);
}

function isSerializedTimestamp(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  const hasSeconds =
    typeof value._seconds === 'number' || typeof value.seconds === 'number';
  const hasNanos =
    typeof value._nanoseconds === 'number' || typeof value.nanoseconds === 'number';
  return (
    hasSeconds &&
    hasNanos &&
    keys.every((k) => ['_seconds', '_nanoseconds', 'seconds', 'nanoseconds'].includes(k))
  );
}

/**
 * Deep-normalize a jsonb document body into the shape Firestore consumers
 * expect: ISO instant strings and serialized Timestamp objects become
 * TimestampLike; everything else (including non-instant strings, plain
 * {seconds}-only objects, Dates) passes through untouched in structure.
 */
export function normalizeSupaData<T>(value: T): T {
  if (typeof value === 'string') {
    if (ISO_INSTANT_RE.test(value)) {
      const ts = isoToTimestampLike(value);
      if (ts) return ts as T;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalizeSupaData(v)) as T;
  }
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const rec = value as Record<string, unknown>;
    if (isSerializedTimestamp(rec)) {
      const seconds = (rec._seconds ?? rec.seconds) as number;
      const nanoseconds = (rec._nanoseconds ?? rec.nanoseconds) as number;
      return toTimestampLike(seconds, nanoseconds) as T;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) out[k] = normalizeSupaData(v);
    return out as T;
  }
  return value;
}

/* ------------------------------------------------------- write serializer */

/**
 * Convert a Firestore-bound payload into a jsonb-safe mirror payload:
 * Dates and Timestamp-like values become ISO strings (the adapter's own
 * where-coercion treats them the same way), FieldValue sentinels
 * (serverTimestamp etc. — recognized by their `_methodName`) become the
 * current instant as an ISO string, and `undefined` values are dropped
 * (Firestore set with merge ignores them the same way for absent keys).
 */
export function toSupaSerializable(
  value: unknown,
  now: Date = new Date(),
): unknown {
  if (value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (typeof rec._methodName === 'string') return now.toISOString(); // FieldValue sentinel
    if (typeof (rec as { toDate?: unknown }).toDate === 'function') {
      try {
        return (rec as { toDate: () => Date }).toDate().toISOString();
      } catch {
        return value;
      }
    }
    if (Array.isArray(value)) return value.map((v) => toSupaSerializable(v, now));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      const converted = toSupaSerializable(v, now);
      if (converted !== undefined) out[k] = converted;
    }
    return out;
  }
  return value;
}

/* -------------------------------------------------------------- read API */

/**
 * Read one event from fs_events. Returns null when Supabase is unavailable
 * (flag off / unconfigured / adapter error) so the caller falls back to
 * Firestore; otherwise an authoritative found / not-found result with
 * timestamps normalized at this seam.
 */
export async function getEventByIdFromSupa(
  eventId: string,
): Promise<SupaEventRead | null> {
  const adapter = await resolveEventsAdapter();
  if (!adapter) return null;
  try {
    const doc = await adapter.getDoc('events', eventId);
    if (!doc) return { found: false };
    const { id: _id, ...data } = doc;
    void _id;
    return { found: true, data: normalizeSupaData(data) };
  } catch (err) {
    console.error('[supa-events] getEventByIdFromSupa failed; falling back to Firestore:', err);
    return null;
  }
}

/* ------------------------------------------------------------- mirror API */

/**
 * Dual-write mirror: copy a Firestore write that ALREADY succeeded into
 * Supabase. No-op when the flag is off / adapter unavailable; failures are
 * logged, never thrown (Firestore is primary).
 */
export async function mirrorDocWrite(
  collectionPath: string,
  id: string,
  data: Record<string, unknown>,
  options?: { merge?: boolean },
): Promise<void> {
  const adapter = await resolveEventsAdapter();
  if (!adapter) return;
  try {
    await adapter.setDoc(
      collectionPath,
      id,
      toSupaSerializable(data) as Record<string, unknown>,
      options,
    );
  } catch (err) {
    console.error(`[supa-events] mirror setDoc ${collectionPath}/${id} failed:`, err);
  }
}

/** Dual-write mirror for an update() on an existing doc. Same rules as above. */
export async function mirrorDocUpdate(
  collectionPath: string,
  id: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const adapter = await resolveEventsAdapter();
  if (!adapter) return;
  try {
    await adapter.updateDoc(
      collectionPath,
      id,
      toSupaSerializable(updates) as Record<string, unknown>,
    );
  } catch (err) {
    console.error(`[supa-events] mirror updateDoc ${collectionPath}/${id} failed:`, err);
  }
}
