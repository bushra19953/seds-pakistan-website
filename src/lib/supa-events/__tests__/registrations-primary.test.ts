/**
 * @jest-environment node
 *
 * Cutover contracts for E2-TX-1 / E2-TX-2 (events write primacy).
 *
 * Transport is MOCKED (the injected adapter's tx() is a jest fn whose
 * return values simulate the Postgres functions' jsonb results); the
 * Firestore side is FakeFirestore. Zero live calls.
 *
 * Pinned here:
 * - FLAG LAW: registrationsSupaPrimary() is true only when 'events'
 *   is in BOTH SUPA_SURFACES and SUPA_PRIMARY (with a client). With
 *   SUPA_PRIMARY off, the primary entry points are never the writer —
 *   the existing Firestore transaction suites pin that path
 *   byte-identically (registrations.test.ts, registrations-parity,
 *   parity-audit-e2, both route suites).
 * - ON-path call shape: exactly one tx() call per registration, the
 *   conventional function name, the p_* argument bag, and the
 *   origin-minted idempotency key (paid: pay:<event>:<uid>:<txnId>;
 *   free: free:<event>:<uid>).
 * - Outcome / error mapping: the tx result vocabulary maps back to
 *   the EXACT existing surface — PaidRegistrationOutcome for paid;
 *   RegistrationError code + HTTP status + message for free (the
 *   UI-visible errors are today's).
 * - Post-commit Firestore mirror: on 'created', the registration +
 *   counter triple (and, for paid, the order) land in Firestore with
 *   ISO timestamps converted back to Dates; a mirror failure is
 *   logged and swallowed, never failing the registration.
 * - Replay: a second call with the SAME idempotency key whose tx
 *   result is the recorded outcome (applied:false, duplicate:true)
 *   produces no double registration and no double counter — the
 *   mirror writes the recorded absolute payloads, not increments.
 * - SQL shape: the authored functions carry the foundation patterns
 *   (entity-scoped advisory lock BEFORE the capacity re-check,
 *   capacity re-checked inside, fs_tx_idempotency recorded inside).
 */

import * as fs from 'fs';
import * as path from 'path';

const mockUseSupa = jest.fn();
const mockIsSupaPrimary = jest.fn();
const mockGetSupaClient = jest.fn();
const mockGetSupaAdapter = jest.fn();

jest.mock('@/lib/supa', () => ({
  useSupa: (...args: unknown[]) => mockUseSupa(...args),
  isSupaPrimary: (...args: unknown[]) => mockIsSupaPrimary(...args),
  getSupaClient: () => mockGetSupaClient(),
  getSupaAdapter: () => mockGetSupaAdapter(),
}));

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    firestore: {
      FieldValue: { serverTimestamp: () => 'ts' },
    },
  },
}));

import { createFakeDb, type FakeDb } from '@/lib/server/__tests__/fake-firestore';
import {
  RegistrationError,
  registrationsSupaPrimary,
  runFreeRegistrationPrimary,
  runPaidRegistrationPrimary,
  setRegistrationsSupaAdapterForTests,
  type RegistrationsSupaAdapter,
} from '../registrations';

/* ------------------------------------------------------------ flag mock */

function tokens(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}
function inTokens(raw: string | undefined, surface: string): boolean {
  const t = tokens(raw);
  return t.has('*') || t.has(surface.toLowerCase());
}

const ISO = '2026-10-26T01:00:00.000Z';

function paidCreatedResult() {
  return {
    applied: true,
    duplicate: false,
    outcome: 'created',
    reason: null,
    registration_data: {
      uid: 'user-1',
      eventId: 'evt-paid',
      transactionId: 'txn-1',
      screenshotLink: 'https://example.test/receipt-1',
      displayName: 'User One',
      email: 'one@test.dev',
      status: 'under_review',
      paymentStatus: 'pending',
      paymentMethod: 'manual',
      amount: 500,
      currency: 'PKR',
      createdAt: ISO,
      updatedAt: ISO,
    },
    counters: {
      attendeeIds: ['o-1', 'user-1'],
      registered_attendees_uids: ['o-1', 'user-1'],
      registrationsCount: 2,
      updatedAt: ISO,
    },
    order_id: 'order-1',
  };
}

function freeCreatedResult() {
  return {
    applied: true,
    duplicate: false,
    outcome: 'created',
    reason: null,
    already_registered: false,
    registration_data: {
      uid: 'user-1',
      eventId: 'evt-1',
      displayName: 'User One',
      email: 'one@test.dev',
      whatsappE164: '+923001234567',
      status: 'pending',
      paymentStatus: 'verified',
      paymentMethod: null,
      paymentRef: null,
      createdAt: ISO,
      updatedAt: ISO,
    },
    counters: {
      attendeeIds: ['user-1'],
      registered_attendees_uids: ['user-1'],
      registrationsCount: 1,
      updatedAt: ISO,
    },
  };
}

function mockTxAdapter(txImpl: jest.Mock): RegistrationsSupaAdapter {
  return {
    getDoc: jest.fn(async () => null),
    listDocs: jest.fn(async () => []),
    countDocs: jest.fn(async () => 0),
    setDoc: jest.fn(async (_c: string, id: string, data: Record<string, unknown>) => ({ id, ...data })),
    updateDoc: jest.fn(async (_c: string, id: string, data: Record<string, unknown>) => ({ id, ...data })),
    deleteDoc: jest.fn(async () => undefined),
    tx: txImpl as RegistrationsSupaAdapter['tx'],
  };
}

function paidArgs(db: FakeDb) {
  const orderRef = db.collection('orders').doc('order-1');
  return {
    eventId: 'evt-paid',
    uid: 'user-1',
    transactionId: 'txn-1',
    screenshotLink: 'https://example.test/receipt-1',
    paymentMethod: 'manual',
    amount: 500,
    currency: 'PKR',
    buyer: { fullName: 'User One', email: 'one@test.dev' },
    orderRef: orderRef as never,
    orderData: {
      status: 'pending_verification',
      buyerUserId: 'user-1',
      amount: 500,
      createdAt: { _methodName: 'FieldValue.serverTimestamp' },
    },
  } as unknown as Parameters<typeof runPaidRegistrationPrimary>[1];
}

function seedPaidEvent(db: FakeDb) {
  db.seed('events', 'evt-paid', {
    title: 'Paid Workshop', status: 'published', capacity: 2,
    attendeeIds: ['o-1'], registered_attendees_uids: ['o-1'], registrationsCount: 1,
  });
}

beforeEach(() => {
  delete process.env.SUPA_SURFACES;
  delete process.env.SUPA_PRIMARY;
  setRegistrationsSupaAdapterForTests(undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  // Faithful reproduction of the real flags semantics (both-flags law).
  mockUseSupa.mockImplementation((surface: string) => inTokens(process.env.SUPA_SURFACES, String(surface)));
  mockIsSupaPrimary.mockImplementation(
    (surface: string) =>
      inTokens(process.env.SUPA_SURFACES, String(surface)) &&
      inTokens(process.env.SUPA_PRIMARY, String(surface)),
  );
  mockGetSupaClient.mockReturnValue({});
  mockGetSupaAdapter.mockReturnValue(null);
});

afterEach(() => {
  delete process.env.SUPA_SURFACES;
  delete process.env.SUPA_PRIMARY;
  setRegistrationsSupaAdapterForTests(undefined);
  jest.restoreAllMocks();
});

function primaryOn() {
  process.env.SUPA_SURFACES = 'events';
  process.env.SUPA_PRIMARY = 'events';
}

/* ------------------------------------------------------------------ flag law */

describe('registrationsSupaPrimary (FLAG LAW)', () => {
  it('is OFF by default, OFF with SUPA_SURFACES alone, OFF with SUPA_PRIMARY alone', () => {
    expect(registrationsSupaPrimary()).toBe(false);
    process.env.SUPA_SURFACES = 'events';
    expect(registrationsSupaPrimary()).toBe(false);
    delete process.env.SUPA_SURFACES;
    process.env.SUPA_PRIMARY = 'events';
    expect(registrationsSupaPrimary()).toBe(false);
  });

  it('is ON only when events is in both, and requires a configured client', () => {
    primaryOn();
    expect(registrationsSupaPrimary()).toBe(true);
    expect(mockIsSupaPrimary).toHaveBeenCalledWith('events');
    mockGetSupaClient.mockReturnValue(null);
    expect(registrationsSupaPrimary()).toBe(false);
  });
});

/* ------------------------------------------------------------- paid (E2-TX-1) */

describe('runPaidRegistrationPrimary (E2-TX-1)', () => {
  it('issues exactly ONE tx() call: conventional name, p_* args, origin-minted idempotency key', async () => {
    primaryOn();
    const tx = jest.fn(async () => paidCreatedResult());
    setRegistrationsSupaAdapterForTests(mockTxAdapter(tx));
    const db = createFakeDb();
    seedPaidEvent(db);

    const res = await runPaidRegistrationPrimary(db as never, paidArgs(db));

    expect(res.outcome).toBe('created');
    expect(tx).toHaveBeenCalledTimes(1);
    const [fn, args, opts] = tx.mock.calls[0] as unknown as [string, Record<string, unknown>, { idempotencyKey: string }];
    expect(fn).toBe('tx_events_register_paid');
    expect(args.p_event_id).toBe('evt-paid');
    expect(args.p_uid).toBe('user-1');
    expect(args.p_transaction_id).toBe('txn-1');
    expect(args.p_order_id).toBe('order-1');
    // The order payload is serialized for jsonb: the serverTimestamp
    // sentinel became an ISO string before the call.
    const orderData = args.p_order_data as Record<string, unknown>;
    expect(orderData.status).toBe('pending_verification');
    expect(typeof orderData.createdAt).toBe('string');
    expect(opts).toEqual({ idempotencyKey: 'pay:evt-paid:user-1:txn-1' });
  });

  it('mirrors post-commit to Firestore: registration + counter triple + order, ISO timestamps back to Dates', async () => {
    primaryOn();
    const tx = jest.fn(async () => paidCreatedResult());
    setRegistrationsSupaAdapterForTests(mockTxAdapter(tx));
    const db = createFakeDb();
    seedPaidEvent(db);
    const args = paidArgs(db);

    const res = await runPaidRegistrationPrimary(db as never, args);

    expect(res.registrationData).toMatchObject({ status: 'under_review', paymentStatus: 'pending' });
    expect(res.counters).toMatchObject({ registrationsCount: 2 });

    const reg = db.read('events/evt-paid/registrations', 'user-1')!;
    expect(reg.status).toBe('under_review');
    expect(reg.createdAt).toBeInstanceOf(Date);
    expect((reg.createdAt as Date).toISOString()).toBe(ISO);
    const event = db.read('events', 'evt-paid')!;
    expect(event.attendeeIds).toEqual(['o-1', 'user-1']);
    expect(event.registered_attendees_uids).toEqual(['o-1', 'user-1']);
    expect(event.registrationsCount).toBe(2);
    expect(event.updatedAt).toBeInstanceOf(Date);
    // The order mirror is the route's own order doc, verbatim.
    expect(db.read('orders', 'order-1')).toEqual(args.orderData);
  });

  it('maps full / already_registered / not_found to the existing outcome vocabulary, with NO Firestore writes', async () => {
    primaryOn();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ applied: false, duplicate: false, outcome: 'full', reason: 'sold_out' }, 'full'],
      [{ applied: false, duplicate: true, outcome: 'already_registered', reason: 'already_registered' }, 'already-registered'],
      [{ applied: false, duplicate: false, outcome: 'not_found', reason: 'not_found' }, 'not-found'],
    ];
    for (const [txResult, expected] of cases) {
      const tx = jest.fn(async () => txResult);
      setRegistrationsSupaAdapterForTests(mockTxAdapter(tx));
      const db = createFakeDb();
      seedPaidEvent(db);
      const res = await runPaidRegistrationPrimary(db as never, paidArgs(db));
      expect(res).toEqual({ outcome: expected });
      expect(db.all('events/evt-paid/registrations')).toHaveLength(0);
      expect(db.all('orders')).toHaveLength(0);
      expect(db.read('events', 'evt-paid')?.registrationsCount).toBe(1);
    }
  });

  it('replay: the same idempotency key returns the recorded outcome — no double registration, no double counter, no second order', async () => {
    primaryOn();
    const created = paidCreatedResult();
    const replayed = { ...created, applied: false, duplicate: true };
    const tx = jest.fn()
      .mockResolvedValueOnce(created)
      .mockResolvedValueOnce(replayed);
    setRegistrationsSupaAdapterForTests(mockTxAdapter(tx));
    const db = createFakeDb();
    seedPaidEvent(db);
    const args = paidArgs(db);

    const first = await runPaidRegistrationPrimary(db as never, args);
    const second = await runPaidRegistrationPrimary(db as never, args);

    expect(first.outcome).toBe('created');
    expect(second.outcome).toBe('created');
    // Both attempts presented the SAME origin key to the function.
    const keys = tx.mock.calls.map((c) => (c[2] as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toEqual(['pay:evt-paid:user-1:txn-1', 'pay:evt-paid:user-1:txn-1']);
    // The mirror writes absolute payloads, so replaying it moves nothing twice.
    expect(db.all('events/evt-paid/registrations')).toHaveLength(1);
    expect(db.all('orders')).toHaveLength(1);
    expect(db.read('events', 'evt-paid')?.registrationsCount).toBe(2);
    expect(db.read('events', 'evt-paid')?.attendeeIds).toEqual(['o-1', 'user-1']);
  });

  it('a Firestore mirror failure does not fail the committed registration', async () => {
    primaryOn();
    const tx = jest.fn(async () => paidCreatedResult());
    setRegistrationsSupaAdapterForTests(mockTxAdapter(tx));
    const db = createFakeDb(); // event NOT seeded: the mirror's update() throws
    const res = await runPaidRegistrationPrimary(db as never, paidArgs(db));
    expect(res.outcome).toBe('created');
    expect(console.error).toHaveBeenCalled();
  });

  it('refuses to fall back when the adapter has no tx() (loud error, no Firestore transaction)', async () => {
    primaryOn();
    const noTx: RegistrationsSupaAdapter = {
      getDoc: jest.fn(async () => null),
      listDocs: jest.fn(async () => []),
      countDocs: jest.fn(async () => 0),
      setDoc: jest.fn(async (_c: string, id: string, data: Record<string, unknown>) => ({ id, ...data })),
      updateDoc: jest.fn(async (_c: string, id: string, data: Record<string, unknown>) => ({ id, ...data })),
      deleteDoc: jest.fn(async () => undefined),
    };
    setRegistrationsSupaAdapterForTests(noTx);
    const db = createFakeDb();
    seedPaidEvent(db);
    await expect(runPaidRegistrationPrimary(db as never, paidArgs(db))).rejects.toThrow(/no tx\(\) primitive/);
    expect(db.all('events/evt-paid/registrations')).toHaveLength(0);
    expect(db.all('orders')).toHaveLength(0);
  });
});

/* ------------------------------------------------------------- free (E2-TX-2) */

describe('runFreeRegistrationPrimary (E2-TX-2)', () => {
  it('issues exactly ONE tx() call: conventional name, p_* args, origin-minted idempotency key', async () => {
    primaryOn();
    const tx = jest.fn(async () => freeCreatedResult());
    setRegistrationsSupaAdapterForTests(mockTxAdapter(tx));
    const db = createFakeDb();
    db.seed('events', 'evt-1', { title: 'Free Talk', status: 'published', attendeeIds: [], registered_attendees_uids: [], registrationsCount: 0 });

    const res = await runFreeRegistrationPrimary(db as never, {
      eventId: 'evt-1', uid: 'user-1', data: { whatsappE164: '+923001234567' },
    });

    expect(res).toMatchObject({ ok: true, alreadyRegistered: false });
    expect(tx).toHaveBeenCalledTimes(1);
    const [fn, args, opts] = tx.mock.calls[0] as unknown as [string, Record<string, unknown>, { idempotencyKey: string }];
    expect(fn).toBe('tx_events_register_free');
    expect(args).toEqual({
      p_event_id: 'evt-1',
      p_uid: 'user-1',
      p_whatsapp_e164: '+923001234567',
      p_payment_method: null,
    });
    expect(opts).toEqual({ idempotencyKey: 'free:evt-1:user-1' });
    // Post-commit Firestore mirror landed.
    const reg = db.read('events/evt-1/registrations', 'user-1')!;
    expect(reg.status).toBe('pending');
    expect(reg.createdAt).toBeInstanceOf(Date);
    expect(db.read('events', 'evt-1')?.registrationsCount).toBe(1);
  });

  it('duplicate maps to the idempotent success with NO Firestore writes', async () => {
    primaryOn();
    const tx = jest.fn(async () => ({
      applied: false, duplicate: true, outcome: 'already_registered',
      reason: 'already_registered', already_registered: true,
    }));
    setRegistrationsSupaAdapterForTests(mockTxAdapter(tx));
    const db = createFakeDb();
    db.seed('events', 'evt-1', { title: 'Free Talk', status: 'published', attendeeIds: [], registrationsCount: 0 });
    const res = await runFreeRegistrationPrimary(db as never, { eventId: 'evt-1', uid: 'user-1', data: {} });
    expect(res).toEqual({ ok: true, alreadyRegistered: true });
    expect(db.all('events/evt-1/registrations')).toHaveLength(0);
  });

  it('rejection reasons map to the EXACT existing RegistrationError surface (code, status, message)', async () => {
    primaryOn();
    const cases: Array<[string, string, number, string]> = [
      ['not_found', 'not-found', 404, 'Event not found'],
      ['blacklisted', 'permission-denied', 403, 'Your account is currently blacklisted. Event registration is restricted.'],
      ['registration_closed', 'failed-precondition', 400, 'Registration is closed for this event'],
      ['full', 'failed-precondition', 400, 'Sorry, this event is full'],
    ];
    for (const [outcome, code, httpStatus, message] of cases) {
      const tx = jest.fn(async () => ({
        applied: false, duplicate: false, outcome,
        reason: outcome === 'full' ? 'sold_out' : outcome, already_registered: false,
      }));
      setRegistrationsSupaAdapterForTests(mockTxAdapter(tx));
      const db = createFakeDb();
      db.seed('events', 'evt-1', { title: 'Free Talk', status: 'published', attendeeIds: [], registrationsCount: 0 });
      const err = await runFreeRegistrationPrimary(db as never, { eventId: 'evt-1', uid: 'user-1', data: {} })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RegistrationError);
      expect(err).toMatchObject({ code, httpStatus, message });
      expect(db.all('events/evt-1/registrations')).toHaveLength(0);
    }
  });

  it('replay: the same idempotency key replays the recorded outcome — counters move once', async () => {
    primaryOn();
    const created = freeCreatedResult();
    const replayed = { ...created, applied: false, duplicate: true };
    const tx = jest.fn()
      .mockResolvedValueOnce(created)
      .mockResolvedValueOnce(replayed);
    setRegistrationsSupaAdapterForTests(mockTxAdapter(tx));
    const db = createFakeDb();
    db.seed('events', 'evt-1', { title: 'Free Talk', status: 'published', attendeeIds: [], registered_attendees_uids: [], registrationsCount: 0 });
    const args = { eventId: 'evt-1', uid: 'user-1', data: { whatsappE164: '+923001234567' } };

    await runFreeRegistrationPrimary(db as never, args);
    const second = await runFreeRegistrationPrimary(db as never, args);

    expect(second.alreadyRegistered).toBe(false);
    const keys = tx.mock.calls.map((c) => (c[2] as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toEqual(['free:evt-1:user-1', 'free:evt-1:user-1']);
    expect(db.all('events/evt-1/registrations')).toHaveLength(1);
    expect(db.read('events', 'evt-1')?.registrationsCount).toBe(1);
    expect(db.read('events', 'evt-1')?.attendeeIds).toEqual(['user-1']);
  });
});

/* ---------------------------------------------------------------- SQL shape */

describe('authored SQL (E2-TX-1 / E2-TX-2 shape)', () => {
  const sqlDir = path.join(__dirname, '..', '..', 'supa', 'sql');
  const paid = fs.readFileSync(path.join(sqlDir, 'tx_events_register_paid.sql'), 'utf8');
  const free = fs.readFileSync(path.join(sqlDir, 'tx_events_register_free.sql'), 'utf8');

  it.each([
    ['paid', paid, 'tx_events_register_paid'],
    ['free', free, 'tx_events_register_free'],
  ])('%s: create-or-replace, entity-scoped advisory lock BEFORE the in-function capacity re-check, idempotency recorded inside', (_label, sql, fn) => {
    expect(sql).toContain(`create or replace function ${fn}(`);
    const lockAt = sql.indexOf("pg_advisory_xact_lock(hashtextextended('event:' || p_event_id, 0))");
    expect(lockAt).toBeGreaterThan(-1);
    const capacityAt = sql.indexOf("reason', 'sold_out'");
    expect(capacityAt).toBeGreaterThan(lockAt); // capacity is re-checked INSIDE, after the lock
    expect(sql).toContain('from fs_tx_idempotency');
    expect(sql).toContain('insert into fs_tx_idempotency');
    expect(sql).toContain('fs_group_registrations');
    expect(sql).toContain("'events/' || p_event_id || '/registrations'");
    expect(sql.toLowerCase()).not.toContain('commit;');
    expect(sql.toLowerCase()).not.toContain('exception when others');
  });

  it('paid: the orders row is written inside the same function', () => {
    expect(paid).toContain('insert into fs_orders');
    expect(paid).toContain('for update');
  });

  it('free: the foreign snapshots (fs_users blacklist, fs_warningConfig enforcement) are read inside the function', () => {
    expect(free).toContain('from fs_users');
    expect(free).toContain('from "fs_warningConfig"');
    expect(free).toContain('for update');
  });
});
