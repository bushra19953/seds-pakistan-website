/**
 * Admin-events seam for the Firestore -> Supabase migration (events cluster,
 * implementer E5: admin events list/detail, attendees panel, settlement).
 *
 * This module is the ONE place in the E5 surfaces that knows about Supabase.
 * Everything else (the profit-settlement route, the registrations API route
 * below, the attendees panel) calls the functions here and keeps speaking
 * Firestore shapes.
 *
 * Surfaces and flags (SUPA_SURFACES, comma list, '*' = all,
 * case-insensitive — the adapter's frozen flag semantics):
 *   - 'events-admin' : admin attendees reads + registration-write mirrors,
 *     served by GET/POST /api/admin/events/registrations.
 *   - 'settlement'   : the profit-settlement route's GET read only.
 * Browser code cannot read SUPA_SURFACES; it uses the NEXT_PUBLIC_ twin
 * (NEXT_PUBLIC_SUPA_SURFACES) as a hint to call the API routes. The routes
 * re-check the server flag, so a stale/forged hint can never widen access.
 *
 * RE-POINT LANDED (coordinator, step 12 / audit item B-1): the adapter
 * (`src/lib/supa/`) is in this tree; `resolveAdapterForSurface()` binds
 * it statically (below) and the server flag check delegates to its
 * useSupa. (The local list parser survives only for the injectable-env
 * and NEXT_PUBLIC_ hint call forms, whose signatures predate the
 * adapter's env-only API.)
 *
 * Behavior contract:
 * - Flag OFF (the default), adapter unconfigured, adapter module absent, or
 *   adapter error: every read helper returns null ("unavailable") and every
 *   mirror no-ops, so callers run the Firestore path byte-identically to
 *   before this seam existed.
 * - Flag ON: reads come from the fs_* landing tables via the adapter;
 *   writes are dual-write — Firestore stays primary (callers do it first,
 *   unchanged) and the mirror helpers copy the same change to Supabase. A
 *   mirror failure is logged and swallowed: it must never change a
 *   response whose Firestore write already succeeded.
 *
 * REGISTRATIONS TABLE (adjudicated — RULING_REG_TABLE, 2026-10-25;
 * re-point applied at merge, step 12): event registrations live in the
 * `events/<id>/registrations` SUBCOLLECTION and land in
 * `fs_group_registrations`, keyed (parent_path, id). Addressing them as
 * a top-level 'registrations' collection (fs_registrations, id-only
 * key) would silently overwrite one event's registration with
 * another's for the same user. This seam therefore addresses the
 * family ONLY through registrationsCollectionPath(eventId) below,
 * which the adapter's resolveTarget() maps to the group table with the
 * parent qualification applied. The `eventId` where on the list call
 * (every writer of this family stores `eventId` on the doc) and the
 * defensive in-seam filter on returned rows are kept as
 * belt-and-braces; neither is load-bearing for correctness anymore.
 *
 * What is deliberately NOT here (MANUAL_LIST.md, E5 section):
 * - The attendees-panel counter sync (syncEventAttendeeCounters): a
 *   non-transactional read-modify-write of attendeeIds /
 *   registered_attendees_uids / registrationsCount on the event doc. It
 *   stays Firestore-only; its Postgres equivalent (one tx, SELECT ...
 *   FOR UPDATE on the fs_events row) is manual work.
 * - The settlement lock (profit-settlement POST/PATCH): sequential
 *   get -> check -> update enforcing the EV-P10 dual-sign lock. Those
 *   handlers stay on Firestore whole; only the route's plain GET read
 *   migrates, through getEventFromSupa(id, 'settlement').
 * - The admin events LIST page and the [id] detail page: VERIFICATION_SPEC
 *   H-B / section 1.3 — the list page is an explicit { listen: true }
 *   realtime surface and the detail page composes it; both stay on their
 *   Firestore hooks in this pass.
 *
 * Timestamp normalization lives HERE and nowhere else in E5: jsonb gives
 * back ISO-8601 strings (and the dump's serialized Timestamp objects as
 * {_seconds,_nanoseconds} / {seconds,nanoseconds}), while Firestore
 * consumers — the attendees CSV export reads `r.createdAt.seconds`
 * directly, src/lib/date-utils accepts {seconds,nanoseconds} — expect
 * Timestamp-like values. `normalizeSupaData` converts those
 * representations, recursively, into Timestamp-like objects
 * ({ seconds, nanoseconds, toDate(), toMillis() }). (Same deviation as
 * E1's seam, flagged there: VERIFICATION_SPEC section 3.4(a) prescribes
 * ISO strings on adapter reads; the cluster tasking prescribes
 * Timestamp-like at the seam. The flip is this one function.)
 */

import { getSupaAdapter, getSupaClient, useSupa } from '@/lib/supa';

/* ------------------------------------------------------------------ types */

/** Structural copy of the adapter contract (see header). */
export interface AdminEventsSupaAdapter {
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

export type AdminEventsSurface = 'events-admin' | 'settlement';

/** The ONLY addressing for event registrations: the subcollection
 * path (RULING_REG_TABLE). Never a top-level 'registrations'. */
export function registrationsCollectionPath(eventId: string): string {
  return `events/${eventId}/registrations`;
}
export const EVENTS_COLLECTION_PATH = 'events';

/* ------------------------------------------------------------- flag check */

function surfaceListHas(raw: string | undefined, surface: string): boolean {
  if (!raw) return false;
  const surfaces = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return surfaces.includes('*') || surfaces.includes(surface);
}

/**
 * Surface flag check. The default (real process env) delegates to the
 * adapter's useSupa since the B-1 re-point — identical semantics
 * (comma list, '*' = all, case-insensitive). An explicitly injected
 * env (tests) still goes through the local list parser, whose
 * signature predates the adapter's env-only API.
 */
export function supaSurfaceEnabled(
  surface: AdminEventsSurface,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env === process.env) return useSupa(surface);
  return surfaceListHas(env.SUPA_SURFACES, surface);
}

export function adminEventsSupaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return supaSurfaceEnabled('events-admin', env);
}

export function settlementSupaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return supaSurfaceEnabled('settlement', env);
}

/**
 * Client-side hint: the NEXT_PUBLIC_ twin of SUPA_SURFACES. Only a hint to
 * attempt the API routes; each route re-checks the server flag (and the
 * server config) before serving anything.
 */
export function adminEventsSupaClientEnabled(): boolean {
  return surfaceListHas(process.env.NEXT_PUBLIC_SUPA_SURFACES, 'events-admin');
}

/* ------------------------------------------------------- adapter resolve */

let injectedAdapter: AdminEventsSupaAdapter | null | undefined;

/** Test seam: inject a mock adapter (or null to force "unavailable"). */
export function setAdminEventsAdapterForTests(
  adapter: AdminEventsSupaAdapter | null | undefined,
): void {
  injectedAdapter = adapter;
}

/**
 * THE re-point site (see header). Returns the adapter when the named
 * surface's flag is on and Supabase is configured, otherwise null.
 * Never throws.
 */
export async function resolveAdapterForSurface(
  surface: AdminEventsSurface,
): Promise<AdminEventsSupaAdapter | null> {
  if (!supaSurfaceEnabled(surface)) return null;
  if (injectedAdapter !== undefined) return injectedAdapter;
  try {
    if (!getSupaClient()) return null; // unconfigured -> Firestore fallback
    return getSupaAdapter() as unknown as AdminEventsSupaAdapter;
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
 * Dates and Timestamp-like values become ISO strings, FieldValue sentinels
 * (serverTimestamp etc. — recognized by their `_methodName`) become the
 * current instant as an ISO string, and `undefined` values are dropped.
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

/* ---------------------------------------------------------------- read API */

/**
 * Read one event doc from fs_events on the named surface. Returns null
 * when Supabase is unavailable (flag off / unconfigured / adapter error)
 * so the caller falls back to Firestore; otherwise an authoritative
 * found / not-found result with timestamps normalized at this seam.
 */
export async function getEventFromSupa(
  eventId: string,
  surface: AdminEventsSurface,
): Promise<SupaEventRead | null> {
  const adapter = await resolveAdapterForSurface(surface);
  if (!adapter) return null;
  try {
    const doc = await adapter.getDoc(EVENTS_COLLECTION_PATH, eventId);
    if (!doc) return { found: false };
    const { id: _id, ...data } = doc;
    void _id;
    return { found: true, data: normalizeSupaData(data) };
  } catch (err) {
    console.error(`[supa-events/admin] getEventFromSupa(${surface}) failed; falling back to Firestore:`, err);
    return null;
  }
}

/**
 * List one event's registrations from fs_group_registrations, newest first —
 * the adapter form of the panel's Firestore query
 * `collection('events', eventId, 'registrations'), orderBy('createdAt','desc')`.
 * Parent qualification (parent_path='events/<eventId>' in the landing
 * table) is applied as the `eventId` where plus a defensive filter on the
 * returned rows, so a row belonging to another event can never leak into
 * this event's panel even if a where is mistranslated upstream.
 * Returns null when Supabase is unavailable; otherwise the rows as
 * `{ id, ...data }` with timestamps normalized at this seam (the panel's
 * CSV export reads `.seconds` off createdAt/updatedAt).
 */
export async function listRegistrationsFromSupa(
  eventId: string,
): Promise<Array<Record<string, unknown>> | null> {
  const adapter = await resolveAdapterForSurface('events-admin');
  if (!adapter) return null;
  try {
    const rows = await adapter.listDocs(registrationsCollectionPath(eventId), {
      where: [['eventId', '==', eventId]],
      orderBy: { field: 'createdAt', direction: 'desc' },
    });
    return rows
      .filter((row) => String((row as Record<string, unknown>).eventId ?? '') === eventId)
      .map((row) => normalizeSupaData(row) as Record<string, unknown>);
  } catch (err) {
    console.error('[supa-events/admin] listRegistrationsFromSupa failed; falling back to Firestore:', err);
    return null;
  }
}

/**
 * List the events registry from fs_events, newest first — the
 * adapter form of the admin events page's Firestore query
 * `collection('events'), orderBy('createdAt','desc')`. Bounded by
 * `limit` (the route clamps it); rows are `{ id, ...data }` with
 * timestamps normalized at this seam, the same shape the page's
 * Firestore hook produced. Returns null when Supabase is
 * unavailable so the caller falls back to Firestore.
 */
export async function listEventsFromSupa(
  limit: number,
): Promise<Array<Record<string, unknown>> | null> {
  const adapter = await resolveAdapterForSurface('events-admin');
  if (!adapter) return null;
  try {
    const rows = await adapter.listDocs(EVENTS_COLLECTION_PATH, {
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit,
    });
    return rows.map((row) => normalizeSupaData(row) as Record<string, unknown>);
  } catch (err) {
    console.error('[supa-events/admin] listEventsFromSupa failed; falling back to Firestore:', err);
    return null;
  }
}

/* ------------------------------------------------------------- mirror API */

/**
 * Dual-write mirror for the attendees panel's registration updates
 * (verify payment / confirm seat / cancel): copy a registration update
 * that ALREADY succeeded in Firestore into fs_group_registrations. No-op when
 * the 'events-admin' flag is off / adapter unavailable; failures are
 * logged, never thrown (Firestore is primary).
 *
 * Only the registration doc update is mirrored. The follow-on event
 * counter sync is NOT mirrored — see MANUAL_LIST entry E5-COUNTERS.
 */
export async function mirrorRegistrationUpdate(
  eventId: string,
  registrationId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const adapter = await resolveAdapterForSurface('events-admin');
  if (!adapter) return;
  try {
    await adapter.updateDoc(
      registrationsCollectionPath(eventId),
      registrationId,
      toSupaSerializable(updates) as Record<string, unknown>,
    );
  } catch (err) {
    console.error(
      `[supa-events/admin] mirror registration update events/${eventId}/registrations/${registrationId} failed:`,
      err,
    );
  }
}
