/**
 * @jest-environment node
 *
 * Contract extensions for POST /api/event-registrations (the PAID /
 * payment-proof route), recorded from the CURRENT Firestore
 * implementation (feat/integration-wave3 @ 4d5a1e16) ahead of the
 * Supabase migration (implementer branch feat/supa-events-2,
 * registrations).
 *
 * The pre-existing suite in this directory (route.test.ts) pins
 * duplicate idempotency (EV-P04) and capacity/counters (EV-P06 paid
 * arm) and is NOT duplicated here. This file pins the arms that suite
 * does not reach:
 *
 *   E-REG-P01  No Bearer token -> 401 { error: 'Unauthorized' }, and
 *              nothing is written (no registration, no order).
 *   E-REG-P02  Missing eventId or missing transactionId -> 400
 *              { error: 'Missing required fields: eventId or
 *              transactionId' }. The field check runs BEFORE the event
 *              lookup (a missing-field body for an unknown event is
 *              still a 400, never a 404).
 *   E-REG-P03  Unknown event -> 404 { error: 'Event not found' }.
 *   E-REG-P04  No database -> 500 { error: 'Firestore not initialized' }.
 *   E-REG-P05  Deadline enforcement: a registrationDeadline in the past
 *              rejects 400 { error: 'Registration has closed. The
 *              deadline for this event has passed.' } and writes
 *              nothing. The deadline is read from EITHER the
 *              { seconds } serialized-Timestamp shape OR a date
 *              string; a deadline exactly == now is NOT closed (the
 *              comparison is strictly greater-than); a future deadline
 *              admits the registration.
 *   E-REG-P06  FINDING (hazard): a deadline stored in the Admin-SDK
 *              Timestamp JSON shape { _seconds, _nanoseconds } is NOT
 *              recognized (the check reads `.seconds`, then falls back
 *              to new Date(value), which is NaN for a plain object), so
 *              a past deadline in that shape does NOT close
 *              registration. The Supabase seam must never emit this
 *              shape for registrationDeadline (see the seam contracts
 *              in src/lib/events/__tests__/
 *              supa-events-seam-contracts.test.ts).
 *   E-REG-P07  Success response shape is exactly { ok: true, message }
 *              with message 'Proof submitted. An admin will verify
 *              your payment and confirm your registration shortly.';
 *              the stored registration carries status 'under_review'
 *              and paymentStatus 'pending'; the unified order carries
 *              status 'pending_verification', originatingModule
 *              'Events', and one item of type 'event_ticket'.
 *   E-REG-P08  FINDING (cross-route contradiction, current behavior):
 *              this route performs NO published / registrationOpen /
 *              deleted check. A payment proof for a DRAFT event, a
 *              registrationOpen:false event, or a soft-deleted event
 *              is accepted and counted. The free route
 *              (POST /registerForEvent) rejects all three. Pinned
 *              as-is; see the cross-route file for the side-by-side.
 *   E-REG-P09  Auth precedes the field check: an unauthenticated
 *              request with a malformed body is a 401, not a 400.
 *
 * Everything is mocked (firebase-admin, the admin-db accessor,
 * notifications, permissions config); the real discipline suspension
 * helper runs against FakeFirestore, exactly as in route.test.ts.
 * Zero live reads.
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

function req(body: unknown, token?: string) {
    return new NextRequest('http://localhost/api/event-registrations', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

function db(): FakeDb {
    return mockDbHolder.db as FakeDb;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDbHolder.db = createFakeDb();
    db().seed('events', 'evt-paid', { title: 'Paid Workshop', status: 'published' });
    db().seed('users', 'user-1', { displayName: 'User One', email: 'one@test.dev' });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    (console.error as jest.Mock).mockRestore?.();
    jest.restoreAllMocks();
});

describe('E-REG-P: auth and field validation arms', () => {
    it('E-REG-P01 an unauthenticated POST is 401 Unauthorized and writes nothing', async () => {
        const res = await POST(req(PAID_BODY));
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Unauthorized' });
        expect(db().all('events/evt-paid/registrations')).toHaveLength(0);
        expect(db().all('orders')).toHaveLength(0);
        expect(mockSend).not.toHaveBeenCalled();
    });

    it('E-REG-P09 auth precedes validation: unauthenticated plus an empty body is still 401, not 400', async () => {
        const res = await POST(req({}));
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Unauthorized' });
    });

    it.each([
        ['missing eventId', { transactionId: 'txn-1' }],
        ['missing transactionId', { eventId: 'evt-paid' }],
        ['missing both', {}],
    ])('E-REG-P02 %s is 400 with the exact missing-fields message', async (_label, body) => {
        const res = await POST(req(body, 'token-user-1'));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
            error: 'Missing required fields: eventId or transactionId',
        });
        expect(db().all('orders')).toHaveLength(0);
    });

    it('E-REG-P02 the field check precedes the event lookup: missing transactionId for an unknown event is 400, not 404', async () => {
        const res = await POST(req({ eventId: 'evt-unknown' }, 'token-user-1'));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('Missing required fields: eventId or transactionId');
    });

    it('E-REG-P03 an unknown event is 404 Event not found and writes nothing', async () => {
        const res = await POST(req({ ...PAID_BODY, eventId: 'evt-unknown' }, 'token-user-1'));
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Event not found' });
        expect(db().all('orders')).toHaveLength(0);
    });

    it('E-REG-P04 with no database the route is 500 Firestore not initialized', async () => {
        mockDbHolder.db = null;
        const res = await POST(req(PAID_BODY, 'token-user-1'));
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'Firestore not initialized' });
    });
});

describe('E-REG-P: registration deadline enforcement', () => {
    const PAST_SECONDS = Math.floor(Date.UTC(2026, 0, 1) / 1000); // 2026-01-01 UTC
    const FUTURE_SECONDS = Math.floor(Date.UTC(2099, 0, 1) / 1000);

    it('E-REG-P05 a past deadline in { seconds } shape closes registration (400) and writes nothing', async () => {
        db().seed('events', 'evt-paid', {
            title: 'Paid Workshop', status: 'published',
            registrationDeadline: { seconds: PAST_SECONDS, nanoseconds: 0 },
        });
        const res = await POST(req(PAID_BODY, 'token-user-1'));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
            error: 'Registration has closed. The deadline for this event has passed.',
        });
        expect(db().all('events/evt-paid/registrations')).toHaveLength(0);
        expect(db().all('orders')).toHaveLength(0);
    });

    it('E-REG-P05 a past deadline stored as a date string also closes registration', async () => {
        db().seed('events', 'evt-paid', {
            title: 'Paid Workshop', status: 'published',
            registrationDeadline: '2026-01-01T00:00:00.000Z',
        });
        const res = await POST(req(PAID_BODY, 'token-user-1'));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/Registration has closed/);
    });

    it('E-REG-P05 a future deadline admits the registration', async () => {
        db().seed('events', 'evt-paid', {
            title: 'Paid Workshop', status: 'published',
            registrationDeadline: { seconds: FUTURE_SECONDS, nanoseconds: 0 },
        });
        const res = await POST(req(PAID_BODY, 'token-user-1'));
        expect(res.status).toBe(200);
        expect(db().all('events/evt-paid/registrations')).toHaveLength(1);
    });

    it('E-REG-P05 a deadline exactly equal to now is NOT closed (strictly-greater comparison)', async () => {
        const exactSeconds = 1_800_000_000;
        jest.spyOn(Date, 'now').mockReturnValue(exactSeconds * 1000);
        db().seed('events', 'evt-paid', {
            title: 'Paid Workshop', status: 'published',
            registrationDeadline: { seconds: exactSeconds, nanoseconds: 0 },
        });
        const res = await POST(req(PAID_BODY, 'token-user-1'));
        expect(res.status).toBe(200);
    });

    it('E-REG-P06 FINDING: a past deadline in { _seconds } shape does NOT close registration (unrecognized shape)', async () => {
        db().seed('events', 'evt-paid', {
            title: 'Paid Workshop', status: 'published',
            registrationDeadline: { _seconds: PAST_SECONDS, _nanoseconds: 0 },
        });
        // Current behavior: the gate silently passes and the proof is
        // accepted for an event whose deadline has passed. The seam
        // must normalize timestamps so this shape never reaches here.
        const res = await POST(req(PAID_BODY, 'token-user-1'));
        expect(res.status).toBe(200);
        expect(db().all('events/evt-paid/registrations')).toHaveLength(1);
    });
});

describe('E-REG-P: success shape and the missing publication gate', () => {
    it('E-REG-P07 the success body is exactly { ok, message } and the stored docs carry the pinned vocabulary', async () => {
        const res = await POST(req(PAID_BODY, 'token-user-1'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            ok: true,
            message: 'Proof submitted. An admin will verify your payment and confirm your registration shortly.',
        });

        const reg = db().read('events/evt-paid/registrations', 'user-1')!;
        expect(Object.keys(reg).sort()).toEqual(
            [
                'uid', 'eventId', 'transactionId', 'screenshotLink', 'displayName', 'email',
                'status', 'paymentStatus', 'paymentMethod', 'amount', 'currency',
                'createdAt', 'updatedAt',
            ].sort(),
        );
        expect(reg.status).toBe('under_review');
        expect(reg.paymentStatus).toBe('pending');

        const orders = db().all('orders');
        expect(orders).toHaveLength(1);
        expect(orders[0].data.status).toBe('pending_verification');
        expect(orders[0].data.originatingModule).toBe('Events');
        expect(orders[0].data.items).toEqual([
            { title: 'Event Registration: Paid Workshop', eventId: 'evt-paid', type: 'event_ticket' },
        ]);
        // Both notification arms fire exactly once on a fresh submission.
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(mockBroadcast).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['draft', { status: 'draft' }],
        ['registrationOpen false', { status: 'published', registrationOpen: false }],
        ['soft-deleted', { status: 'published', deleted: true }],
    ])('E-REG-P08 FINDING: a payment proof is accepted for a %s event (no publication gate on this route)', async (_label, extra) => {
        db().seed('events', 'evt-paid', { title: 'Paid Workshop', ...extra });
        const res = await POST(req(PAID_BODY, 'token-user-1'));
        expect(res.status).toBe(200);
        expect((await res.json()).ok).toBe(true);
        expect(db().read('events/evt-paid/registrations', 'user-1')).toBeTruthy();
        const event = db().read('events', 'evt-paid')!;
        expect(event.attendeeIds).toEqual(['user-1']);
        expect(event.registrationsCount).toBe(1);
    });
});
