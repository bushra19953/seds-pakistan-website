/**
 * @jest-environment node
 *
 * Contract extensions for POST /registerForEvent (the FREE /
 * seat-holding route), recorded from the CURRENT Firestore
 * implementation (feat/integration-wave3 @ 4d5a1e16) ahead of the
 * Supabase migration (implementer branch feat/supa-events-2,
 * registrations).
 *
 * The pre-existing suite in this directory (route.test.ts) pins the
 * 401 arms, draft/archived/deleted rejection, the happy-path counters,
 * duplicate idempotency, capacity, blacklist, and suspension, and is
 * NOT duplicated here. This file pins the arms that suite does not
 * reach:
 *
 *   E-REG-F01  Envelope contracts: success is exactly
 *              { result: { ok: true, alreadyRegistered: boolean } }
 *              (the callable-shaped envelope the register page reads);
 *              failures are { error: { status, message } } with a
 *              STRING status code. Neither matches the paid route's
 *              { ok, message } / { error: string } envelopes (see the
 *              cross-route contradictions file).
 *   E-REG-F02  A missing registrationOpen field means OPEN (only an
 *              explicit false closes), and the legacy published:true
 *              flag with no status field is registerable.
 *   E-REG-F03  Paid seat-hold vocabulary: for a paid event the stored
 *              registration is status 'pending' with paymentStatus
 *              'unpaid' (a free event stores 'verified'); the seat is
 *              still held in all three counters.
 *   E-REG-F04  Capacity edge semantics: capacity 0 or missing is
 *              UNCAPPED even when attendeeIds is non-empty; the count
 *              that matters is attendeeIds.length alone.
 *   E-REG-F05  Counter derivation under divergence: when attendeeIds
 *              and registered_attendees_uids disagree on entry,
 *              registrationsCount is rewritten to the RESULTING
 *              attendeeIds length (not the registered list length,
 *              not the stored count).
 *   E-REG-F06  Field defaults: whatsappE164 defaults to null, and
 *              paymentMethod falls back to the event's
 *              paymentDetails.method, then null.
 *   E-REG-F07  The body is accepted both wrapped ({ data: {...} },
 *              the callable shape the page sends) and flat.
 *   E-REG-F08  FINDING (cross-route contradiction, current behavior):
 *              this route NEVER reads registrationDeadline. A free
 *              registration after the event's deadline still succeeds;
 *              only the paid route enforces the deadline (400).
 *
 * Mocking follows route.test.ts: firebase-admin and the admin-db
 * accessor are mocked; the real discipline suspension helper runs
 * against FakeFirestore. Zero live reads.
 */

const mockDbHolder: { db: unknown } = { db: null };

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

import { NextRequest } from 'next/server';
import { createFakeDb, type FakeDb } from '@/lib/server/__tests__/fake-firestore';
import { POST } from '../route';

function req(body: unknown, token?: string) {
    return new NextRequest('http://localhost/registerForEvent', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
    });
}

function db(): FakeDb {
    return mockDbHolder.db as FakeDb;
}

function seedFreeEvent(overrides: Record<string, any> = {}) {
    db().seed('events', 'evt-1', {
        title: 'Free Space Talk',
        status: 'published',
        registrationOpen: true,
        capacity: 2,
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

describe('E-REG-F: envelopes and open-state semantics', () => {
    it('E-REG-F01 the success body is exactly the callable envelope { result: { ok, alreadyRegistered } }', async () => {
        seedFreeEvent();
        const res = await POST(req({ data: { eventId: 'evt-1' } }, 'token-user-1'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ result: { ok: true, alreadyRegistered: false } });
    });

    it('E-REG-F01 a failure body is exactly { error: { status, message } } with a string status code', async () => {
        seedFreeEvent();
        const res = await POST(req({ data: {} }, 'token-user-1'));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
            error: { status: 'invalid-argument', message: 'eventId is required' },
        });
    });

    it('E-REG-F02 a missing registrationOpen field means registration is open', async () => {
        seedFreeEvent();
        const seeded = db().read('events', 'evt-1')!;
        delete seeded.registrationOpen;
        db().seed('events', 'evt-1', seeded);
        const res = await POST(req({ data: { eventId: 'evt-1' } }, 'token-user-1'));
        expect(res.status).toBe(200);
        expect((await res.json()).result.alreadyRegistered).toBe(false);
    });

    it('E-REG-F02 an explicit registrationOpen:false closes registration with failed-precondition', async () => {
        seedFreeEvent({ registrationOpen: false });
        const res = await POST(req({ data: { eventId: 'evt-1' } }, 'token-user-1'));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
            error: { status: 'failed-precondition', message: 'Registration is closed for this event' },
        });
        expect(db().all('events/evt-1/registrations')).toHaveLength(0);
    });

    it('E-REG-F02 the legacy published:true flag with no status field is registerable', async () => {
        seedFreeEvent();
        const seeded = db().read('events', 'evt-1')!;
        delete seeded.status;
        seeded.published = true;
        db().seed('events', 'evt-1', seeded);
        const res = await POST(req({ data: { eventId: 'evt-1' } }, 'token-user-1'));
        expect(res.status).toBe(200);
    });

    it('E-REG-F07 a flat (unwrapped) body is accepted the same as the callable { data } shape', async () => {
        seedFreeEvent();
        const res = await POST(req({ eventId: 'evt-1' }, 'token-user-1'));
        expect(res.status).toBe(200);
        expect((await res.json()).result).toEqual({ ok: true, alreadyRegistered: false });
        expect(db().read('events/evt-1/registrations', 'user-1')).toBeTruthy();
    });
});

describe('E-REG-F: paid seat-hold and counter semantics', () => {
    it("E-REG-F03 a paid event's seat-hold stores status 'pending' and paymentStatus 'unpaid', and still moves all counters", async () => {
        seedFreeEvent({ paymentDetails: { isPaid: true, method: 'bank_transfer' } });
        const res = await POST(req({ data: { eventId: 'evt-1' } }, 'token-user-1'));
        expect(res.status).toBe(200);
        const reg = db().read('events/evt-1/registrations', 'user-1')!;
        expect(reg.status).toBe('pending');
        expect(reg.paymentStatus).toBe('unpaid');
        const event = db().read('events', 'evt-1')!;
        expect(event.attendeeIds).toEqual(['user-1']);
        expect(event.registered_attendees_uids).toEqual(['user-1']);
        expect(event.registrationsCount).toBe(1);
    });

    it('E-REG-F04 capacity 0 is uncapped: a registration succeeds even with attendeeIds already populated', async () => {
        seedFreeEvent({
            capacity: 0,
            attendeeIds: ['a', 'b', 'c'],
            registered_attendees_uids: ['a', 'b', 'c'],
            registrationsCount: 3,
        });
        const res = await POST(req({ data: { eventId: 'evt-1' } }, 'token-user-1'));
        expect(res.status).toBe(200);
        expect(db().read('events', 'evt-1')!.registrationsCount).toBe(4);
    });

    it('E-REG-F04 a missing capacity field is uncapped', async () => {
        seedFreeEvent();
        const seeded = db().read('events', 'evt-1')!;
        delete seeded.capacity;
        seeded.attendeeIds = ['a', 'b'];
        seeded.registered_attendees_uids = ['a', 'b'];
        seeded.registrationsCount = 2;
        db().seed('events', 'evt-1', seeded);
        const res = await POST(req({ data: { eventId: 'evt-1' } }, 'token-user-1'));
        expect(res.status).toBe(200);
    });

    it('E-REG-F05 registrationsCount is rewritten to the resulting attendeeIds length when the counters diverge', async () => {
        seedFreeEvent({
            capacity: 10,
            attendeeIds: ['a'],
            registered_attendees_uids: ['a', 'b', 'c'],
            registrationsCount: 99,
        });
        const res = await POST(req({ data: { eventId: 'evt-1' } }, 'token-user-1'));
        expect(res.status).toBe(200);
        const event = db().read('events', 'evt-1')!;
        expect(event.attendeeIds).toEqual(['a', 'user-1']);
        expect(event.registered_attendees_uids).toEqual(['a', 'b', 'c', 'user-1']);
        expect(event.registrationsCount).toBe(2);
    });

    it('E-REG-F06 whatsappE164 defaults to null and paymentMethod falls back to the event paymentDetails.method', async () => {
        seedFreeEvent({ paymentDetails: { isPaid: true, method: 'bank_transfer' } });
        await POST(req({ data: { eventId: 'evt-1' } }, 'token-user-1'));
        const reg = db().read('events/evt-1/registrations', 'user-1')!;
        expect(reg.whatsappE164).toBeNull();
        expect(reg.paymentMethod).toBe('bank_transfer');
        expect(reg.paymentRef).toBeNull();
    });

    it("E-REG-F06 an explicit paymentMethod in the body wins over the event's method", async () => {
        seedFreeEvent({ paymentDetails: { isPaid: true, method: 'bank_transfer' } });
        await POST(req({ data: { eventId: 'evt-1', paymentMethod: 'easypaisa' } }, 'token-user-1'));
        expect(db().read('events/evt-1/registrations', 'user-1')!.paymentMethod).toBe('easypaisa');
    });
});

describe('E-REG-F: the deadline this route does not enforce', () => {
    it('E-REG-F08 FINDING: a free registration after registrationDeadline still succeeds (deadline is paid-route only)', async () => {
        seedFreeEvent({
            registrationDeadline: { seconds: Math.floor(Date.UTC(2026, 0, 1) / 1000), nanoseconds: 0 },
        });
        const res = await POST(req({ data: { eventId: 'evt-1' } }, 'token-user-1'));
        expect(res.status).toBe(200);
        expect((await res.json()).result).toEqual({ ok: true, alreadyRegistered: false });
        expect(db().read('events/evt-1/registrations', 'user-1')).toBeTruthy();
    });
});
