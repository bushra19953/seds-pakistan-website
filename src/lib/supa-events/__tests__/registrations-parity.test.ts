/**
 * @jest-environment node
 *
 * S-E2E-01 (VERIFICATION_SPEC seam contracts): flag-on / flag-off parity
 * for BOTH registration routes. With SUPA_SURFACES=events and the seam's
 * adapter mocked, POST /api/event-registrations and POST
 * /registerForEvent must reproduce the E-REG-P / E-REG-F behaviors
 * byte-identically vs flag-off — envelopes, the EV-P06 counter triple,
 * duplicate idempotency (incl. cancelled-replace), capacity edges
 * (0 / missing / full), deadline arms (incl. equal-to-now and string
 * deadlines), and the paid route's missing publication gate — AND the
 * mock adapter must receive exactly the mirrored registration + counter
 * writes, parent-scoped per S-REG-01..05.
 *
 * The adapter is mocked at the '@/lib/supa' module boundary (E3 form);
 * Firestore is FakeFirestore. Zero live reads.
 */

const mockDbHolder: { db: unknown } = { db: null };
const mockSend = jest.fn(async () => undefined);
const mockBroadcast = jest.fn(async () => undefined);
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
    auth: () => ({
      verifyIdToken: async (token: string) => ({ uid: token.replace('token-', '') }),
    }),
    firestore: {
      FieldValue: { serverTimestamp: () => 'ts' },
    },
  },
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: mockSend, broadcastByRoles: mockBroadcast },
}));

jest.mock('@/config/permissions.config', () => ({
  permissionsConfig: { canManageEvents: ['founder_patron'] },
}));

import { NextRequest } from 'next/server';
import { createFakeDb, type FakeDb } from '@/lib/server/__tests__/fake-firestore';
import { POST as paidPOST } from '@/app/api/event-registrations/route';
import { POST as freePOST } from '@/app/registerForEvent/route';
import type { RegistrationsSupaAdapter } from '../registrations';

/* ------------------------------------------------------------ mock adapter */

/**
 * Recording adapter double. `events` seeds the fs_events reads (the paid
 * route's pre-tx read); setDoc/updateDoc calls are recorded verbatim.
 */
function createRecordingAdapter(events: Record<string, Record<string, any>> = {}) {
  const writes: Array<{ op: string; path: string; id: string; data: any; opts?: any }> = [];
  const adapter: RegistrationsSupaAdapter & { writes: typeof writes } = {
    writes,
    getDoc: jest.fn(async (path: string, id: string) => {
      if (path !== 'events') return null;
      const data = events[id];
      return data ? { id, ...JSON.parse(JSON.stringify(data)) } : null;
    }),
    listDocs: jest.fn(async () => []),
    countDocs: jest.fn(async () => 0),
    setDoc: jest.fn(async (path: string, id: string, data: Record<string, unknown>, opts?: any) => {
      writes.push({ op: 'setDoc', path, id, data, opts });
      return { id, ...data };
    }),
    updateDoc: jest.fn(async (path: string, id: string, data: Record<string, unknown>) => {
      writes.push({ op: 'updateDoc', path, id, data });
      return { id, ...data };
    }),
    deleteDoc: jest.fn(async () => undefined),
  };
  return adapter;
}

type RecordingAdapter = ReturnType<typeof createRecordingAdapter>;

/* -------------------------------------------------------------- harness */

const ORIGINAL_ENV = process.env.SUPA_SURFACES;

function db(): FakeDb {
  return mockDbHolder.db as FakeDb;
}

function setFlag(on: boolean, adapter?: RecordingAdapter) {
  if (on) process.env.SUPA_SURFACES = 'events';
  else delete process.env.SUPA_SURFACES;
  mockGetSupaAdapter.mockReturnValue(adapter ?? null);
}

function paidReq(body: unknown, token = 'token-user-1') {
  return new NextRequest('http://localhost/api/event-registrations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function freeReq(body: unknown, token = 'token-user-1') {
  return new NextRequest('http://localhost/registerForEvent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

const PAID_BODY = {
  eventId: 'evt-paid',
  transactionId: 'txn-1',
  screenshotLink: 'https://example.test/receipt-1',
  paymentMethod: 'manual',
  amount: 500,
  currency: 'PKR',
  buyer: { fullName: 'User One', email: 'one@test.dev' },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUseSupa.mockImplementation((surface: string) => {
    const raw = process.env.SUPA_SURFACES;
    if (!raw) return false;
    const surfaces = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    return surfaces.includes('*') || surfaces.includes(String(surface).toLowerCase());
  });
  mockGetSupaClient.mockReturnValue({});
  mockGetSupaAdapter.mockReturnValue(null);
  mockDbHolder.db = createFakeDb();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.SUPA_SURFACES;
  else process.env.SUPA_SURFACES = ORIGINAL_ENV;
  (console.error as jest.Mock).mockRestore?.();
  jest.restoreAllMocks();
});

/** Run a paid scenario in one flag state with a fresh FakeDb. */
async function runPaid(
  on: boolean,
  seedFirestore: (db: FakeDb) => void,
  adapterEvents: Record<string, Record<string, any>>,
  act: () => Promise<{ status: number; body: any }>,
) {
  mockDbHolder.db = createFakeDb();
  db().seed('users', 'user-1', { displayName: 'User One', email: 'one@test.dev' });
  seedFirestore(db());
  const adapter = createRecordingAdapter(adapterEvents);
  setFlag(on, adapter);
  const result = await act();
  return { ...result, adapter, fakeDb: db() };
}

/* ================================================================== paid */

describe('S-E2E-01 paid route parity (POST /api/event-registrations)', () => {
  const seed = (fields: Record<string, any> = {}) => (d: FakeDb) =>
    d.seed('events', 'evt-paid', { title: 'Paid Workshop', status: 'published', ...fields });
  const adapterSeed = (fields: Record<string, any> = {}) => ({
    'evt-paid': { title: 'Paid Workshop', status: 'published', ...fields },
  });
  const submit = async () => {
    const res = await paidPOST(paidReq(PAID_BODY));
    return { status: res.status, body: await res.json() };
  };

  it('fresh submission: byte-identical response + Firestore state, and exactly the mirrored writes when ON', async () => {
    const off = await runPaid(false, seed(), adapterSeed(), submit);
    const on = await runPaid(true, seed(), adapterSeed(), submit);

    expect(on.status).toBe(off.status);
    expect(on.body).toEqual(off.body);
    expect(on.body).toEqual({
      ok: true,
      message: 'Proof submitted. An admin will verify your payment and confirm your registration shortly.',
    });
    expect(on.fakeDb.read('events/evt-paid/registrations', 'user-1'))
      .toEqual(off.fakeDb.read('events/evt-paid/registrations', 'user-1'));
    expect(on.fakeDb.read('events', 'evt-paid')).toEqual(off.fakeDb.read('events', 'evt-paid'));
    expect(on.fakeDb.all('orders')).toHaveLength(1); // orders stay Firestore-only (C-1)

    // Flag OFF touches the adapter never; flag ON mirrors exactly two writes.
    expect(off.adapter.writes).toHaveLength(0);
    expect(on.adapter.writes).toHaveLength(2);
    const [regWrite, counterWrite] = on.adapter.writes;
    expect(regWrite.op).toBe('setDoc');
    expect(regWrite.path).toBe('events/evt-paid/registrations'); // parent-scoped (S-REG)
    expect(regWrite.id).toBe('user-1');
    expect(regWrite.opts).toEqual({ merge: true });
    expect(regWrite.data).toEqual(off.fakeDb.read('events/evt-paid/registrations', 'user-1'));
    expect(counterWrite.op).toBe('updateDoc');
    expect(counterWrite.path).toBe('events');
    expect(counterWrite.id).toBe('evt-paid');
    expect(counterWrite.data).toEqual({
      attendeeIds: ['user-1'],
      registered_attendees_uids: ['user-1'],
      registrationsCount: 1,
      updatedAt: 'ts',
    });
    // The orders doc is never mirrored.
    expect(on.adapter.writes.some((w) => w.path === 'orders')).toBe(false);
  });

  it('duplicate: alreadyRegistered in both modes; the mirror fires once total when ON', async () => {
    const seq = async () => {
      const first = await submit();
      const second = await submit();
      return { status: second.status, body: second.body, first };
    };
    const off = await runPaid(false, seed(), adapterSeed(), seq);
    const on = await runPaid(true, seed(), adapterSeed(), seq);
    expect(on.status).toBe(200);
    expect(on.body).toEqual(off.body);
    expect(on.body.alreadyRegistered).toBe(true);
    expect(on.fakeDb.all('orders')).toHaveLength(1);
    expect(on.adapter.writes).toHaveLength(2); // only the first submission mirrored
  });

  it('cancelled-replace: a cancelled registration is replaced and mirrored in both modes', async () => {
    const withCancelled = (fields: Record<string, any> = {}) => (d: FakeDb) => {
      seed(fields)(d);
      d.seed('events/evt-paid/registrations', 'user-1', {
        uid: 'user-1', eventId: 'evt-paid', status: 'cancelled', paymentStatus: 'unpaid', transactionId: 'txn-old',
      });
    };
    const off = await runPaid(false, withCancelled(), adapterSeed(), submit);
    const on = await runPaid(true, withCancelled(), adapterSeed(), submit);
    expect(on.status).toBe(200);
    expect(on.body).toEqual(off.body);
    expect(on.fakeDb.read('events/evt-paid/registrations', 'user-1')!.transactionId).toBe('txn-1');
    expect(on.adapter.writes).toHaveLength(2);
    expect(on.adapter.writes[0].data.transactionId).toBe('txn-1');
  });

  it('capacity full: 400 in both modes, nothing written, nothing mirrored', async () => {
    const full = { capacity: 1, attendeeIds: ['o-1'], registered_attendees_uids: ['o-1'], registrationsCount: 1 };
    const off = await runPaid(false, seed(full), adapterSeed(full), submit);
    const on = await runPaid(true, seed(full), adapterSeed(full), submit);
    expect(on.status).toBe(400);
    expect(on.body).toEqual({ error: 'Sorry, this event is full' });
    expect(on.body).toEqual(off.body);
    expect(on.fakeDb.read('events/evt-paid/registrations', 'user-1')).toBeUndefined();
    expect(on.adapter.writes).toHaveLength(0);
  });

  it('capacity 0 is uncapped in both modes', async () => {
    const zero = { capacity: 0, attendeeIds: ['a', 'b'], registered_attendees_uids: ['a', 'b'], registrationsCount: 2 };
    const off = await runPaid(false, seed(zero), adapterSeed(zero), submit);
    const on = await runPaid(true, seed(zero), adapterSeed(zero), submit);
    expect(on.status).toBe(200);
    expect(on.body).toEqual(off.body);
    expect(on.fakeDb.read('events', 'evt-paid')!.registrationsCount).toBe(3);
  });

  it('no publication gate (E-REG-P08): a draft event accepts a proof in both modes', async () => {
    const draft = { status: 'draft' };
    const off = await runPaid(false, seed(draft), adapterSeed(draft), submit);
    const on = await runPaid(true, seed(draft), adapterSeed(draft), submit);
    expect(on.status).toBe(200);
    expect(on.body).toEqual(off.body);
    expect(on.adapter.writes).toHaveLength(2);
  });

  it('deadline as a date string in the past: 400 in both modes (flag-on read carries it as ISO)', async () => {
    const past = '2026-01-01T00:00:00.000Z';
    const off = await runPaid(false, seed({ registrationDeadline: past }), adapterSeed({ registrationDeadline: past }), submit);
    const on = await runPaid(true, seed({ registrationDeadline: past }), adapterSeed({ registrationDeadline: past }), submit);
    expect(on.status).toBe(400);
    expect(on.body).toEqual({
      error: 'Registration has closed. The deadline for this event has passed.',
    });
    expect(on.body).toEqual(off.body);
    expect(on.adapter.writes).toHaveLength(0);
  });

  it('deadline exactly equal to now is NOT closed in either mode (strictly-greater)', async () => {
    const exactSeconds = 1_800_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(exactSeconds * 1000);
    const dl = { registrationDeadline: { seconds: exactSeconds, nanoseconds: 0 } };
    const off = await runPaid(false, seed(dl), adapterSeed(dl), submit);
    const on = await runPaid(true, seed(dl), adapterSeed(dl), submit);
    expect(off.status).toBe(200);
    expect(on.status).toBe(200);
    expect(on.body).toEqual(off.body);
  });

  it('flag-selected read: a past deadline known only to the adapter closes registration when ON, and only when ON', async () => {
    // Firestore has NO deadline (flag-off admits); the adapter's copy has
    // a past ISO deadline -> flag-on enforcement consumes the adapter read.
    const on = await runPaid(true, seed(), adapterSeed({ registrationDeadline: '2026-01-01T00:00:00.000Z' }), submit);
    expect(on.status).toBe(400);
    expect(on.body.error).toMatch(/Registration has closed/);
    expect(on.fakeDb.all('events/evt-paid/registrations')).toHaveLength(0);
    expect(on.adapter.writes).toHaveLength(0);
  });

  it('flag-on: a {_seconds,_nanoseconds} deadline from the adapter is normalized and closes (E-REG-P06 hazard closed at the seam)', async () => {
    const PAST_SECONDS = Math.floor(Date.UTC(2026, 0, 1) / 1000);
    const on = await runPaid(
      true,
      seed(),
      adapterSeed({ registrationDeadline: { _seconds: PAST_SECONDS, _nanoseconds: 0 } }),
      submit,
    );
    expect(on.status).toBe(400);
    expect(on.body.error).toMatch(/Registration has closed/);
  });

  it('flag-on: adapter not-found is authoritative (404 even though Firestore has the event)', async () => {
    const on = await runPaid(true, seed(), {}, submit);
    expect(on.status).toBe(404);
    expect(on.body).toEqual({ error: 'Event not found' });
    const off = await runPaid(false, seed(), {}, submit);
    expect(off.status).toBe(200);
  });

  it('flag-on: adapter read error falls back to the Firestore read exactly', async () => {
    mockDbHolder.db = createFakeDb();
    db().seed('users', 'user-1', { displayName: 'User One', email: 'one@test.dev' });
    seed()(db());
    const adapter = createRecordingAdapter(adapterSeed());
    (adapter.getDoc as jest.Mock).mockRejectedValue(new Error('pg down'));
    setFlag(true, adapter);
    const res = await paidPOST(paidReq(PAID_BODY));
    expect(res.status).toBe(200);
    expect(db().read('events/evt-paid/registrations', 'user-1')).toBeTruthy();
  });
});

/* ================================================================== free */

describe('S-E2E-01 free route parity (POST /registerForEvent)', () => {
  const seedFree = (fields: Record<string, any> = {}) => (d: FakeDb) => {
    d.seed('users', 'user-1', { displayName: 'User One', email: 'one@test.dev' });
    d.seed('events', 'evt-1', {
      title: 'Free Space Talk', status: 'published', registrationOpen: true, capacity: 2,
      attendeeIds: [], registered_attendees_uids: [], registrationsCount: 0,
      paymentDetails: { isPaid: false, method: null }, ...fields,
    });
  };
  const confirm = async () => {
    const res = await freePOST(freeReq({ data: { eventId: 'evt-1', whatsappE164: '+923001234567' } }));
    return { status: res.status, body: await res.json() };
  };

  async function runFree(on: boolean, seedFn: (d: FakeDb) => void, act: () => Promise<{ status: number; body: any }>) {
    mockDbHolder.db = createFakeDb();
    seedFn(db());
    const adapter = createRecordingAdapter();
    setFlag(on, adapter);
    const result = await act();
    return { ...result, adapter, fakeDb: db() };
  }

  it('fresh registration: byte-identical envelope + Firestore state, exactly the mirrored writes when ON', async () => {
    const off = await runFree(false, seedFree(), confirm);
    const on = await runFree(true, seedFree(), confirm);
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ result: { ok: true, alreadyRegistered: false } });
    expect(on.body).toEqual(off.body);
    expect(on.fakeDb.read('events/evt-1/registrations', 'user-1'))
      .toEqual(off.fakeDb.read('events/evt-1/registrations', 'user-1'));
    expect(on.fakeDb.read('events', 'evt-1')).toEqual(off.fakeDb.read('events', 'evt-1'));

    expect(off.adapter.writes).toHaveLength(0);
    expect(on.adapter.writes).toHaveLength(2);
    const [regWrite, counterWrite] = on.adapter.writes;
    expect(regWrite.op).toBe('setDoc');
    expect(regWrite.path).toBe('events/evt-1/registrations');
    expect(regWrite.id).toBe('user-1');
    expect(regWrite.opts).toEqual({ merge: true });
    expect(regWrite.data).toEqual(off.fakeDb.read('events/evt-1/registrations', 'user-1'));
    expect(counterWrite).toMatchObject({ op: 'updateDoc', path: 'events', id: 'evt-1' });
    expect(counterWrite.data).toEqual({
      attendeeIds: ['user-1'],
      registered_attendees_uids: ['user-1'],
      registrationsCount: 1,
      updatedAt: 'ts',
    });
  });

  it('duplicate: alreadyRegistered in both modes and the duplicate arm mirrors nothing', async () => {
    const seq = async () => {
      await confirm();
      return confirm();
    };
    const off = await runFree(false, seedFree(), seq);
    const on = await runFree(true, seedFree(), seq);
    expect(on.body).toEqual({ result: { ok: true, alreadyRegistered: true } });
    expect(on.body).toEqual(off.body);
    expect(on.adapter.writes).toHaveLength(2); // first call only
    expect(on.fakeDb.all('events/evt-1/registrations')).toHaveLength(1);
  });

  it('cancelled-replace: a cancelled registration is replaced and mirrored in both modes', async () => {
    const withCancelled = (d: FakeDb) => {
      seedFree()(d);
      d.seed('events/evt-1/registrations', 'user-1', { uid: 'user-1', eventId: 'evt-1', status: 'cancelled', paymentStatus: 'verified' });
    };
    const off = await runFree(false, withCancelled, confirm);
    const on = await runFree(true, withCancelled, confirm);
    expect(on.status).toBe(200);
    expect(on.body).toEqual(off.body);
    expect(on.fakeDb.read('events/evt-1/registrations', 'user-1')!.status).toBe('pending');
    expect(on.adapter.writes).toHaveLength(2);
  });

  it('capacity full: failed-precondition envelope in both modes, nothing mirrored', async () => {
    const full = { capacity: 1, attendeeIds: ['o-1'], registered_attendees_uids: ['o-1'], registrationsCount: 1 };
    const off = await runFree(false, seedFree(full), confirm);
    const on = await runFree(true, seedFree(full), confirm);
    expect(on.status).toBe(400);
    expect(on.body).toEqual({
      error: { status: 'failed-precondition', message: 'Sorry, this event is full' },
    });
    expect(on.body).toEqual(off.body);
    expect(on.adapter.writes).toHaveLength(0);
  });

  it('capacity edges: 0 and missing are both uncapped in both modes', async () => {
    const zero = { capacity: 0, attendeeIds: ['a', 'b', 'c'], registered_attendees_uids: ['a', 'b', 'c'], registrationsCount: 3 };
    const offZero = await runFree(false, seedFree(zero), confirm);
    const onZero = await runFree(true, seedFree(zero), confirm);
    expect(onZero.status).toBe(200);
    expect(onZero.body).toEqual(offZero.body);
    expect(onZero.fakeDb.read('events', 'evt-1')!.registrationsCount).toBe(4);

    const missing = (d: FakeDb) => {
      seedFree()(d);
      const e = d.read('events', 'evt-1')!;
      delete e.capacity;
      e.attendeeIds = ['a', 'b'];
      e.registered_attendees_uids = ['a', 'b'];
      e.registrationsCount = 2;
      d.seed('events', 'evt-1', e);
    };
    const onMissing = await runFree(true, missing, confirm);
    expect(onMissing.status).toBe(200);
  });

  it('E-REG-F08: a past registrationDeadline does NOT block the free route in either mode', async () => {
    const past = { registrationDeadline: { seconds: Math.floor(Date.UTC(2026, 0, 1) / 1000), nanoseconds: 0 } };
    const off = await runFree(false, seedFree(past), confirm);
    const on = await runFree(true, seedFree(past), confirm);
    expect(on.status).toBe(200);
    expect(on.body).toEqual(off.body);
    expect(on.adapter.writes).toHaveLength(2);
  });

  it('blacklist: 403 envelope in both modes, nothing mirrored', async () => {
    const blacklisted = (d: FakeDb) => {
      seedFree()(d);
      d.seed('users', 'user-1', { displayName: 'User One', email: 'one@test.dev', isBlacklisted: true });
      d.seed('warningConfig', 'global', { enforcementEnabled: true });
    };
    const off = await runFree(false, blacklisted, confirm);
    const on = await runFree(true, blacklisted, confirm);
    expect(on.status).toBe(403);
    expect(on.body).toEqual(off.body);
    expect(on.body.error.status).toBe('permission-denied');
    expect(on.adapter.writes).toHaveLength(0);
  });
});
