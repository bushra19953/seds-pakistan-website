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
 * ADAPTER BINDING (E3 form, per the acceptance auditor's steering —
 * audit blocker B-1): this seam binds to the shared adapter STATICALLY,
 *   import { getSupaAdapter, getSupaClient, useSupa } from '@/lib/supa';
 * exactly as src/lib/supa-events/tickets.ts does. There is NO dynamic
 * import and NO local flag parser: `registrationsSupaEnabled()` is
 * `useSupa('events') && getSupaClient() !== null`, evaluated through
 * the adapter's own flags module. `src/lib/supa/` does not exist on
 * this base branch (it lands as merge step 0 from feat/supa-adapter),
 * so at merge time NO re-point edit is needed in this file — the
 * import resolves against the landed adapter as-is. On this branch the
 * seam's tests (and the route suites) mock '@/lib/supa' with a jest
 * factory, the same mechanism E3's suites use; the test-injection point
 * (setRegistrationsSupaAdapterForTests) is preserved for tests that
 * drive an adapter double through the seam's helpers directly.
 * The adapter contract programmed against here is exactly the
 * adapter's:
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
 * TRANSACTIONS STAY ON FIRESTORE while SUPA_PRIMARY is off for
 * 'events' (VERIFICATION_SPEC §1.1 / §2 T-1, T-2 / §5 C-1): the
 * capacity invariant (duplicate check -> capacity check ->
 * registration + counter writes, atomically) cannot be split across
 * two stores. Both transaction bodies below are moved VERBATIM from
 * their routes; their Postgres equivalents were manual work, recorded
 * in ~/workspace/supabase-migration/events-cluster/ MANUAL_LIST.md
 * (E2 section, E2-TX-1 / E2-TX-2). The `orders` write inside the paid
 * transaction is the store cluster's collection (§5 C-1) and is NOT
 * mirrored from here on the Firestore-primary path.
 *
 * CUTOVER (write primacy, isSupaPrimary('events')): the Postgres
 * equivalents now exist — tx_events_register_paid /
 * tx_events_register_free (src/lib/supa/sql/) — and the *Primary
 * functions below run them as the ONLY writer for their flow
 * (registration + counter triple + order, atomically, in Postgres),
 * then mirror the committed result back to Firestore best-effort
 * (a mirror failure is logged, never thrown: the registration already
 * succeeded). The Firestore transaction bodies are NOT run on that
 * path, and the Supabase dual-write mirrors above are NOT fired by
 * the routes for primary outcomes (the tx already wrote Supabase).
 * With SUPA_PRIMARY off (the default), every path in this file is
 * byte-identical to the pre-cutover behavior.
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
import { getSupaAdapter, getSupaClient, isSupaPrimary, useSupa } from '@/lib/supa';

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
  /**
   * Transactional-function call (cutover foundation): ONE Postgres
   * function whose body is one transaction. Optional in this structural
   * copy — the shipped adapter always provides it; the primary-path
   * resolver below refuses to run without it (never a silent fallback
   * to the Firestore transaction once primacy is on).
   */
  tx?<T = unknown>(
    fn: string,
    args?: Record<string, unknown>,
    options?: { idempotencyKey?: string },
  ): Promise<T>;
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

export const REGISTRATIONS_SUPA_SURFACE = 'events';

/**
 * True only when the adapter's flag names the 'events' surface AND a
 * Supabase client is configured — the adapter's own semantics, via the
 * static binding (see header). Never throws: an unconfigured or
 * erroring adapter layer reads as "off" so callers fall back to
 * Firestore.
 */
export function registrationsSupaEnabled(): boolean {
  try {
    return useSupa(REGISTRATIONS_SUPA_SURFACE) && getSupaClient() !== null;
  } catch {
    return false;
  }
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
 * Returns the registrations adapter when the flag is on and Supabase is
 * configured, otherwise null. Never throws. A test-injected adapter
 * (setRegistrationsSupaAdapterForTests) takes precedence so seam unit
 * tests can drive the helpers without the '@/lib/supa' mock's adapter
 * factory; it is still gated by registrationsSupaEnabled(), so flag-off
 * tests observe true no-op behavior.
 */
export async function resolveRegistrationsAdapter(): Promise<RegistrationsSupaAdapter | null> {
  if (!registrationsSupaEnabled()) return null;
  if (injectedAdapter !== undefined) return injectedAdapter;
  try {
    return getSupaAdapter() as RegistrationsSupaAdapter;
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

/* ------------------------------------------- cutover: write primacy */

/**
 * Write-primary gate for the cutover (FLAG LAW, flags.ts): true only
 * when 'events' is in BOTH SUPA_SURFACES and SUPA_PRIMARY and a
 * Supabase client is configured. Never throws — an erroring flag layer
 * reads as "off", so callers run the pre-cutover Firestore path.
 */
export function registrationsSupaPrimary(): boolean {
  try {
    return isSupaPrimary(REGISTRATIONS_SUPA_SURFACE) && getSupaClient() !== null;
  } catch {
    return false;
  }
}

/**
 * Resolve the adapter for a primary (tx) call. Unlike the read/mirror
 * resolver this does NOT fail soft: once primacy is on, silently
 * falling back to the Firestore transaction would split the writer.
 * A missing tx primitive is a loud error (the routes surface it as
 * their existing 500), never a quiet dual-write.
 */
async function resolvePrimaryTxAdapter(): Promise<RegistrationsSupaAdapter> {
  const adapter = await resolveRegistrationsAdapter();
  if (!adapter || typeof adapter.tx !== 'function') {
    throw new Error(
      '[supa-events/registrations] SUPA_PRIMARY=events is on but the Supabase adapter has no tx() primitive; refusing to fall back to the Firestore transaction',
    );
  }
  return adapter;
}

/** The shape both tx_events_register_* functions return (jsonb). */
interface EventsRegisterTxResult {
  applied?: boolean;
  duplicate?: boolean;
  outcome?: string;
  reason?: string | null;
  already_registered?: boolean;
  registration_data?: Record<string, any>;
  counters?: Record<string, any>;
  order_id?: string | null;
}

/**
 * Convert a tx-produced payload back into Firestore mirror shape: the
 * Postgres functions store document timestamps as ISO strings; the
 * Firestore mirror stores them as Dates (which the Admin SDK writes
 * as Timestamps), so the mirror doc keeps the stored types the
 * Firestore-primary path writes. Only the known top-level timestamp
 * fields of the registration / counter payloads are converted.
 */
function forFirestoreMirror(
  data: Record<string, any>,
): Record<string, any> {
  const out: Record<string, any> = { ...data };
  for (const key of ['createdAt', 'updatedAt'] as const) {
    const value = out[key];
    if (typeof value === 'string' && ISO_INSTANT_RE.test(value)) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) out[key] = date;
    }
  }
  return out;
}

/**
 * Post-commit Firestore mirror for the primary path: copy the
 * registration + counter triple the Postgres transaction committed
 * into Firestore, best-effort. A failure is logged and swallowed —
 * it must never fail a registration that already succeeded in the
 * primary store (the same rule the Supabase mirrors follow on the
 * Firestore-primary path, with the direction reversed).
 */
async function mirrorRegistrationToFirestore(
  db: FirestoreDb,
  eventId: string,
  uid: string,
  registrationData: Record<string, any>,
  counters: Record<string, any>,
): Promise<void> {
  try {
    const eventRef = db.collection('events').doc(eventId);
    await eventRef.update(forFirestoreMirror(counters));
    await eventRef
      .collection('registrations')
      .doc(uid)
      .set(forFirestoreMirror(registrationData), { merge: true });
  } catch (err) {
    console.error(
      `[supa-events/registrations] Firestore mirror for primary registration events/${eventId}/registrations/${uid} failed (registration is committed in Supabase):`,
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
  | 'price-mismatch'
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

/**
 * E2-TX-1, cutover form: the paid registration as ONE Postgres
 * transaction (tx_events_register_paid — duplicate -> capacity ->
 * registration + counter triple + order, atomically, capacity
 * re-checked inside under the per-event advisory lock). This is the
 * ONLY writer for the flow when isSupaPrimary('events'); the
 * Firestore mirror is written post-commit, best-effort, and the
 * order's Firestore copy is part of that mirror (the route's own
 * orderRef / orderData, exactly the doc the Firestore path writes).
 *
 * The idempotency key is minted here, at the operation's origin in
 * the seam: 'pay:<eventId>:<uid>:<transactionId>' — the payment
 * transaction id names the one logical submission, and every retry
 * of it (double-click, webhook-adjacent resubmit, response lost after
 * commit) reuses it, so the function replays the recorded outcome
 * instead of minting a second order or moving the counters twice.
 *
 * Outcome vocabulary is mapped back to PaidRegistrationOutcome, so
 * the route's response surface is identical on both paths.
 */
export async function runPaidRegistrationPrimary(
  db: FirestoreDb,
  args: PaidRegistrationTxArgs,
): Promise<PaidRegistrationTxResult> {
  const { eventId, uid, transactionId, screenshotLink, paymentMethod, amount, currency, buyer, orderRef, orderData } = args;
  const adapter = await resolvePrimaryTxAdapter();

  const raw = await adapter.tx!<EventsRegisterTxResult>(
    'tx_events_register_paid',
    {
      p_event_id: eventId,
      p_uid: uid,
      p_transaction_id: transactionId,
      p_screenshot_link: screenshotLink || '',
      p_payment_method: paymentMethod || 'manual',
      p_amount: amount || 0,
      p_currency: currency || 'PKR',
      p_display_name: buyer?.fullName || '',
      p_email: buyer?.email || '',
      p_order_id: orderRef.id,
      p_order_data: toSupaSerializable(orderData) as Record<string, unknown>,
    },
    { idempotencyKey: `pay:${eventId}:${uid}:${transactionId}` },
  );

  const outcome = raw?.outcome;
  if (outcome === 'not_found') return { outcome: 'not-found' };
  if (outcome === 'already_registered') return { outcome: 'already-registered' };
  if (outcome === 'full') return { outcome: 'full' };
  // Audit item 4: tx_events_register_paid re-checks p_amount against
  // the locked event's paymentDetails.amount and returns this as a
  // value (no writes) on a mismatch or an unpriced paid event.
  if (outcome === 'price_mismatch') return { outcome: 'price-mismatch' };
  if (outcome !== 'created' || !raw.registration_data || !raw.counters) {
    throw new Error(
      `[supa-events/registrations] tx_events_register_paid returned an unexpected result: ${JSON.stringify(raw)}`,
    );
  }

  // Post-commit Firestore mirror (best-effort): the order doc the
  // route built, plus the registration + counters the tx committed.
  try {
    await orderRef.set(orderData);
  } catch (err) {
    console.error(
      `[supa-events/registrations] Firestore mirror for primary order ${orderRef.id} failed (registration is committed in Supabase):`,
      err,
    );
  }
  await mirrorRegistrationToFirestore(db, eventId, uid, raw.registration_data, raw.counters);

  return {
    outcome: 'created',
    registrationData: raw.registration_data,
    counters: raw.counters,
  };
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

/**
 * E2-TX-2, cutover form: the free registration as ONE Postgres
 * transaction (tx_events_register_free — not-found -> deleted ->
 * blacklist -> published/open -> duplicate -> capacity -> writes,
 * atomically, capacity re-checked inside under the per-event advisory
 * lock; the users / warningConfig snapshots are read inside the
 * transaction from their landing tables — the accepted weakening
 * recorded in MANUAL_LIST E2-TX-2). This is the ONLY writer for the
 * flow when isSupaPrimary('events'); the Firestore mirror is written
 * post-commit, best-effort.
 *
 * The idempotency key is minted here, at the operation's origin in
 * the seam: 'free:<eventId>:<uid>' — a free registration's natural
 * identity is the (event, uid) pair (its document id), so every
 * retry of the same logical registration reuses the key and the
 * function replays the recorded outcome.
 *
 * Rejection reasons are mapped back to the route's RegistrationError
 * vocabulary byte-identically (code, HTTP status, message), so the
 * UI-visible error surface is the same on both paths.
 */
export async function runFreeRegistrationPrimary(
  db: FirestoreDb,
  args: FreeRegistrationTxArgs,
): Promise<FreeRegistrationTxResult> {
  const { eventId, uid, data } = args;
  const adapter = await resolvePrimaryTxAdapter();

  const raw = await adapter.tx!<EventsRegisterTxResult>(
    'tx_events_register_free',
    {
      p_event_id: eventId,
      p_uid: uid,
      p_whatsapp_e164: typeof data?.whatsappE164 === 'string' ? data.whatsappE164 : null,
      p_payment_method: typeof data?.paymentMethod === 'string' ? data.paymentMethod : null,
    },
    { idempotencyKey: `free:${eventId}:${uid}` },
  );

  switch (raw?.outcome) {
    case 'created': {
      if (!raw.registration_data || !raw.counters) {
        throw new Error(
          `[supa-events/registrations] tx_events_register_free returned an unexpected result: ${JSON.stringify(raw)}`,
        );
      }
      await mirrorRegistrationToFirestore(db, eventId, uid, raw.registration_data, raw.counters);
      return {
        ok: true,
        alreadyRegistered: false,
        registrationData: raw.registration_data,
        counters: raw.counters,
      };
    }
    case 'already_registered':
      return { ok: true, alreadyRegistered: true };
    case 'not_found':
      throw new RegistrationError('not-found', 404, 'Event not found');
    case 'blacklisted':
      throw new RegistrationError(
        'permission-denied',
        403,
        'Your account is currently blacklisted. Event registration is restricted.',
      );
    case 'registration_closed':
      throw new RegistrationError('failed-precondition', 400, 'Registration is closed for this event');
    case 'full':
      throw new RegistrationError('failed-precondition', 400, 'Sorry, this event is full');
    default:
      throw new Error(
        `[supa-events/registrations] tx_events_register_free returned an unexpected result: ${JSON.stringify(raw)}`,
      );
  }
}
