/**
 * @jest-environment node
 *
 * Unit tests for the registrations Supabase seam
 * (src/lib/supa-events/registrations). The adapter is MOCKED (injected
 * via setRegistrationsSupaAdapterForTests) and the transactions run
 * against FakeFirestore; there are zero live Firestore or Supabase
 * calls in this suite.
 *
 * Covered contract:
 * - Flag OFF (default): reads report "unavailable" (null) and mirrors
 *   no-op, so callers run Firestore byte-identically.
 * - Flag ON + adapter answers: the pre-tx event read comes back with
 *   timestamps normalized to Timestamp-like shapes at the seam — never
 *   a raw {_seconds,_nanoseconds} shape (contract E-REG-P06 hazard).
 * - Flag ON + adapter missing/null or throwing: "unavailable" fallback.
 * - Mirrors address registrations through the subcollection path
 *   'events/<eventId>/registrations' (RULING_REG_TABLE.md: landing
 *   table fs_group_registrations, key (parent_path, id)), serialize
 *   FieldValue sentinels / Dates / Timestamp-likes to ISO strings, and
 *   never throw on adapter failure.
 * - Both transaction bodies keep their verbatim semantics against
 *   FakeFirestore: outcome vocabulary, check order, counter triple,
 *   and the exact written payloads they hand back for mirroring.
 */

const mockUseSupa = jest.fn();
const mockGetSupaClient = jest.fn();
const mockGetSupaAdapter = jest.fn();

jest.mock('@/lib/supa', () => ({
  useSupa: (...args: unknown[]) => mockUseSupa(...args),
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
  getEventForRegistration,
  mirrorEventCounters,
  mirrorRegistrationWrite,
  normalizeSupaData,
  registrationsSupaEnabled,
  runFreeRegistrationTransaction,
  runPaidRegistrationTransaction,
  setRegistrationsSupaAdapterForTests,
  toSupaSerializable,
  type RegistrationsSupaAdapter,
  type TimestampLike,
} from '../registrations';

const ORIGINAL_ENV = process.env.SUPA_SURFACES;

function mockAdapter(overrides: Partial<RegistrationsSupaAdapter> = {}): RegistrationsSupaAdapter {
  return {
    getDoc: jest.fn(async () => null),
    listDocs: jest.fn(async () => []),
    countDocs: jest.fn(async () => 0),
    setDoc: jest.fn(async (_c: string, id: string, data: Record<string, unknown>) => ({ id, ...data })),
    updateDoc: jest.fn(async (_c: string, id: string, data: Record<string, unknown>) => ({ id, ...data })),
    deleteDoc: jest.fn(async () => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  delete process.env.SUPA_SURFACES;
  setRegistrationsSupaAdapterForTests(undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  // The mocked adapter layer reproduces the real flags semantics
  // (SUPA_SURFACES comma list, '*' = all) with a configured client, so
  // the env-driven cases below exercise the seam's own gating.
  mockUseSupa.mockImplementation((surface: string) => {
    const raw = process.env.SUPA_SURFACES;
    if (!raw) return false;
    const surfaces = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    return surfaces.includes('*') || surfaces.includes(String(surface).toLowerCase());
  });
  mockGetSupaClient.mockReturnValue({});
  mockGetSupaAdapter.mockReturnValue(null);
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.SUPA_SURFACES;
  else process.env.SUPA_SURFACES = ORIGINAL_ENV;
  setRegistrationsSupaAdapterForTests(undefined);
  jest.restoreAllMocks();
});

describe('flag gating (adapter-bound, E3 form)', () => {
  it("asks the adapter about the 'events' surface and requires a configured client", () => {
    process.env.SUPA_SURFACES = 'announcements,directory';
    expect(registrationsSupaEnabled()).toBe(false);
    process.env.SUPA_SURFACES = ' Events ';
    expect(registrationsSupaEnabled()).toBe(true);
    expect(mockUseSupa).toHaveBeenCalledWith('events');
    mockGetSupaClient.mockReturnValue(null); // flag on but unconfigured -> off
    expect(registrationsSupaEnabled()).toBe(false);
  });

  it('is OFF by default and ON for *', () => {
    expect(registrationsSupaEnabled()).toBe(false);
    process.env.SUPA_SURFACES = '*';
    expect(registrationsSupaEnabled()).toBe(true);
  });
});

describe('getEventForRegistration', () => {
  it('flag OFF: returns null (Firestore fallback) without touching the adapter', async () => {
    const adapter = mockAdapter();
    setRegistrationsSupaAdapterForTests(adapter);
    await expect(getEventForRegistration('ev-1')).resolves.toBeNull();
    expect(adapter.getDoc).not.toHaveBeenCalled();
  });

  it('flag ON + adapter null: returns null (unconfigured fallback)', async () => {
    process.env.SUPA_SURFACES = 'events';
    setRegistrationsSupaAdapterForTests(null);
    await expect(getEventForRegistration('ev-1')).resolves.toBeNull();
  });

  it('flag ON + adapter throws: returns null (error fallback), never rejects', async () => {
    process.env.SUPA_SURFACES = 'events';
    setRegistrationsSupaAdapterForTests(
      mockAdapter({ getDoc: jest.fn(async () => { throw new Error('pg down'); }) }),
    );
    await expect(getEventForRegistration('ev-1')).resolves.toBeNull();
  });

  it('flag ON + no injection: the adapter comes from the static @/lib/supa binding', async () => {
    process.env.SUPA_SURFACES = 'events';
    const adapter = mockAdapter({
      getDoc: jest.fn(async () => ({ id: 'ev-1', title: 'Via Binding' })),
    });
    mockGetSupaAdapter.mockReturnValue(adapter);
    const result = await getEventForRegistration('ev-1');
    expect(result?.found).toBe(true);
    if (result?.found) expect(result.data.title).toBe('Via Binding');
    expect(adapter.getDoc).toHaveBeenCalledWith('events', 'ev-1');
  });

  it('flag ON + doc missing: authoritative not-found', async () => {
    process.env.SUPA_SURFACES = 'events';
    setRegistrationsSupaAdapterForTests(mockAdapter());
    await expect(getEventForRegistration('nope')).resolves.toEqual({ found: false });
  });

  it('flag ON + doc present: a {_seconds} deadline is normalized to Timestamp-like, never emitted raw (E-REG-P06)', async () => {
    process.env.SUPA_SURFACES = 'events';
    const PAST_SECONDS = Math.floor(Date.UTC(2026, 0, 1) / 1000);
    const adapter = mockAdapter({
      getDoc: jest.fn(async () => ({
        id: 'ev-1',
        title: 'Paid Workshop',
        registrationDeadline: { _seconds: PAST_SECONDS, _nanoseconds: 0 },
        startAt: '2026-11-01T14:00:00.000Z',
      })),
    });
    setRegistrationsSupaAdapterForTests(adapter);

    const result = await getEventForRegistration('ev-1');
    expect(result?.found).toBe(true);
    if (!result?.found) throw new Error('expected found');
    expect(adapter.getDoc).toHaveBeenCalledWith('events', 'ev-1');
    expect(result.data.id).toBeUndefined();

    const deadline = result.data.registrationDeadline as TimestampLike;
    expect(deadline.seconds).toBe(PAST_SECONDS);
    expect((deadline as unknown as Record<string, unknown>)._seconds).toBeUndefined();
    expect(deadline.toDate().getTime()).toBe(PAST_SECONDS * 1000);
    // The paid route's enforcement reads .seconds — it now closes.
    expect(Date.now() > deadline.seconds * 1000).toBe(true);

    const startAt = result.data.startAt as TimestampLike;
    expect(startAt.toMillis()).toBe(Date.parse('2026-11-01T14:00:00.000Z'));
  });
});

describe('mirror writes', () => {
  it('flag OFF: mirrors are no-ops', async () => {
    const adapter = mockAdapter();
    setRegistrationsSupaAdapterForTests(adapter);
    await mirrorRegistrationWrite('ev-1', 'user-1', { status: 'pending' });
    await mirrorEventCounters('ev-1', { attendeeIds: ['user-1'] });
    expect(adapter.setDoc).not.toHaveBeenCalled();
    expect(adapter.updateDoc).not.toHaveBeenCalled();
  });

  it('flag ON: registration mirror is parent-scoped via the subcollection path, with merge:true and sentinels serialized', async () => {
    process.env.SUPA_SURFACES = 'events';
    const adapter = mockAdapter();
    setRegistrationsSupaAdapterForTests(adapter);
    const sentinel = { _methodName: 'FieldValue.serverTimestamp' };
    await mirrorRegistrationWrite('ev-1', 'user-1', {
      uid: 'user-1',
      eventId: 'ev-1',
      status: 'under_review',
      createdAt: sentinel,
      updatedAt: sentinel,
    });
    expect(adapter.setDoc).toHaveBeenCalledTimes(1);
    const [path, id, data, opts] = (adapter.setDoc as jest.Mock).mock.calls[0];
    expect(path).toBe('events/ev-1/registrations'); // NOT top-level 'registrations'
    expect(id).toBe('user-1');
    expect(opts).toEqual({ merge: true });
    expect(data.status).toBe('under_review');
    expect(typeof data.createdAt).toBe('string');
    expect(Number.isNaN(Date.parse(data.createdAt))).toBe(false);
  });

  it('S-REG-02 at the mirror: the same uid under two events produces two distinctly-addressed writes', async () => {
    process.env.SUPA_SURFACES = 'events';
    const adapter = mockAdapter();
    setRegistrationsSupaAdapterForTests(adapter);
    await mirrorRegistrationWrite('ev-1', 'user-1', { eventId: 'ev-1', status: 'pending' });
    await mirrorRegistrationWrite('ev-2', 'user-1', { eventId: 'ev-2', status: 'confirmed' });
    const paths = (adapter.setDoc as jest.Mock).mock.calls.map((c) => `${c[0]}/${c[1]}`);
    expect(paths).toEqual(['events/ev-1/registrations/user-1', 'events/ev-2/registrations/user-1']);
  });

  it('flag ON: counter mirror updates the events doc with the serialized EV-P06 triple', async () => {
    process.env.SUPA_SURFACES = 'events';
    const adapter = mockAdapter();
    setRegistrationsSupaAdapterForTests(adapter);
    await mirrorEventCounters('ev-1', {
      attendeeIds: ['user-1'],
      registered_attendees_uids: ['user-1'],
      registrationsCount: 1,
      updatedAt: { _methodName: 'FieldValue.serverTimestamp' },
    });
    expect(adapter.updateDoc).toHaveBeenCalledTimes(1);
    const [path, id, data] = (adapter.updateDoc as jest.Mock).mock.calls[0];
    expect(path).toBe('events');
    expect(id).toBe('ev-1');
    expect(data.attendeeIds).toEqual(['user-1']);
    expect(data.registered_attendees_uids).toEqual(['user-1']);
    expect(data.registrationsCount).toBe(1);
    expect(typeof data.updatedAt).toBe('string');
  });

  it('flag ON: adapter failure is swallowed (Firestore stays primary)', async () => {
    process.env.SUPA_SURFACES = 'events';
    setRegistrationsSupaAdapterForTests(
      mockAdapter({
        setDoc: jest.fn(async () => { throw new Error('pg down'); }),
        updateDoc: jest.fn(async () => { throw new Error('pg down'); }),
      }),
    );
    await expect(mirrorRegistrationWrite('ev-1', 'user-1', { a: 1 })).resolves.toBeUndefined();
    await expect(mirrorEventCounters('ev-1', { a: 1 })).resolves.toBeUndefined();
  });
});

describe('normalizeSupaData / toSupaSerializable', () => {
  it('converts {seconds,nanoseconds} and leaves plain data alone', () => {
    const out = normalizeSupaData({
      when: { seconds: 1700000000, nanoseconds: 250000000 },
      plainSeconds: { seconds: 5 },
      count: 3,
    }) as Record<string, unknown>;
    expect((out.when as TimestampLike).toMillis()).toBe(1700000000250);
    expect(out.plainSeconds).toEqual({ seconds: 5 });
    expect(out.count).toBe(3);
  });

  it('uses the supplied instant for every sentinel in one payload', () => {
    const now = new Date('2026-10-25T05:00:00.000Z');
    const out = toSupaSerializable({ a: { _methodName: 'x' }, b: [{ _methodName: 'y' }] }, now) as Record<string, unknown>;
    expect(out.a).toBe('2026-10-25T05:00:00.000Z');
    expect((out.b as unknown[])[0]).toBe('2026-10-25T05:00:00.000Z');
  });
});

/* ------------------------------------------------ transactions (verbatim) */

function paidArgs(db: FakeDb, overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'evt-paid',
    uid: 'user-1',
    transactionId: 'txn-1',
    screenshotLink: 'https://example.test/receipt-1',
    paymentMethod: 'manual',
    amount: 500,
    currency: 'PKR',
    buyer: { fullName: 'User One', email: 'one@test.dev' },
    orderRef: db.collection('orders').doc(),
    orderData: { status: 'pending_verification', buyerUserId: 'user-1' },
    ...overrides,
  } as unknown as Parameters<typeof runPaidRegistrationTransaction>[1];
}

describe('runPaidRegistrationTransaction (T-1 verbatim)', () => {
  it('created: writes registration + counters + order and returns the exact written payloads', async () => {
    const db = createFakeDb();
    db.seed('events', 'evt-paid', { title: 'Paid Workshop', status: 'published', capacity: 2, attendeeIds: ['o-1'], registered_attendees_uids: ['o-1'], registrationsCount: 1 });
    const res = await runPaidRegistrationTransaction(db as never, paidArgs(db));
    expect(res.outcome).toBe('created');
    expect(res.registrationData).toMatchObject({ uid: 'user-1', eventId: 'evt-paid', status: 'under_review', paymentStatus: 'pending', transactionId: 'txn-1' });
    expect(res.counters).toEqual({ attendeeIds: ['o-1', 'user-1'], registered_attendees_uids: ['o-1', 'user-1'], registrationsCount: 2, updatedAt: 'ts' });
    expect(db.read('events/evt-paid/registrations', 'user-1')).toEqual(res.registrationData);
    expect(db.all('orders')).toHaveLength(1);
  });

  it('already-registered: a live registration short-circuits with no writes and no payloads', async () => {
    const db = createFakeDb();
    db.seed('events', 'evt-paid', { title: 'Paid Workshop', status: 'published' });
    db.seed('events/evt-paid/registrations', 'user-1', { uid: 'user-1', status: 'confirmed' });
    const res = await runPaidRegistrationTransaction(db as never, paidArgs(db));
    expect(res).toEqual({ outcome: 'already-registered' });
    expect(db.all('orders')).toHaveLength(0);
  });

  it('full: capacity is checked after the duplicate check, against attendeeIds', async () => {
    const db = createFakeDb();
    db.seed('events', 'evt-paid', { title: 'Paid Workshop', status: 'published', capacity: 1, attendeeIds: ['o-1'] });
    const res = await runPaidRegistrationTransaction(db as never, paidArgs(db));
    expect(res).toEqual({ outcome: 'full' });
    expect(db.read('events/evt-paid/registrations', 'user-1')).toBeUndefined();
  });

  it('not-found: a missing event inside the tx reports not-found', async () => {
    const db = createFakeDb();
    const res = await runPaidRegistrationTransaction(db as never, paidArgs(db, { eventId: 'nope' }));
    expect(res).toEqual({ outcome: 'not-found' });
  });
});

describe('runFreeRegistrationTransaction (T-2 verbatim)', () => {
  function seedFree(db: FakeDb, overrides: Record<string, any> = {}) {
    db.seed('events', 'evt-1', {
      title: 'Free Space Talk', status: 'published', registrationOpen: true, capacity: 2,
      attendeeIds: [], registered_attendees_uids: [], registrationsCount: 0,
      paymentDetails: { isPaid: false, method: null }, ...overrides,
    });
    db.seed('users', 'user-1', { displayName: 'User One', email: 'one@test.dev' });
  }

  it('fresh registration: returns the exact written payloads and moves the counter triple', async () => {
    const db = createFakeDb();
    seedFree(db);
    const res = await runFreeRegistrationTransaction(db as never, { eventId: 'evt-1', uid: 'user-1', data: { whatsappE164: '+923001234567' } });
    expect(res.alreadyRegistered).toBe(false);
    expect(res.registrationData).toMatchObject({ uid: 'user-1', status: 'pending', paymentStatus: 'verified', whatsappE164: '+923001234567' });
    expect(res.counters).toEqual({ attendeeIds: ['user-1'], registered_attendees_uids: ['user-1'], registrationsCount: 1, updatedAt: 'ts' });
    expect(db.read('events/evt-1/registrations', 'user-1')).toEqual(res.registrationData);
  });

  it('duplicate: idempotent success with NO writes and NO payloads', async () => {
    const db = createFakeDb();
    seedFree(db);
    db.seed('events/evt-1/registrations', 'user-1', { uid: 'user-1', status: 'pending' });
    const res = await runFreeRegistrationTransaction(db as never, { eventId: 'evt-1', uid: 'user-1', data: {} });
    expect(res).toEqual({ ok: true, alreadyRegistered: true });
  });

  it('check order: blacklist (403) fires before the published/open gate', async () => {
    const db = createFakeDb();
    seedFree(db, { status: 'draft' });
    db.seed('users', 'user-1', { displayName: 'User One', isBlacklisted: true });
    db.seed('warningConfig', 'global', { enforcementEnabled: true });
    await expect(
      runFreeRegistrationTransaction(db as never, { eventId: 'evt-1', uid: 'user-1', data: {} }),
    ).rejects.toMatchObject({ code: 'permission-denied', httpStatus: 403 });
  });

  it('check order: deleted fires before blacklist, as not-found', async () => {
    const db = createFakeDb();
    seedFree(db, { deleted: true });
    db.seed('users', 'user-1', { displayName: 'User One', isBlacklisted: true });
    await expect(
      runFreeRegistrationTransaction(db as never, { eventId: 'evt-1', uid: 'user-1', data: {} }),
    ).rejects.toBeInstanceOf(RegistrationError);
    await expect(
      runFreeRegistrationTransaction(db as never, { eventId: 'evt-1', uid: 'user-1', data: {} }),
    ).rejects.toMatchObject({ code: 'not-found', httpStatus: 404 });
  });

  it('capacity: a full event throws failed-precondition after the duplicate check', async () => {
    const db = createFakeDb();
    seedFree(db, { capacity: 1, attendeeIds: ['o-1'], registered_attendees_uids: ['o-1'], registrationsCount: 1 });
    await expect(
      runFreeRegistrationTransaction(db as never, { eventId: 'evt-1', uid: 'user-1', data: {} }),
    ).rejects.toMatchObject({ code: 'failed-precondition', httpStatus: 400 });
    expect(db.all('events/evt-1/registrations')).toHaveLength(0);
  });
});
