/**
 * @jest-environment node
 *
 * CROSS-ROUTE CONTRADICTIONS between the two event registration
 * routes, recorded from the CURRENT Firestore implementation
 * (feat/integration-wave3 @ 4d5a1e16) ahead of the Supabase migration
 * (implementer branch feat/supa-events-2 owns BOTH routes).
 *
 *   Paid / proof route:  POST /api/event-registrations   (../route.ts)
 *   Free / seat route:   POST /registerForEvent          (../../../registerForEvent/route.ts)
 *
 * Both routes write the SAME subcollection
 * (events/<eventId>/registrations/<uid>) and the SAME three counters,
 * and each treats the other's registrations as its own duplicates.
 * But their contracts diverge in ways a migration can easily flatten
 * by accident. Every divergence below is pinned side-by-side so the
 * migrated pair either reproduces it deliberately or changes it as a
 * named product decision, never silently:
 *
 *   X-01  Envelopes: paid success is { ok, message }; free success is
 *         { result: { ok, alreadyRegistered } }. Paid errors are
 *         { error: string }; free errors are
 *         { error: { status, message } }. (Each route's client reads
 *         only its own shape.)
 *   X-02  Publication gate: free rejects draft/archived/deleted and
 *         registrationOpen:false events; paid accepts proofs for all
 *         of them (no gate at all).
 *   X-03  Deadline: paid rejects after registrationDeadline (400);
 *         free never reads the field and registers anyway.
 *   X-04  Stored vocabulary for a fresh registration on the same
 *         event: free writes status 'pending' / paymentStatus
 *         'verified' (free event); paid writes status 'under_review'
 *         / paymentStatus 'pending', plus a pending_verification
 *         order (free writes no order).
 *   X-05  AGREEMENT (must survive the migration): capacity rejection
 *         carries the SAME message text 'Sorry, this event is full'
 *         on both routes, duplicate-check precedes capacity on both,
 *         and a registration written by either route is honored as a
 *         duplicate by the other with NO overwrite and NO counter
 *         movement.
 *
 * Mocking combines both suites' patterns: firebase-admin, the
 * admin-db accessor, notifications, and the permissions config are
 * mocked; the real discipline suspension helper runs against
 * FakeFirestore. Zero live reads.
 */

const mockDbHolder: { db: unknown } = { db: null };
const mockSend = jest.fn(async () => undefined);
const mockBroadcast = jest.fn(async () => undefined);

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
import { POST as paidPOST } from '../route';
import { POST as freePOST } from '../../../registerForEvent/route';

function db(): FakeDb {
    return mockDbHolder.db as FakeDb;
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
    eventId: 'evt-1',
    transactionId: 'txn-1',
    paymentMethod: 'manual',
    amount: 500,
    currency: 'PKR',
    buyer: { fullName: 'User One', email: 'one@test.dev' },
};

function seedEvent(overrides: Record<string, any> = {}) {
    db().seed('events', 'evt-1', {
        title: 'Shared Event',
        status: 'published',
        registrationOpen: true,
        capacity: 10,
        attendeeIds: [],
        registered_attendees_uids: [],
        registrationsCount: 0,
        paymentDetails: { isPaid: false, method: null },
        ...overrides,
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDbHolder.db = createFakeDb();
    db().seed('users', 'user-1', { displayName: 'User One', email: 'one@test.dev' });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    (console.error as jest.Mock).mockRestore?.();
});

describe('X-01: the two routes speak different envelopes for the same outcomes', () => {
    it('success: paid is { ok, message }, free is { result: { ok, alreadyRegistered } }', async () => {
        seedEvent();
        const paid = await paidPOST(paidReq(PAID_BODY));
        expect(paid.status).toBe(200);
        expect(Object.keys(await paid.json()).sort()).toEqual(['message', 'ok']);

        seedEvent(); // fresh counters for the free call on a clean event
        db().seed('events', 'evt-2', { ...db().read('events', 'evt-1') });
        const free = await freePOST(freeReq({ data: { eventId: 'evt-2' } }));
        expect(free.status).toBe(200);
        expect(await free.json()).toEqual({ result: { ok: true, alreadyRegistered: false } });
    });

    it('missing fields: paid error is a plain string, free error is a { status, message } object', async () => {
        seedEvent();
        const paid = await paidPOST(paidReq({ eventId: 'evt-1' }));
        expect(paid.status).toBe(400);
        expect(await paid.json()).toEqual({ error: 'Missing required fields: eventId or transactionId' });

        const free = await freePOST(freeReq({ data: {} }));
        expect(free.status).toBe(400);
        expect(await free.json()).toEqual({
            error: { status: 'invalid-argument', message: 'eventId is required' },
        });
    });

    it('unknown event: both 404, paid with a string error, free with a coded error object', async () => {
        const paid = await paidPOST(paidReq({ ...PAID_BODY, eventId: 'nope' }));
        expect(paid.status).toBe(404);
        expect(await paid.json()).toEqual({ error: 'Event not found' });

        const free = await freePOST(freeReq({ data: { eventId: 'nope' } }));
        expect(free.status).toBe(404);
        expect(await free.json()).toEqual({
            error: { status: 'not-found', message: 'Event not found' },
        });
    });
});

describe('X-02 / X-03: gates one route enforces and the other does not', () => {
    it('X-02 draft event: free rejects 400 Registration is closed, paid accepts the proof 200', async () => {
        seedEvent({ status: 'draft' });
        const free = await freePOST(freeReq({ data: { eventId: 'evt-1' } }));
        expect(free.status).toBe(400);
        expect((await free.json()).error.message).toBe('Registration is closed for this event');

        const paid = await paidPOST(paidReq(PAID_BODY));
        expect(paid.status).toBe(200);
        expect(db().read('events/evt-1/registrations', 'user-1')!.status).toBe('under_review');
    });

    it('X-03 past registrationDeadline: paid rejects 400 Registration has closed, free registers 200', async () => {
        seedEvent({
            registrationDeadline: { seconds: Math.floor(Date.UTC(2026, 0, 1) / 1000), nanoseconds: 0 },
        });
        const paid = await paidPOST(paidReq(PAID_BODY));
        expect(paid.status).toBe(400);
        expect((await paid.json()).error).toMatch(/Registration has closed/);

        const free = await freePOST(freeReq({ data: { eventId: 'evt-1' } }));
        expect(free.status).toBe(200);
        expect(db().read('events/evt-1/registrations', 'user-1')!.status).toBe('pending');
    });
});

describe('X-04: fresh-registration vocabulary differs per route', () => {
    it('free writes pending/verified and no order; paid writes under_review/pending and one order', async () => {
        seedEvent();
        await freePOST(freeReq({ data: { eventId: 'evt-1' } }));
        const freeReg = db().read('events/evt-1/registrations', 'user-1')!;
        expect(freeReg.status).toBe('pending');
        expect(freeReg.paymentStatus).toBe('verified');
        expect(db().all('orders')).toHaveLength(0);

        // A second event + second user through the paid route.
        db().seed('users', 'user-2', { displayName: 'User Two', email: 'two@test.dev' });
        db().seed('events', 'evt-2', { ...db().read('events', 'evt-1'), attendeeIds: [], registered_attendees_uids: [], registrationsCount: 0 });
        await paidPOST(paidReq({ ...PAID_BODY, eventId: 'evt-2' }, 'token-user-2'));
        const paidReg = db().read('events/evt-2/registrations', 'user-2')!;
        expect(paidReg.status).toBe('under_review');
        expect(paidReg.paymentStatus).toBe('pending');
        expect(db().all('orders')).toHaveLength(1);
    });
});

describe('X-05: agreements that must survive the migration', () => {
    it('capacity rejection message text is identical on both routes (envelopes differ)', async () => {
        seedEvent({ capacity: 1, attendeeIds: ['other'], registered_attendees_uids: ['other'], registrationsCount: 1 });
        const paid = await paidPOST(paidReq(PAID_BODY));
        expect(paid.status).toBe(400);
        expect((await paid.json()).error).toBe('Sorry, this event is full');

        const free = await freePOST(freeReq({ data: { eventId: 'evt-1' } }));
        expect(free.status).toBe(400);
        expect((await free.json()).error.message).toBe('Sorry, this event is full');
    });

    it('free-then-paid: the paid route honors a free registration as a duplicate with no overwrite and no order', async () => {
        seedEvent();
        await freePOST(freeReq({ data: { eventId: 'evt-1' }, whatsappE164: '+920000' }));
        const before = db().read('events', 'evt-1')!;

        const paid = await paidPOST(paidReq(PAID_BODY));
        expect(paid.status).toBe(200);
        const json = await paid.json();
        expect(json.ok).toBe(true);
        expect(json.alreadyRegistered).toBe(true);

        const reg = db().read('events/evt-1/registrations', 'user-1')!;
        expect(reg.status).toBe('pending'); // free vocabulary untouched
        expect(reg.paymentStatus).toBe('verified');
        expect(db().all('orders')).toHaveLength(0);
        expect(db().read('events', 'evt-1')).toEqual(before);
    });

    it('paid-then-free: the free route honors a paid registration as a duplicate with no overwrite', async () => {
        seedEvent();
        await paidPOST(paidReq(PAID_BODY));
        const before = db().read('events', 'evt-1')!;

        const free = await freePOST(freeReq({ data: { eventId: 'evt-1' } }));
        expect(free.status).toBe(200);
        expect((await free.json()).result).toEqual({ ok: true, alreadyRegistered: true });

        const reg = db().read('events/evt-1/registrations', 'user-1')!;
        expect(reg.status).toBe('under_review'); // paid vocabulary untouched
        expect(reg.paymentStatus).toBe('pending');
        expect(db().read('events', 'evt-1')).toEqual(before);
        expect(db().all('orders')).toHaveLength(1); // only the paid route's order
    });
});
