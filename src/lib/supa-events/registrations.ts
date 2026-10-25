/**
 * Registrations seam for the Firestore -> Supabase migration (events
 * cluster, implementer E2: registration capacity transactions).
 *
 * This module is the ONE place in the registration surfaces that knows
 * about Supabase. The two routes that call it —
 *   - POST /api/event-registrations (paid / payment-proof)
 *   - POST /registerForEvent        (free / seat-holding)
 * keep speaking Firestore shapes and envelopes.
 *
 * MERGE-TIME RE-POINT (one edit): the adapter (`src/lib/supa/`, branch
 * feat/supa-adapter) is not in this tree yet. When it lands, replace the
 * body of `resolveRegistrationsAdapter()` with:
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
 * REGISTRATIONS ADDRESSING (RULING_REG_TABLE.md, binding): event
 * registrations land in `fs_group_registrations` via the adapter's
 * subcollection addressing — collection path
 * 'events/<eventId>/registrations', keyed by (parent_path, id) where
 * parent_path = 'events/<eventId>/registrations' (the full path, as the
 * pushed dump confirms). The same uid under two events is two rows.
 * NEVER address registrations as the top-level 'registrations'
 * collection / fs_registrations.
 *
 * Behavior contract:
 * - Flag OFF (SUPA_SURFACES does not name 'events'; the default), adapter
 *   unconfigured, adapter module absent, or adapter error: the read
 *   helper reports "unavailable" and the mirrors no-op, so callers run
 *   the Firestore path byte-identically to before this seam existed.
 * - Flag ON: the paid route's pre-transaction event read comes from
 *   fs_events via the adapter and is authoritative (including
 *   not-found); writes are dual-write — the Firestore transactions stay
 *   primary (see below) and the mirror helpers copy the registration +
 *   counter writes the transaction produced into Supabase. A mirror
 *   failure is logged and swallowed: it must never change a response
 *   whose Firestore write already succeeded.
 *
 * TRANSACTIONS STAY ON FIRESTORE under both flag states
 * (VERIFICATION_SPEC §1.1 / §2 T-1, T-2 / §5 C-1): the adapter has no
 * transaction primitive, and the capacity invariant (duplicate check ->
 * capacity check -> registration + counter writes, atomically) cannot
 * be split across two stores. Both transaction bodies below are moved
 * VERBATIM from their routes; their Postgres equivalents are manual
 * work, recorded in ~/workspace/supabase-migration/events-cluster/
 * MANUAL_LIST.md (E2 section). The `orders` write inside the paid
 * transaction is the store cluster's collection (§5 C-1) and is NOT
 * mirrored from here.
 *
 * Timestamp normalization lives HERE and nowhere else in E2: jsonb gives
 * back ISO-8601 strings (and the dump's serialized Timestamp objects as
 * {_seconds,_nanoseconds} / {seconds,nanoseconds}), while Firestore
 * consumers — the paid route's deadline enforcement reads `.seconds` —
 * expect Timestamp-like values. `normalizeSupaData` converts those
 * representations, recursively, into Timestamp-like objects
 * ({ seconds, nanoseconds, toDate(), toMillis() }). The seam NEVER emits
 * a raw {_seconds,_nanoseconds} shape: contract E-REG-P06 pins that the
 * paid route's deadline check does not recognize that shape, so leaking
 * it would silently disable deadline enforcement on the flag-on path.
 */

import admin from 'firebase-admin';

/* ------------------------------------------------------------------ types */

/** Structural copy of the adapter contract (see header). */
export interface RegistrationsSupaAdapter {
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

type FirestoreDb = FirebaseFirestore.Firestore;

/* ------------------------------------------------------------- flag check */

/**
 * Local copy of the adapter's useSupa('events') semantics (SUPA_SURFACES,
 * comma list, '*' = all, case-insensitive). Deleted at merge time in favor
 * of the adapter's flags.ts (see header).
 */
export function registrationsSupaEnabled(): boolean {
  const raw = process.env.SUPA_SURFACES;
  if (!raw) return false;
  const surfaces = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return surfaces.includes('*') || surfaces.includes('events');
}

/* ------------------------------------------------------- adapter resolve */

let injectedAdapter: RegistrationsSupaAdapter | null | undefined;

/** Test seam: inject a mock adapter (or null to force "unavailable"). */
export function setRegistrationsSupaAdapterForTests(
  adapter: RegistrationsSupaAdapter | null | undefined,
): void {
  injectedAdapter = adapter;
}

/**
 * THE re-point site (see header). Returns the registrations adapter when
 * the flag is on and Supabase is configured, otherwise null. Never throws.
 */
export async function resolveRegistrationsAdapter(): Promise<RegistrationsSupaAdapter | null> {
  if (!registrationsSupaEnabled()) return null;
  if (injectedAdapter !== undefined) return injectedAdapter;
  try {
    // Non-literal specifier on purpose: '@/lib/supa' does not exist in this
    // tree yet (it lands with feat/supa-adapter). At merge time this whole
    // block is replaced by the static import shown in the header.
    const specifier = '@/lib/supa';
    const mod = (await import(/* webpackIgnore: true */ specifier)) as {
      getSupaAdapter?: () => RegistrationsSupaAdapter;
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
 * Dates and Timestamp-like values become ISO strings, FieldValue
 * sentinels (serverTimestamp etc. — recognized by their `_methodName`)
 * become the current instant as an ISO string, and `undefined` values
 * are dropped (Firestore set with merge ignores them the same way for
 * absent keys).
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
 * Read one event from fs_events for the paid route's pre-transaction
 * deadline enforcement. Returns null when Supabase is unavailable (flag
 * off / unconfigured / adapter error) so the caller falls back to
 * Firestore; otherwise an authoritative found / not-found result with
 * timestamps normalized at this seam (never a raw {_seconds} shape —
 * E-REG-P06).
 */
export async function getEventForRegistration(
  eventId: string,
): Promise<SupaEventRead | null> {
  const adapter = await resolveRegistrationsAdapter();
  if (!adapter) return null;
  try {
    const doc = await adapter.getDoc('events', eventId);
    if (!doc) return { found: false };
    const { id: _id, ...data } = doc;
    void _id;
    return { found: true, data: normalizeSupaData(data) };
  } catch (err) {
    console.error('[supa-events/registrations] getEventForRegistration failed; falling back to Firestore:', err);
    return null;
  }
}

/* ------------------------------------------------------------- mirror API */

/**
 * Dual-write mirror: copy a registration write that ALREADY succeeded in
 * a Firestore transaction into fs_group_registrations, addressed through
 * the adapter's subcollection path 'events/<eventId>/registrations'
 * (RULING_REG_TABLE.md: key (parent_path, id), parent_path = the full
 * path). No-op when the flag is off / adapter unavailable; failures are
 * logged, never thrown (Firestore is primary).
 */
export async function mirrorRegistrationWrite(
  eventId: string,
  uid: string,
  registrationData: Record<string, unknown>,
): Promise<void> {
  const adapter = await resolveRegistrationsAdapter();
  if (!adapter) return;
  try {
    await adapter.setDoc(
      `events/${eventId}/registrations`,
      uid,
      toSupaSerializable(registrationData) as Record<string, unknown>,
      { merge: true },
    );
  } catch (err) {
    console.error(
      `[supa-events/registrations] mirror registration write events/${eventId}/registrations/${uid} failed:`,
      err,
    );
  }
}

/**
 * Dual-write mirror for the EV-P06 counter triple the registration
 * transactions wrote onto the event doc (attendeeIds,
 * registered_attendees_uids, registrationsCount, updatedAt). Same
 * fire-and-swallow rules as mirrorRegistrationWrite.
 */
export async function mirrorEventCounters(
  eventId: string,
  counters: Record<string, unknown>,
): Promise<void> {
  const adapter = await resolveRegistrationsAdapter();
  if (!adapter) return;
  try {
    await adapter.updateDoc(
      'events',
      eventId,
      toSupaSerializable(counters) as Record<string, unknown>,
    );
  } catch (err) {
    console.error(
      `[supa-events/registrations] mirror event counters events/${eventId} failed:`,
      err,
    );
  }
}

/* ---------------------------------------------------- paid route (T-1) */

export interface PaidRegistrationTxArgs {
  eventId: string;
  uid: string;
  transactionId: string;
  screenshotLink?: string;
  paymentMethod?: string;
  amount?: number;
  currency?: string;
  buyer?: { fullName?: string; email?: string } | null;
  /** Created by the route, outside the transaction, exactly as today. */
  orderRef: FirebaseFirestore.DocumentReference;
  /** Built by the route (its title comes from the pre-tx event read). */
  orderData: Record<string, unknown>;
}

export type PaidRegistrationOutcome =
  | 'created'
  | 'already-registered'
  | 'full'
  | 'not-found';

export interface PaidRegistrationTxResult {
  outcome: PaidRegistrationOutcome;
  /** The exact payload the transaction wrote to the registration doc.
   * Present only when outcome === 'created'; the route mirrors it. */
  registrationData?: Record<string, any>;
  /** The exact payload the transaction wrote to the event doc's
   * counters. Present only when outcome === 'created'. */
  counters?: Record<string, any>;
}

/**
 * The paid route's registration transaction (VERIFICATION_SPEC §2 T-1),
 * moved VERBATIM from src/app/api/event-registrations/route.ts. It stays
 * on Firestore under both flag states (see header): duplicate check ->
 * capacity check -> registration set -> counter update -> order set, in
 * that order, all in one Firestore transaction. The order doc is written
 * here (inside the tx, as today) but is NOT mirrored — it is the store
 * cluster's collection (§5 C-1).
 */
export async function runPaidRegistrationTransaction(
  db: FirestoreDb,
  args: PaidRegistrationTxArgs,
): Promise<PaidRegistrationTxResult> {
  const { eventId, uid, transactionId, screenshotLink, paymentMethod, amount, currency, buyer, orderRef, orderData } = args;

  const eventRef = db.collection('events').doc(eventId);
  const registrationRef = eventRef.collection('registrations').doc(uid);

  let writtenRegistration: Record<string, any> | undefined;
  let writtenCounters: Record<string, any> | undefined;

  const outcome = await db.runTransaction(async (tx) => {
    const [txEventSnap, regSnap] = await Promise.all([
      tx.get(eventRef),
      tx.get(registrationRef),
    ]);
    if (!txEventSnap.exists) {
      return 'not-found' as const;
    }

    if (regSnap.exists && regSnap.data()?.status !== 'cancelled') {
      return 'already-registered' as const;
    }

    const txEvent = (txEventSnap.data() || {}) as Record<string, any>;
    const attendeeIds: string[] = Array.isArray(txEvent.attendeeIds)
      ? txEvent.attendeeIds.filter((x: any) => typeof x === 'string')
      : [];
    const capacity = Number(txEvent.capacity || 0);
    if (capacity > 0 && attendeeIds.length >= capacity) {
      return 'full' as const;
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    writtenRegistration = {
      uid,
      eventId,
      transactionId,
      screenshotLink: screenshotLink || '',
      displayName: buyer?.fullName || '',
      email: buyer?.email || '',
      status: 'under_review', // Used for registrationStatus
      paymentStatus: 'pending', // Awaiting manual verification
      paymentMethod: paymentMethod || 'manual',
      amount: amount || 0,
      currency: currency || 'PKR',
      createdAt: now,
      updatedAt: now
    };
    tx.set(registrationRef, writtenRegistration, { merge: true });

    const registeredUids: string[] = Array.isArray(txEvent.registered_attendees_uids)
      ? txEvent.registered_attendees_uids.filter((x: any) => typeof x === 'string')
      : [];
    const nextAttendeeIds = attendeeIds.includes(uid) ? attendeeIds : [...attendeeIds, uid];
    const nextRegisteredUids = registeredUids.includes(uid) ? registeredUids : [...registeredUids, uid];
    writtenCounters = {
      attendeeIds: nextAttendeeIds,
      registered_attendees_uids: nextRegisteredUids,
      registrationsCount: nextAttendeeIds.length,
      updatedAt: now,
    };
    tx.update(eventRef, writtenCounters);

    tx.set(orderRef, orderData);
    return 'created' as const;
  });

  if (outcome !== 'created') return { outcome };
  return { outcome, registrationData: writtenRegistration, counters: writtenCounters };
}

/* ---------------------------------------------------- free route (T-2) */

/**
 * The free route's registration error vocabulary, moved from
 * src/app/registerForEvent/route.ts (which re-exports it so its
 * envelope helper and catch arm keep working unchanged).
 */
export class RegistrationError extends Error {
  constructor(
    public code: string,
    public httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

export interface FreeRegistrationTxArgs {
  eventId: string;
  uid: string;
  /** The request's registration fields (whatsappE164, paymentMethod). */
  data: Record<string, any>;
}

export interface FreeRegistrationTxResult {
  ok: true;
  alreadyRegistered: boolean;
  /** The exact payload the transaction wrote to the registration doc.
   * Present only on a fresh registration; the route mirrors it. */
  registrationData?: Record<string, any>;
  /** The exact payload the transaction wrote to the event doc's
   * counters. Present only on a fresh registration. */
  counters?: Record<string, any>;
}

/**
 * The free route's registration transaction (VERIFICATION_SPEC §2 T-2),
 * moved VERBATIM from src/app/registerForEvent/route.ts. It stays on
 * Firestore under both flag states (see header). Check order is exactly
 * today's: not-found -> deleted -> blacklist -> published/open ->
 * duplicate -> capacity -> writes. The foreign reads (`users`,
 * `warningConfig`) stay inside this Firestore transaction, as today.
 * A duplicate (non-cancelled) registration is an idempotent success
 * with NO writes; RegistrationError propagates to the route's catch.
 */
export async function runFreeRegistrationTransaction(
  db: FirestoreDb,
  args: FreeRegistrationTxArgs,
): Promise<FreeRegistrationTxResult> {
  const { eventId, uid, data } = args;

  const result = await db.runTransaction(async (tx) => {
    const eventRef = db.collection('events').doc(eventId);
    const regRef = eventRef.collection('registrations').doc(uid);
    const userRef = db.collection('users').doc(uid);
    const configRef = db.collection('warningConfig').doc('global');

    const [eventSnap, regSnap, userSnap, configSnap] = await Promise.all([
      tx.get(eventRef),
      tx.get(regRef),
      tx.get(userRef),
      tx.get(configRef),
    ]);

    if (!eventSnap.exists) {
      throw new RegistrationError('not-found', 404, 'Event not found');
    }
    const event = (eventSnap.data() || {}) as Record<string, any>;

    // A soft-deleted event is not registerable (the public
    // surfaces treat it as non-existent).
    if (event.deleted === true) {
      throw new RegistrationError('not-found', 404, 'Event not found');
    }

    // Enforcement: block blacklisted users while enforcement is
    // enabled (ported from the function handler; the flag lives
    // on the Firestore profile, not the Auth object).
    const userData = (userSnap.data() || {}) as Record<string, any>;
    const configData = configSnap.exists
      ? ((configSnap.data() || {}) as Record<string, any>)
      : { enforcementEnabled: true };
    if (configData.enforcementEnabled && userData.isBlacklisted === true) {
      throw new RegistrationError(
        'permission-denied',
        403,
        'Your account is currently blacklisted. Event registration is restricted.',
      );
    }

    const isPublished = event.status === 'published' || event.published === true;
    const registrationOpen = (event.registrationOpen ?? true) === true;
    if (!isPublished || !registrationOpen) {
      throw new RegistrationError('failed-precondition', 400, 'Registration is closed for this event');
    }

    // Duplicate = idempotent success (ported): an existing
    // non-cancelled registration returns success with NO writes,
    // so retries and double-clicks can never create a second
    // record or move the counters. This check runs before the
    // capacity check, as it did in the handler.
    if (regSnap.exists) {
      const existingStatus = String((regSnap.data() as any)?.status || 'pending');
      if (existingStatus !== 'cancelled') {
        return { ok: true, alreadyRegistered: true } as FreeRegistrationTxResult;
      }
    }

    // Capacity (audit EV-P03), enforced against the canonical
    // counter — attendeeIds, the array the CTA and the register
    // page both read for their Full states. Events that define
    // no capacity (missing/0) are uncapped, as in the handler.
    const attendeeIds: string[] = Array.isArray(event.attendeeIds)
      ? event.attendeeIds.filter((x: any) => typeof x === 'string')
      : [];
    const capacity = Number(event.capacity || 0);
    if (capacity > 0 && attendeeIds.length >= capacity) {
      throw new RegistrationError('failed-precondition', 400, 'Sorry, this event is full');
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const registeredUids: string[] = Array.isArray(event.registered_attendees_uids)
      ? event.registered_attendees_uids.filter((x: any) => typeof x === 'string')
      : [];
    const nextAttendeeIds = attendeeIds.includes(uid) ? attendeeIds : [...attendeeIds, uid];
    const nextRegisteredUids = registeredUids.includes(uid) ? registeredUids : [...registeredUids, uid];

    // One writer, one transaction: the registration record and
    // all three counters move together.
    const counters: Record<string, any> = {
      attendeeIds: nextAttendeeIds,
      registered_attendees_uids: nextRegisteredUids,
      registrationsCount: nextAttendeeIds.length,
      updatedAt: now,
    };
    tx.update(eventRef, counters);

    const isPaidEvent = event?.paymentDetails?.isPaid === true;
    const registrationData: Record<string, any> = {
      uid,
      eventId,
      displayName: userData.displayName || null,
      email: userData.email || null,
      whatsappE164: typeof data?.whatsappE164 === 'string' ? data.whatsappE164 : null,
      status: 'pending',
      paymentStatus: isPaidEvent ? 'unpaid' : 'verified',
      paymentMethod: typeof data?.paymentMethod === 'string'
        ? data.paymentMethod
        : (event?.paymentDetails?.method || null),
      paymentRef: null,
      createdAt: now,
      updatedAt: now,
    };
    tx.set(regRef, registrationData, { merge: true });

    return {
      ok: true,
      alreadyRegistered: false,
      registrationData,
      counters,
    } as FreeRegistrationTxResult;
  });

  return result;
}
