/**
 * @jest-environment node
 *
 * PARITY AUDIT E2 (independent test author; NOT the implementer).
 * Branch feat/supa-events-2: implementation commit 14a41458 plus the
 * implementer's uncommitted static-binding rework of the seam
 * (registrations.ts binds '@/lib/supa' statically; jest.supa-stub.ts /
 * jest.config mapper are theirs). This suite mocks '@/lib/supa' with
 * its own factory — the seam's documented injection path — so the
 * routes run against a recording adapter double. Zero live reads:
 * Firestore is the repo's FakeFirestore, exactly as the pre-existing
 * route suites run it.
 *
 * Pinned, per VERIFICATION_SPEC section 2 (T-1/T-2 check orders),
 * section 3.4 / E-REG-P06 (the seam must never leak a raw {_seconds}
 * shape to the deadline check), RULING_REG_TABLE.md (registrations
 * addressed as 'events/<id>/registrations', keyed (parent_path, id)),
 * and the tasking for this audit:
 *  - flag OFF vs flag ON responses are BYTE-IDENTICAL (status + raw
 *    body text) for the happy paths of both routes, duplicates,
 *    capacity arms, and the paid route's missing publication gate;
 *  - flag ON mirrors exactly the payloads the Firestore transaction
 *    wrote: registration setDoc at 'events/<id>/registrations' + uid,
 *    counter updateDoc on 'events' with the EV-P06 triple
 *    (registrationsCount === attendeeIds.length); NO order mirror;
 *    the duplicate arm mirrors NOTHING;
 *  - the paid route's pre-tx read is adapter-authoritative when the
 *    flag is on (deadline + not-found), and falls back to Firestore
 *    when the adapter errors or no client is configured;
 *  - the free route performs NO adapter read (its reads stay in the
 *    Firestore transaction) but mirrors its writes;
 *  - the same uid registering for two events mirrors as two setDoc
 *    calls under two different parent paths (two rows, H-A).
 */

const mockDbHolder: { db: unknown } = { db: null };
const mockSend = jest.fn(async () => undefined);
const mockBroadcast = jest.fn(async () => undefined);

/* ------------------------------------------------- '@/lib/supa' double */

interface AdapterCall {
  method: string;
  path: string;
  id?: string;
  data?: any;
  options?: any;
}

const supaState: {
  enabled: boolean;
  clientConfigured: boolean;
  eventRows: Map<string, Record<string, any> | null>;
  getDocError: Error | null;
  setDocError: Error | null;
  calls: AdapterCall[];
} = {
  enabled: false,
  clientConfigured: true,
  eventRows: new Map(),
  getDocError: null,
  setDocError: null,
  calls: [],
};

const recordingAdapter = {
  getDoc: async (path: string, id: string) => {
    supaState.calls.push({ method: 'getDoc', path, id });
    if (supaState.getDocError) throw supaState.getDocError;
    if (path !== 'events') return null;
    const row = supaState.eventRows.get(id);
    return row ? { id, ...row } : null;
  },
  listDocs: async () => [],
  countDocs: async () => 0,
  setDoc: async (path: string, id: string, data: any, options?: any) => {
    supaState.calls.push({ method: 'setDoc', path, id, data, options });
    if (supaState.setDocError) throw supaState.setDocError;
    return data;
  },
  updateDoc: async (path: string, id: string, data: any) => {
    supaState.calls.push({ method: 'updateDoc', path, id, data });
    return data;
  },
  deleteDoc: async () => undefined,
};

jest.mock('@/lib/supa', () => ({
  useSupa: (_surface: string) => supaState.enabled,
  getSupaClient: () => (supaState.clientConfigured ? { fake: 'client' } : null),
  getSupaAdapter: () => recordingAdapter,
}));

/* ------------------------------------------------------- other mocks */

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    auth: () => ({
      verifyIdToken: async (token: string) => ({ uid: token.replace('token-', '') }),
    }),
    firestore: {
      // A sentinel OBJECT (not the 'ts' string of the older suites) so
      // the mirror serializer's FieldValue handling is exercised: the
      // mirror payload must carry an ISO string, never this object.
      FieldValue: { serverTimestamp: () => ({ _methodName: 'serverTimestamp' }) },
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
import {
  getEventForRegistration,
  registrationsSupaEnabled,
  setRegistrationsSupaAdapterForTests,
  toSupaSerializable,
} from '@/lib/supa-events/registrations';

/* ------------------------------------------------------------ helpers */

function withOrdersAdd(db: FakeDb): FakeDb {
  const orig = db.collection.bind(db);
  (db as any).collection = (path: string) => {
    const col: any = orig(path);
    if (typeof col.add !== 'function') {
      col.add = async (data: any) => {
        const ref = col.doc();
        await ref.set(data);
        return ref;
      };
    }
    return col;
  };
  return db;
}

function paidReq(body: unknown, token: string) {
  return new NextRequest('http://localhost/api/event-registrations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function freeReq(body: unknown, token: string) {
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

const PAID_EVENT = {
  title: 'Paid Workshop',
  status: 'published',
  capacity: 2,
  attendeeIds: [] as string[],
  registered_attendees_uids: [] as string[],
  registrationsCount: 0,
};

const FREE_EVENT = {
  title: 'Free Space Talk',
  status: 'published',
  registrationOpen: true,
  capacity: 2,
  attendeeIds: [] as string[],
  registered_attendees_uids: [] as string[],
  registrationsCount: 0,
  paymentDetails: { isPaid: false, method: null },
};

function freshDb(): FakeDb {
  const db = withOrdersAdd(createFakeDb());
  mockDbHolder.db = db;
  db.seed('users', 'user-1', { displayName: 'User One', email: 'one@test.dev' });
  db.seed('users', 'user-2', { displayName: 'User Two', email: 'two@test.dev' });
  return db;
}

function flagOn() {
  supaState.enabled = true;
  supaState.clientConfigured = true;
}
function flagOff() {
  supaState.enabled = false;
}

const mirrorWrites = () =>
  supaState.calls.filter((c) => c.method === 'setDoc' || c.method === 'updateDoc');
const adapterReads = () => supaState.calls.filter((c) => c.method === 'getDoc');

beforeEach(() => {
  jest.clearAllMocks();
  flagOff();
  supaState.clientConfigured = true;
  supaState.eventRows = new Map();
  supaState.getDocError = null;
  supaState.setDocError = null;
  supaState.calls = [];
  setRegistrationsSupaAdapterForTests(undefined);
  freshDb();
});

afterEach(() => {
  jest.restoreAllMocks();
});

/* ================================================================== */
describe('seam flag + normalization units', () => {
  it('registrationsSupaEnabled requires BOTH the surface flag and a configured client', () => {
    flagOff();
    expect(registrationsSupaEnabled()).toBe(false);
    flagOn();
    expect(registrationsSupaEnabled()).toBe(true);
    supaState.clientConfigured = false;
    expect(registrationsSupaEnabled()).toBe(false);
  });

  it('getEventForRegistration never leaks a raw {_seconds} deadline to the route (E-REG-P06 seam duty)', async () => {
    flagOn();
    const pastSeconds = Math.floor(Date.now() / 1000) - 3600;
    supaState.eventRows.set('evt-paid', {
      title: 'Paid Workshop',
      registrationDeadline: { _seconds: pastSeconds, _nanoseconds: 0 },
    });
    const read = await getEventForRegistration('evt-paid');
    expect(read?.found).toBe(true);
    const deadline: any = (read as any).data.registrationDeadline;
    expect(deadline._seconds).toBeUndefined();
    expect(deadline.seconds).toBe(pastSeconds);
    expect(typeof deadline.toDate).toBe('function');
  });

  it('getEventForRegistration is null when the flag is off, and found:false is authoritative when on', async () => {
    await expect(getEventForRegistration('evt-paid')).resolves.toBeNull();
    flagOn();
    await expect(getEventForRegistration('nope')).resolves.toEqual({ found: false });
  });

  it('toSupaSerializable: sentinels and Dates become ISO strings, undefined is dropped', () => {
    const out: any = toSupaSerializable({
      createdAt: { _methodName: 'serverTimestamp' },
      when: new Date('2026-11-01T05:00:00.000Z'),
      stamp: { seconds: 1, nanoseconds: 0, toDate: () => new Date('2026-01-01T00:00:00.000Z') },
      gone: undefined,
      keep: 'x',
    });
    expect(typeof out.createdAt).toBe('string');
    expect(() => new Date(out.createdAt).toISOString()).not.toThrow();
    expect(out.when).toBe('2026-11-01T05:00:00.000Z');
    expect(out.stamp).toBe('2026-01-01T00:00:00.000Z');
    expect('gone' in out).toBe(false);
    expect(out.keep).toBe('x');
  });
});

/* ================================================================== */
describe('paid route /api/event-registrations: flag-off vs flag-on parity', () => {
  async function runPaid(mode: 'off' | 'on', seedEvent: Record<string, any>) {
    const db = freshDb();
    db.seed('events', 'evt-paid', { ...seedEvent });
    if (mode === 'on') {
      flagOn();
      supaState.eventRows.set('evt-paid', { ...seedEvent });
    }
    const res = await paidPOST(paidReq(PAID_BODY, 'token-user-1'));
    return { db, status: res.status, text: await res.text() };
  }

  it('happy path: byte-identical response; flag-on mirrors registration + counter triple, never the order', async () => {
    const off = await runPaid('off', PAID_EVENT);
    expect(off.status).toBe(200);
    expect(supaState.calls).toHaveLength(0); // flag off: adapter untouched

    const on = await runPaid('on', PAID_EVENT);
    expect(on.status).toBe(off.status);
    expect(on.text).toBe(off.text);

    // Pre-tx read came from the adapter exactly once.
    expect(adapterReads()).toEqual([{ method: 'getDoc', path: 'events', id: 'evt-paid' }]);

    // Mirror: one registration setDoc at the subcollection path + uid.
    const setDocs = supaState.calls.filter((c) => c.method === 'setDoc');
    expect(setDocs).toHaveLength(1);
    expect(setDocs[0].path).toBe('events/evt-paid/registrations');
    expect(setDocs[0].id).toBe('user-1');
    expect(setDocs[0].options).toEqual({ merge: true });
    expect(setDocs[0].data.status).toBe('under_review');
    expect(setDocs[0].data.paymentStatus).toBe('pending');
    expect(setDocs[0].data.transactionId).toBe('txn-1');
    // The FieldValue sentinel became an ISO string in the mirror.
    expect(typeof setDocs[0].data.createdAt).toBe('string');
    expect(setDocs[0].data.createdAt).not.toEqual({ _methodName: 'serverTimestamp' });

    // Mirror: one counter updateDoc on the event, EV-P06 triple, and
    // byte-equal to what the Firestore transaction actually wrote.
    const updates = supaState.calls.filter((c) => c.method === 'updateDoc');
    expect(updates).toHaveLength(1);
    expect(updates[0].path).toBe('events');
    expect(updates[0].id).toBe('evt-paid');
    const fsEvent: any = on.db.read('events', 'evt-paid');
    expect(updates[0].data.attendeeIds).toEqual(fsEvent.attendeeIds);
    expect(updates[0].data.registered_attendees_uids).toEqual(fsEvent.registered_attendees_uids);
    expect(updates[0].data.registrationsCount).toBe(fsEvent.registrationsCount);
    expect(updates[0].data.registrationsCount).toBe(updates[0].data.attendeeIds.length);
    expect(updates[0].data.attendeeIds).toEqual(['user-1']);

    // NO order mirror; the order exists only in Firestore.
    expect(supaState.calls.some((c) => c.path === 'orders')).toBe(false);
    expect(on.db.all('orders')).toHaveLength(1);
  });

  it('duplicate: byte-identical already-registered response in both modes; the flag-on duplicate mirrors NOTHING', async () => {
    const seed = (db: FakeDb) => {
      db.seed('events', 'evt-paid', { ...PAID_EVENT, attendeeIds: ['user-1'], registered_attendees_uids: ['user-1'], registrationsCount: 1 });
      db.seed('events/evt-paid/registrations', 'user-1', { uid: 'user-1', status: 'under_review', transactionId: 'txn-0' });
    };
    const dbOff = freshDb();
    seed(dbOff);
    const off = await paidPOST(paidReq(PAID_BODY, 'token-user-1'));
    const offText = await off.text();

    const dbOn = freshDb();
    seed(dbOn);
    flagOn();
    supaState.eventRows.set('evt-paid', { ...PAID_EVENT });
    const on = await paidPOST(paidReq(PAID_BODY, 'token-user-1'));
    expect(on.status).toBe(off.status);
    expect(await on.text()).toBe(offText);
    expect(JSON.parse(offText).alreadyRegistered).toBe(true);
    expect(mirrorWrites()).toHaveLength(0);
    expect(dbOn.all('orders')).toHaveLength(0);
    expect((dbOn.read('events/evt-paid/registrations', 'user-1') as any).transactionId).toBe('txn-0');
  });

  it('cancelled registration is replaced on the paid route in both modes; flag-on mirrors the replacement once', async () => {
    const seed = (db: FakeDb) => {
      db.seed('events', 'evt-paid', { ...PAID_EVENT });
      db.seed('events/evt-paid/registrations', 'user-1', { uid: 'user-1', status: 'cancelled', transactionId: 'txn-old' });
    };
    const dbOff = freshDb();
    seed(dbOff);
    const off = await paidPOST(paidReq(PAID_BODY, 'token-user-1'));
    expect(off.status).toBe(200);
    expect((dbOff.read('events/evt-paid/registrations', 'user-1') as any).transactionId).toBe('txn-1');

    const dbOn = freshDb();
    seed(dbOn);
    flagOn();
    supaState.eventRows.set('evt-paid', { ...PAID_EVENT });
    const on = await paidPOST(paidReq(PAID_BODY, 'token-user-1'));
    expect(on.status).toBe(200);
    expect(await on.text()).toBe(await off.text());
    const setDocs = supaState.calls.filter((c) => c.method === 'setDoc');
    expect(setDocs).toHaveLength(1);
    expect(setDocs[0].data.transactionId).toBe('txn-1');
    const counters = supaState.calls.find((c) => c.method === 'updateDoc');
    expect(counters?.data.attendeeIds).toEqual(['user-1']); // uid once, not duplicated
    expect(counters?.data.registrationsCount).toBe(1);
  });

  it('capacity: full event rejects byte-identically in both modes and mirrors nothing; capacity 0 and missing capacity are uncapped', async () => {
    const full = { ...PAID_EVENT, capacity: 1, attendeeIds: ['someone-else'], registered_attendees_uids: ['someone-else'], registrationsCount: 1 };
    const offFull = await runPaid('off', full);
    const onFull = await runPaid('on', full);
    expect(offFull.status).toBe(400);
    expect(JSON.parse(offFull.text)).toEqual({ error: 'Sorry, this event is full' });
    expect(onFull.status).toBe(400);
    expect(onFull.text).toBe(offFull.text);
    expect(mirrorWrites()).toHaveLength(0);

    for (const cap of [{ capacity: 0 }, { capacity: undefined }]) {
      const ev: Record<string, any> = { ...PAID_EVENT, attendeeIds: ['a', 'b', 'c'] };
      if (cap.capacity === undefined) delete ev.capacity;
      else ev.capacity = cap.capacity;
      const r = await runPaid('on', ev);
      expect(r.status).toBe(200);
    }
  });

  it('NO publication gate on the paid route, in either mode: draft, registrationOpen:false, and soft-deleted events all accept proofs', async () => {
    for (const variant of [
      { status: 'draft' },
      { status: 'published', registrationOpen: false },
      { status: 'published', deleted: true },
      { status: 'archived' },
    ]) {
      const ev = { ...PAID_EVENT, ...variant };
      const off = await runPaid('off', ev);
      const on = await runPaid('on', ev);
      expect(off.status).toBe(200);
      expect(on.status).toBe(200);
      expect(on.text).toBe(off.text);
    }
  });

  it('flag-on pre-tx read is authoritative: adapter not-found 404s even though Firestore has the event; adapter deadline (not the Firestore one) is enforced', async () => {
    const db = freshDb();
    db.seed('events', 'evt-paid', { ...PAID_EVENT }); // exists in Firestore
    flagOn(); // adapter has NO row for evt-paid
    const res = await paidPOST(paidReq(PAID_BODY, 'token-user-1'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Event not found' });
    expect(db.all('events/evt-paid/registrations')).toHaveLength(0);
    expect(db.all('orders')).toHaveLength(0);
    expect(mirrorWrites()).toHaveLength(0);

    // Firestore copy carries a PAST deadline; the adapter copy (the
    // authoritative pre-tx read) carries none -> registration proceeds.
    const db2 = freshDb();
    db2.seed('events', 'evt-paid', {
      ...PAID_EVENT,
      registrationDeadline: { seconds: Math.floor(Date.now() / 1000) - 3600 },
    });
    supaState.eventRows.set('evt-paid', { title: 'Paid Workshop', status: 'published' });
    const res2 = await paidPOST(paidReq(PAID_BODY, 'token-user-1'));
    expect(res2.status).toBe(200);
  });

  it('adapter error on the pre-tx read falls back to the Firestore read (its past deadline is enforced, nothing is written or mirrored)', async () => {
    const db = freshDb();
    db.seed('events', 'evt-paid', {
      ...PAID_EVENT,
      registrationDeadline: { seconds: Math.floor(Date.now() / 1000) - 3600 },
    });
    flagOn();
    supaState.getDocError = new Error('postgrest down');
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await paidPOST(paidReq(PAID_BODY, 'token-user-1'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Registration has closed');
    expect(db.all('events/evt-paid/registrations')).toHaveLength(0);
  });

  it('flag on but client unconfigured: pure Firestore behavior, adapter never called', async () => {
    const db = freshDb();
    db.seed('events', 'evt-paid', { ...PAID_EVENT });
    supaState.enabled = true;
    supaState.clientConfigured = false;
    const res = await paidPOST(paidReq(PAID_BODY, 'token-user-1'));
    expect(res.status).toBe(200);
    expect(supaState.calls).toHaveLength(0);
    expect(db.all('orders')).toHaveLength(1);
  });

  it('mirror failure is swallowed: flag-on setDoc rejection still returns the Firestore success response', async () => {
    const db = freshDb();
    db.seed('events', 'evt-paid', { ...PAID_EVENT });
    flagOn();
    supaState.eventRows.set('evt-paid', { ...PAID_EVENT });
    supaState.setDocError = new Error('supa write failed');
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await paidPOST(paidReq(PAID_BODY, 'token-user-1'));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(db.read('events/evt-paid/registrations', 'user-1')).toBeTruthy();
  });
});

/* ================================================================== */
describe('paid route deadline matrix on the adapter-served read (flag on)', () => {
  const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
  const nowSeconds = Math.floor(NOW / 1000);

  async function runWithDeadline(deadline: unknown) {
    const db = freshDb();
    db.seed('events', 'evt-paid', { ...PAID_EVENT });
    flagOn();
    supaState.eventRows.set('evt-paid', {
      title: 'Paid Workshop',
      status: 'published',
      ...(deadline === undefined ? {} : { registrationDeadline: deadline }),
    });
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    const res = await paidPOST(paidReq(PAID_BODY, 'token-user-1'));
    return { db, res };
  }

  it('past deadline closes in every storage shape the seam can serve, including the {_seconds} dump shape', async () => {
    for (const shape of [
      { _seconds: nowSeconds - 60, _nanoseconds: 0 },
      { seconds: nowSeconds - 60, nanoseconds: 0 },
      new Date(NOW - 60_000).toISOString(),
    ]) {
      const { db, res } = await runWithDeadline(shape);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(
        'Registration has closed. The deadline for this event has passed.',
      );
      expect(db.all('events/evt-paid/registrations')).toHaveLength(0);
      expect(mirrorWrites()).toHaveLength(0);
      supaState.calls = [];
    }
  });

  it('future deadline admits; a deadline exactly == now does NOT close (strictly-greater comparison)', async () => {
    const future = await runWithDeadline(new Date(NOW + 60_000).toISOString());
    expect(future.res.status).toBe(200);

    supaState.calls = [];
    const equal = await runWithDeadline({ seconds: nowSeconds, nanoseconds: 0 });
    expect(equal.res.status).toBe(200);
  });
});

/* ================================================================== */
describe('free route /registerForEvent: flag-off vs flag-on parity', () => {
  async function runFree(mode: 'off' | 'on', seedEvent: Record<string, any>, uid = 'user-1') {
    const db = freshDb();
    db.seed('events', 'evt-1', { ...seedEvent });
    if (mode === 'on') flagOn();
    const res = await freePOST(freeReq({ data: { eventId: 'evt-1' } }, `token-${uid}`));
    return { db, status: res.status, text: await res.text() };
  }

  it('happy path: byte-identical envelope; flag-on mirrors registration + counter triple and performs NO adapter read', async () => {
    const off = await runFree('off', FREE_EVENT);
    expect(off.status).toBe(200);
    expect(JSON.parse(off.text)).toEqual({ result: { ok: true, alreadyRegistered: false } });
    expect(supaState.calls).toHaveLength(0);

    const on = await runFree('on', FREE_EVENT);
    expect(on.status).toBe(off.status);
    expect(on.text).toBe(off.text);

    expect(adapterReads()).toHaveLength(0); // free route has no pre-tx read to migrate
    const setDocs = supaState.calls.filter((c) => c.method === 'setDoc');
    expect(setDocs).toHaveLength(1);
    expect(setDocs[0].path).toBe('events/evt-1/registrations');
    expect(setDocs[0].id).toBe('user-1');
    expect(setDocs[0].data.status).toBe('pending');
    expect(setDocs[0].data.paymentStatus).toBe('verified'); // free event vocabulary
    expect(typeof setDocs[0].data.createdAt).toBe('string');

    const updates = supaState.calls.filter((c) => c.method === 'updateDoc');
    expect(updates).toHaveLength(1);
    const fsEvent: any = on.db.read('events', 'evt-1');
    expect(updates[0].data.attendeeIds).toEqual(fsEvent.attendeeIds);
    expect(updates[0].data.registered_attendees_uids).toEqual(fsEvent.registered_attendees_uids);
    expect(updates[0].data.registrationsCount).toBe(fsEvent.registrationsCount);
    expect(updates[0].data.registrationsCount).toBe(updates[0].data.attendeeIds.length);
  });

  it('duplicate: byte-identical idempotent success in both modes; the flag-on duplicate mirrors NOTHING and counters do not move', async () => {
    const first = await runFree('on', FREE_EVENT);
    expect(first.status).toBe(200);
    const callsAfterFirst = supaState.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Second POST against the SAME Firestore state the first created.
    const db = mockDbHolder.db as FakeDb;
    const res = await freePOST(freeReq({ data: { eventId: 'evt-1' } }, 'token-user-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { ok: true, alreadyRegistered: true } });
    expect(supaState.calls.length).toBe(callsAfterFirst); // zero new adapter calls of any kind
    const fsEvent: any = db.read('events', 'evt-1');
    expect(fsEvent.attendeeIds).toEqual(['user-1']);
    expect(fsEvent.registrationsCount).toBe(1);
  });

  it('gates stay Firestore-side and byte-identical in both modes: deleted -> 404, closed -> 400, draft -> 400; flag-on gate failures mirror nothing', async () => {
    for (const [variant, status] of [
      [{ deleted: true }, 404],
      [{ registrationOpen: false }, 400],
      [{ status: 'draft' }, 400],
    ] as Array<[Record<string, any>, number]>) {
      const ev = { ...FREE_EVENT, ...variant };
      const off = await runFree('off', ev);
      const on = await runFree('on', ev);
      expect(off.status).toBe(status);
      expect(on.status).toBe(status);
      expect(on.text).toBe(off.text);
      expect(mirrorWrites()).toHaveLength(0);
      supaState.calls = [];
    }
  });

  it('blacklist gate (foreign users/warningConfig reads, kept in the Firestore tx): 403 in both modes, no mirrors', async () => {
    const setup = () => {
      const db = freshDb();
      db.seed('events', 'evt-1', { ...FREE_EVENT });
      db.seed('users', 'user-1', { displayName: 'User One', email: 'one@test.dev', isBlacklisted: true });
      // No warningConfig doc seeded: enforcement defaults ON (contract).
      return db;
    };
    setup();
    const off = await freePOST(freeReq({ data: { eventId: 'evt-1' } }, 'token-user-1'));
    expect(off.status).toBe(403);

    setup();
    flagOn();
    const on = await freePOST(freeReq({ data: { eventId: 'evt-1' } }, 'token-user-1'));
    expect(on.status).toBe(403);
    expect(await on.text()).toBe(await off.text());
    expect(mirrorWrites()).toHaveLength(0);
  });

  it('capacity: full rejects byte-identically in both modes; capacity 0 / missing are uncapped', async () => {
    const full = { ...FREE_EVENT, capacity: 1, attendeeIds: ['other'], registered_attendees_uids: ['other'], registrationsCount: 1 };
    const off = await runFree('off', full);
    const on = await runFree('on', full);
    expect(off.status).toBe(400);
    expect(JSON.parse(off.text).error.message).toBe('Sorry, this event is full');
    expect(on.text).toBe(off.text);
    expect(mirrorWrites()).toHaveLength(0);

    const zero = await runFree('on', { ...FREE_EVENT, capacity: 0, attendeeIds: ['a', 'b'] });
    expect(zero.status).toBe(200);
    const missing: Record<string, any> = { ...FREE_EVENT };
    delete missing.capacity;
    const miss = await runFree('on', missing);
    expect(miss.status).toBe(200);
  });

  it('the same uid under two events mirrors as TWO rows: two setDoc calls, same uid id, different parent paths (H-A)', async () => {
    const db = freshDb();
    db.seed('events', 'evt-1', { ...FREE_EVENT });
    db.seed('events', 'evt-2', { ...FREE_EVENT, title: 'Second Talk' });
    flagOn();
    const r1 = await freePOST(freeReq({ data: { eventId: 'evt-1' } }, 'token-user-1'));
    const r2 = await freePOST(freeReq({ data: { eventId: 'evt-2' } }, 'token-user-1'));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const setDocs = supaState.calls.filter((c) => c.method === 'setDoc');
    expect(setDocs.map((c) => [c.path, c.id])).toEqual([
      ['events/evt-1/registrations', 'user-1'],
      ['events/evt-2/registrations', 'user-1'],
    ]);
  });
});
