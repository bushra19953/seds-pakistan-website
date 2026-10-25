/**
 * @jest-environment node
 *
 * EV-P04: duplicate paid registrations multiplied orders. The route used
 * to block a re-POST only when the existing registration was already
 * confirmed; every other re-POST overwrote the registration AND added a
 * fresh doc to the orders collection, so retries and double-clicks
 * created duplicate pending orders. These tests pin the idempotent
 * contract: any live (non-cancelled) registration returns success with
 * NO overwrite and NO new order; a cancelled registration may be
 * replaced by exactly one fresh submission.
 *
 * firebase-admin, the admin-db accessor, notifications, and the
 * permissions config are mocked; the real discipline suspension helper
 * runs against FakeFirestore.
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
import { POST } from '../route';

// FakeFirestore has no collection().add(); give it the production
// equivalent (auto-id doc + set) for the orders ledger.
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

function req(body: unknown, token: string) {
    return new NextRequest('http://localhost/api/event-registrations', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
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
    mockDbHolder.db = withOrdersAdd(createFakeDb());
    const db = mockDbHolder.db as FakeDb;
    db.seed('events', 'evt-paid', { title: 'Paid Workshop', status: 'published' });
    db.seed('users', 'user-1', { displayName: 'User One', email: 'one@test.dev' });
});

describe('POST /api/event-registrations idempotency (EV-P04)', () => {
    it('first submission creates the registration and exactly one order', async () => {
        const db = mockDbHolder.db as FakeDb;

        const res = await POST(req(PAID_BODY, 'token-user-1'));
        expect(res.status).toBe(200);
        expect((await res.json()).ok).toBe(true);

        const reg = db.read('events/evt-paid/registrations', 'user-1')!;
        expect(reg.status).toBe('under_review');
        expect(reg.paymentStatus).toBe('pending');
        expect(reg.transactionId).toBe('txn-1');

        const orders = db.all('orders');
        expect(orders).toHaveLength(1);
        expect(orders[0].data.originatingModule).toBe('Events');
        expect(orders[0].data.buyerUserId).toBe('user-1');
    });

    it('a duplicate submission returns the existing registration and mints NO second order', async () => {
        const db = mockDbHolder.db as FakeDb;

        expect((await POST(req(PAID_BODY, 'token-user-1'))).status).toBe(200);

        const retry = await POST(req({ ...PAID_BODY, transactionId: 'txn-2' }, 'token-user-1'));
        expect(retry.status).toBe(200);
        const json = await retry.json();
        expect(json.ok).toBe(true);
        expect(json.alreadyRegistered).toBe(true);

        expect(db.all('orders')).toHaveLength(1);
        const reg = db.read('events/evt-paid/registrations', 'user-1')!;
        expect(reg.transactionId).toBe('txn-1'); // not overwritten by the retry
        expect(mockSend).toHaveBeenCalledTimes(1); // no duplicate notifications either
    });

    it('an already-confirmed registration short-circuits the same way (was a 400 before the fix)', async () => {
        const db = mockDbHolder.db as FakeDb;
        db.seed('events/evt-paid/registrations', 'user-1', {
            uid: 'user-1', eventId: 'evt-paid', status: 'confirmed', paymentStatus: 'verified', transactionId: 'txn-0',
        });

        const res = await POST(req(PAID_BODY, 'token-user-1'));
        expect(res.status).toBe(200);
        expect((await res.json()).alreadyRegistered).toBe(true);
        expect(db.all('orders')).toHaveLength(0);
    });

    it('a cancelled registration may be replaced by one fresh submission and one new order', async () => {
        const db = mockDbHolder.db as FakeDb;
        db.seed('events/evt-paid/registrations', 'user-1', {
            uid: 'user-1', eventId: 'evt-paid', status: 'cancelled', paymentStatus: 'unpaid', transactionId: 'txn-old',
        });

        const res = await POST(req(PAID_BODY, 'token-user-1'));
        expect(res.status).toBe(200);
        const reg = db.read('events/evt-paid/registrations', 'user-1')!;
        expect(reg.status).toBe('under_review');
        expect(reg.transactionId).toBe('txn-1');
        expect(db.all('orders')).toHaveLength(1);
    });
});

describe('POST /api/event-registrations capacity (EV-P06 paid arm)', () => {
    // Before this fix the paid route enforced no capacity at all and
    // never wrote the shared counters, so a paid event could be
    // oversold without limit. The semantics now mirror the free route
    // (POST /registerForEvent): duplicate check BEFORE capacity,
    // capacity counted on attendeeIds, and the writer unions the uid
    // into attendeeIds / registered_attendees_uids with
    // registrationsCount = attendeeIds.length.
    function seedCappedEvent(db: FakeDb, fields: Record<string, unknown>) {
        db.seed('events', 'evt-paid', { title: 'Paid Workshop', status: 'published', ...fields });
    }

    it('a registration at capacity-1 succeeds, takes the last seat, and moves the counters', async () => {
        const db = mockDbHolder.db as FakeDb;
        seedCappedEvent(db, {
            capacity: 2,
            attendeeIds: ['other-1'],
            registered_attendees_uids: ['other-1'],
            registrationsCount: 1,
        });

        const res = await POST(req(PAID_BODY, 'token-user-1'));
        expect(res.status).toBe(200);
        expect((await res.json()).ok).toBe(true);

        const reg = db.read('events/evt-paid/registrations', 'user-1')!;
        expect(reg.status).toBe('under_review');
        const event = db.read('events', 'evt-paid')!;
        expect(event.attendeeIds).toEqual(['other-1', 'user-1']);
        expect(event.registered_attendees_uids).toEqual(['other-1', 'user-1']);
        expect(event.registrationsCount).toBe(2);
        expect(db.all('orders')).toHaveLength(1);
    });

    it('at capacity, a new registrant is rejected cleanly (400) and nothing is written', async () => {
        const db = mockDbHolder.db as FakeDb;
        seedCappedEvent(db, {
            capacity: 1,
            attendeeIds: ['other-1'],
            registered_attendees_uids: ['other-1'],
            registrationsCount: 1,
        });

        const res = await POST(req(PAID_BODY, 'token-user-1'));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('Sorry, this event is full');

        expect(db.read('events/evt-paid/registrations', 'user-1')).toBeUndefined();
        expect(db.all('orders')).toHaveLength(0);
        const event = db.read('events', 'evt-paid')!;
        expect(event.attendeeIds).toEqual(['other-1']);
        expect(event.registrationsCount).toBe(1);
        expect(mockSend).not.toHaveBeenCalled();
    });

    it('a duplicate re-post at full capacity still returns alreadyRegistered (duplicate precedes capacity)', async () => {
        const db = mockDbHolder.db as FakeDb;
        seedCappedEvent(db, {
            capacity: 1,
            attendeeIds: ['user-1'],
            registered_attendees_uids: ['user-1'],
            registrationsCount: 1,
        });
        db.seed('events/evt-paid/registrations', 'user-1', {
            uid: 'user-1', eventId: 'evt-paid', status: 'under_review', paymentStatus: 'pending', transactionId: 'txn-0',
        });

        const res = await POST(req({ ...PAID_BODY, transactionId: 'txn-2' }, 'token-user-1'));
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.ok).toBe(true);
        expect(json.alreadyRegistered).toBe(true);

        expect(db.all('orders')).toHaveLength(0);
        expect(db.read('events/evt-paid/registrations', 'user-1')!.transactionId).toBe('txn-0');
    });

    it('a cancelled registration frees the seat: the uid is out of the counters and a re-post retakes it', async () => {
        const db = mockDbHolder.db as FakeDb;
        // The state the admin panel leaves behind on cancel (EV-P06):
        // the registration is marked cancelled and the uid is removed
        // from attendeeIds / registered_attendees_uids, so the seat no
        // longer counts toward capacity.
        seedCappedEvent(db, {
            capacity: 1,
            attendeeIds: [],
            registered_attendees_uids: [],
            registrationsCount: 0,
        });
        db.seed('events/evt-paid/registrations', 'user-1', {
            uid: 'user-1', eventId: 'evt-paid', status: 'cancelled', paymentStatus: 'unpaid', transactionId: 'txn-old',
        });

        const res = await POST(req(PAID_BODY, 'token-user-1'));
        expect(res.status).toBe(200);
        expect((await res.json()).ok).toBe(true);

        const reg = db.read('events/evt-paid/registrations', 'user-1')!;
        expect(reg.status).toBe('under_review');
        expect(reg.transactionId).toBe('txn-1');
        const event = db.read('events', 'evt-paid')!;
        expect(event.attendeeIds).toEqual(['user-1']);
        expect(event.registered_attendees_uids).toEqual(['user-1']);
        expect(event.registrationsCount).toBe(1);
        expect(db.all('orders')).toHaveLength(1);
    });
});
