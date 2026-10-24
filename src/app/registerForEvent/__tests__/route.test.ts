/**
 * @jest-environment node
 *
 * EV-P01 / EV-P03 / EV-P06: POST /registerForEvent is the Next route that
 * replaces the decommissioned Cloud Functions callable handler behind
 * the standalone register page's Confirm Seat button. These tests pin:
 *  - unauthenticated requests are rejected (401),
 *  - draft / archived / deleted events are rejected,
 *  - the happy path writes the registration AND all three public
 *    counters (attendeeIds, registered_attendees_uids,
 *    registrationsCount) consistently in one transaction,
 *  - a duplicate call is idempotent (no second record, counters
 *    unchanged),
 *  - a full event is rejected on capacity, enforced against attendeeIds.
 *
 * Only firebase-admin (auth) and the admin-db accessor are mocked; the
 * real discipline suspension helper runs against FakeFirestore.
 */

const mockDbHolder: { db: unknown } = { db: null };

jest.mock('firebase-admin', () => ({
    __esModule: true,
    default: {
        auth: () => ({
            verifyIdToken: async (token: string) => {
                if (token === 'bad-token') throw new Error('invalid token');
                return { uid: token.replace('token-', '') };
            },
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

function confirmSeat(db: FakeDb, eventId: string, token: string, extra: Record<string, any> = {}) {
    return POST(req({ data: { eventId, ...extra } }, token));
}

function seedFreeEvent(db: FakeDb, overrides: Record<string, any> = {}) {
    db.seed('events', 'evt-1', {
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
    const db = mockDbHolder.db as FakeDb;
    db.seed('users', 'user-1', { displayName: 'User One', email: 'one@test.dev' });
    db.seed('users', 'user-2', { displayName: 'User Two', email: 'two@test.dev' });
});

describe('POST /registerForEvent (EV-P01 port of the decommissioned handler)', () => {
    it('rejects a request with no Bearer token (401) and writes nothing', async () => {
        const db = mockDbHolder.db as FakeDb;
        seedFreeEvent(db);

        const res = await POST(req({ data: { eventId: 'evt-1' } }));
        expect(res.status).toBe(401);
        const json = await res.json();
        expect(json.error.status).toBe('unauthenticated');
        expect(json.error.message).toBe('User must be signed in');
        expect(db.all('events/evt-1/registrations')).toHaveLength(0);
    });

    it('rejects an invalid Bearer token (401)', async () => {
        const db = mockDbHolder.db as FakeDb;
        seedFreeEvent(db);

        const res = await confirmSeat(db, 'evt-1', 'bad-token');
        expect(res.status).toBe(401);
        expect(db.all('events/evt-1/registrations')).toHaveLength(0);
    });

    it('rejects registration for a draft event and writes nothing', async () => {
        const db = mockDbHolder.db as FakeDb;
        seedFreeEvent(db, { status: 'draft' });

        const res = await confirmSeat(db, 'evt-1', 'token-user-1');
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error.status).toBe('failed-precondition');
        expect(json.error.message).toBe('Registration is closed for this event');
        expect(db.all('events/evt-1/registrations')).toHaveLength(0);
        expect(db.read('events', 'evt-1')?.registrationsCount).toBe(0);
    });

    it('rejects registration for an archived event', async () => {
        const db = mockDbHolder.db as FakeDb;
        seedFreeEvent(db, { status: 'archived' });

        const res = await confirmSeat(db, 'evt-1', 'token-user-1');
        expect(res.status).toBe(400);
        expect(db.all('events/evt-1/registrations')).toHaveLength(0);
    });

    it('rejects registration for a soft-deleted event (404)', async () => {
        const db = mockDbHolder.db as FakeDb;
        seedFreeEvent(db, { deleted: true });

        const res = await confirmSeat(db, 'evt-1', 'token-user-1');
        expect(res.status).toBe(404);
        expect(db.all('events/evt-1/registrations')).toHaveLength(0);
    });

    it('404s for a missing event', async () => {
        const db = mockDbHolder.db as FakeDb;
        const res = await confirmSeat(db, 'nope', 'token-user-1');
        expect(res.status).toBe(404);
        expect((await res.json()).error.status).toBe('not-found');
    });

    it('happy path: writes the registration and all three counters consistently', async () => {
        const db = mockDbHolder.db as FakeDb;
        seedFreeEvent(db);

        const res = await confirmSeat(db, 'evt-1', 'token-user-1', { whatsappE164: '+923001234567' });
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.result).toEqual({ ok: true, alreadyRegistered: false });

        const reg = db.read('events/evt-1/registrations', 'user-1')!;
        expect(reg).toBeTruthy();
        expect(reg.uid).toBe('user-1');
        expect(reg.eventId).toBe('evt-1');
        expect(reg.status).toBe('pending');
        expect(reg.paymentStatus).toBe('verified'); // free event, ported semantics
        expect(reg.whatsappE164).toBe('+923001234567');
        expect(reg.displayName).toBe('User One');
        expect(reg.email).toBe('one@test.dev');
        expect(reg.paymentRef).toBeNull();

        const event = db.read('events', 'evt-1')!;
        expect(event.attendeeIds).toEqual(['user-1']);
        expect(event.registered_attendees_uids).toEqual(['user-1']);
        expect(event.registrationsCount).toBe(1);
    });

    it('duplicate call is idempotent: one record, counters unchanged, original data kept', async () => {
        const db = mockDbHolder.db as FakeDb;
        seedFreeEvent(db);

        const first = await confirmSeat(db, 'evt-1', 'token-user-1', { whatsappE164: '+923001234567' });
        expect(first.status).toBe(200);

        const second = await confirmSeat(db, 'evt-1', 'token-user-1', { whatsappE164: '+929999999999' });
        expect(second.status).toBe(200);
        expect((await second.json()).result).toEqual({ ok: true, alreadyRegistered: true });

        expect(db.all('events/evt-1/registrations')).toHaveLength(1);
        const reg = db.read('events/evt-1/registrations', 'user-1')!;
        expect(reg.whatsappE164).toBe('+923001234567'); // not overwritten
        const event = db.read('events', 'evt-1')!;
        expect(event.attendeeIds).toEqual(['user-1']);
        expect(event.registered_attendees_uids).toEqual(['user-1']);
        expect(event.registrationsCount).toBe(1);
    });

    it('rejects when the event is full (capacity enforced against attendeeIds)', async () => {
        const db = mockDbHolder.db as FakeDb;
        seedFreeEvent(db, {
            capacity: 1,
            attendeeIds: ['someone-else'],
            registered_attendees_uids: ['someone-else'],
            registrationsCount: 1,
        });

        const res = await confirmSeat(db, 'evt-1', 'token-user-1');
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error.status).toBe('failed-precondition');
        expect(json.error.message).toBe('Sorry, this event is full');
        expect(db.all('events/evt-1/registrations')).toHaveLength(0);
        expect(db.read('events', 'evt-1')?.registrationsCount).toBe(1);
    });

    it('an already-registered user still succeeds on a now-full event (duplicate check precedes capacity)', async () => {
        const db = mockDbHolder.db as FakeDb;
        seedFreeEvent(db, { capacity: 1 });

        expect((await confirmSeat(db, 'evt-1', 'token-user-1')).status).toBe(200);
        const res = await confirmSeat(db, 'evt-1', 'token-user-1');
        expect(res.status).toBe(200);
        expect((await res.json()).result.alreadyRegistered).toBe(true);
    });

    it('a cancelled registration can be replaced by a fresh one', async () => {
        const db = mockDbHolder.db as FakeDb;
        seedFreeEvent(db);
        db.seed('events/evt-1/registrations', 'user-1', {
            uid: 'user-1', eventId: 'evt-1', status: 'cancelled', paymentStatus: 'verified',
        });

        const res = await confirmSeat(db, 'evt-1', 'token-user-1');
        expect(res.status).toBe(200);
        const reg = db.read('events/evt-1/registrations', 'user-1')!;
        expect(reg.status).toBe('pending');
        const event = db.read('events', 'evt-1')!;
        expect(event.attendeeIds).toEqual(['user-1']);
        expect(event.registrationsCount).toBe(1);
    });

    it('blocks a blacklisted user when enforcement is enabled (ported gate)', async () => {
        const db = mockDbHolder.db as FakeDb;
        seedFreeEvent(db);
        db.seed('users', 'user-2', { displayName: 'User Two', email: 'two@test.dev', isBlacklisted: true });
        db.seed('warningConfig', 'global', { enforcementEnabled: true });

        const res = await confirmSeat(db, 'evt-1', 'token-user-2');
        expect(res.status).toBe(403);
        expect((await res.json()).error.status).toBe('permission-denied');
        expect(db.all('events/evt-1/registrations')).toHaveLength(0);
    });

    it('blocks a Strike-2 suspended user (spec E.4.8, same gate as the paid route)', async () => {
        const db = mockDbHolder.db as FakeDb;
        seedFreeEvent(db);
        db.seed('users', 'user-2', {
            displayName: 'User Two',
            email: 'two@test.dev',
            privilegesSuspendedUntil: new Date(Date.now() + 60 * 60 * 1000),
            suspensionCaseId: 'case-1',
        });

        const res = await confirmSeat(db, 'evt-1', 'token-user-2');
        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe('SUSPENDED');
        expect(db.all('events/evt-1/registrations')).toHaveLength(0);
    });

    it('requires eventId (400 invalid-argument)', async () => {
        const db = mockDbHolder.db as FakeDb;
        const res = await POST(req({ data: {} }, 'token-user-1'));
        expect(res.status).toBe(400);
        expect((await res.json()).error.status).toBe('invalid-argument');
    });
});
