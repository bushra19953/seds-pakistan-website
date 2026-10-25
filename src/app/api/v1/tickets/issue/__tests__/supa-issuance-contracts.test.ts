/**
 * @jest-environment node
 *
 * Contract extensions for POST /api/v1/tickets/issue, recorded from
 * the CURRENT Firestore implementation (feat/integration-wave3 @
 * 4d5a1e16) ahead of the Supabase migration (implementer branch
 * feat/supa-events-3, tickets/verify).
 *
 * The pre-existing suites in this directory pin the permission parity
 * (route-parity.test.ts) and the QR-payload / payment-gate integrity
 * (issuance-integrity.test.ts: real verify URL in the QR, paid+unpaid
 * rejection, auto-confirm only from a verified order) and are NOT
 * duplicated here. This file pins the remaining issuance contracts:
 *
 *   E-TKT-01  Deterministic storage identity: a fresh ticket is stored
 *             in eventTickets under doc id "<eventId>_<uid>", with
 *             dbId equal to that doc id, while the human ticketId is
 *             the readable "EVT-<EV6>-<yyyymmdd>-<seq4>" form. The two
 *             ids are different strings serving different lookups.
 *   E-TKT-02  Sequential numbering: consecutive issuances for one
 *             event take ticketNumber 1, 2, ... in order, the event's
 *             ticketCount ends at the number issued, the readable id
 *             suffix is the zero-padded sequence, and each
 *             registration is stamped with its own readable id.
 *   E-TKT-03  Existing-ticket short-circuit, QUERY arm: a pre-existing
 *             ticket matched by the (eventId, uid) field query returns
 *             { ok: true, ticketId: <the matched DOC id>,
 *             ticketNumber, existing: true } — note ticketId here is
 *             the document id, not the readable ticketId field — and
 *             no counter moves and nothing is rewritten.
 *   E-TKT-04  Existing-ticket short-circuit, TRANSACTION arm: a ticket
 *             stored at the deterministic doc id whose fields do NOT
 *             match the (eventId, uid) query is still returned by the
 *             in-transaction get, as
 *             { ok: true, ticketId: <stored readable ticketId>,
 *             ticketNumber, existing: true }, with ticketCount
 *             unchanged.
 *   E-TKT-05  Validation arms and their order: no Bearer -> 401
 *             { error: 'Unauthorized' }; missing eventId or uid ->
 *             400 { error: 'Missing eventId or uid' } (checked before
 *             the permission gate's downstream reads resolve);
 *             an unconfirmed registration -> 400
 *             'Registration not confirmed (status: <status>)';
 *             no registration and no order -> 404
 *             'Registration not found and no order exists for this
 *             user/event'.
 *   E-TKT-06  The stored ticket document shape: exactly the pinned key
 *             set, status 'valid', verificationUrl
 *             "<site>/verify/ticket/<readableId>", eventDate copied
 *             from the event's startAt, and the attendee profile
 *             gaining one eventsAttended entry for the event (a second
 *             issuance adds no duplicate entry — it short-circuits
 *             under E-TKT-03/04 first).
 *
 * Mocking follows issuance-integrity.test.ts: the finance
 * FakeFirestore, a reversible 'qrcode' mock, and the real permissions
 * resolver over seeded role docs. Zero live reads.
 */

import { NextRequest } from 'next/server';
import { createFakeFirestore, type FakeFirestore } from '@/lib/finance/__tests__/fake-firestore';

const mockHolder: { db: FakeFirestore | null } = { db: null };
const mockState = { uid: 'holder-1' };

const adminStub = {
  auth: () => ({
    verifyIdToken: async () => ({ uid: mockState.uid }),
  }),
  firestore: {
    Timestamp: {
      now: () => new Date(),
      fromDate: (d: Date) => d,
    },
    FieldValue: {
      serverTimestamp: () => new Date(),
      arrayUnion: (v: unknown) => ({ __arrayUnion: v }),
    },
  },
};

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: adminStub,
  ...adminStub,
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockHolder.db,
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: jest.fn(async () => undefined),
    broadcastByRoles: jest.fn(async () => undefined),
  },
}));

jest.mock('qrcode', () => {
  const encode = async (text: string) =>
    `data:image/png;base64,${Buffer.from(text, 'utf8').toString('base64')}`;
  const api = { toDataURL: encode, toBuffer: async (text: string) => Buffer.from(text, 'utf8') };
  return { __esModule: true, default: api, ...api };
});

import { POST } from '@/app/api/v1/tickets/issue/route';

const CUSTOM = 'custom_verify_design_aide';
const EVENT_ID = 'gala2026';

function req(body: unknown, withAuth = true) {
  return new NextRequest('http://localhost/api/v1/tickets/issue', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(withAuth ? { authorization: 'Bearer test-token' } : {}),
    },
    body: JSON.stringify(body),
  });
}

let db: FakeFirestore;

function seedUser(uid: string) {
  db.__seed('users', uid, { displayName: `User ${uid}`, email: `${uid}@example.com`, eventsAttended: [] });
}

function seedConfirmed(uid: string, extra: Record<string, unknown> = {}) {
  db.__seed(`events/${EVENT_ID}/registrations`, uid, {
    status: 'confirmed',
    paymentStatus: 'verified',
    displayName: `User ${uid}`,
    email: `${uid}@example.com`,
    paymentMethod: 'bank_transfer',
    ...extra,
  });
}

beforeEach(() => {
  db = createFakeFirestore() as never;
  mockHolder.db = db;
  mockState.uid = 'holder-1';
  db.__seed('roleDefinitions', CUSTOM, { isCustom: true, permissions: ['canManageEvents'] });
  db.__seed('roles', 'holder-1', { role: 'member', additionalRoles: [CUSTOM] });
  db.__seed('events', EVENT_ID, {
    title: 'Founders Gala',
    venue: 'IST Auditorium',
    startAt: '2026-11-01T05:00:00.000Z',
    ticketCount: 0,
    paymentDetails: { isPaid: false },
  });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
  (console.warn as jest.Mock).mockRestore?.();
  (console.log as jest.Mock).mockRestore?.();
});

describe('E-TKT: deterministic identity and sequential numbering', () => {
  it('E-TKT-01 a fresh ticket lives at eventTickets/<eventId>_<uid> with dbId equal to the doc id and a different readable ticketId', async () => {
    seedUser('target-1');
    seedConfirmed('target-1');
    const res = await POST(req({ eventId: EVENT_ID, uid: 'target-1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const stored = db.__doc('eventTickets', `${EVENT_ID}_target-1`);
    expect(stored).toBeDefined();
    expect(stored!.dbId).toBe(`${EVENT_ID}_target-1`);
    expect(stored!.ticketId).toBe(body.ticketId);
    expect(stored!.ticketId).not.toBe(`${EVENT_ID}_target-1`);
    expect(body.ticketId).toMatch(/^EVT-GALA20-\d{8}-0001$/);
    expect(body.ticketNumber).toBe(1);
    expect(body.existing).toBe(false);
  });

  it('E-TKT-02 two issuances take sequential numbers 1 and 2, move ticketCount to 2, and stamp each registration', async () => {
    seedUser('target-1');
    seedUser('target-2');
    seedConfirmed('target-1');
    seedConfirmed('target-2');

    const first = await (await POST(req({ eventId: EVENT_ID, uid: 'target-1' }))).json();
    const second = await (await POST(req({ eventId: EVENT_ID, uid: 'target-2' }))).json();

    expect(first.ticketNumber).toBe(1);
    expect(second.ticketNumber).toBe(2);
    expect(first.ticketId).toMatch(/-0001$/);
    expect(second.ticketId).toMatch(/-0002$/);
    expect(db.__doc('events', EVENT_ID)!.ticketCount).toBe(2);
    expect(db.__doc(`events/${EVENT_ID}/registrations`, 'target-1')!.ticketId).toBe(first.ticketId);
    expect(db.__doc(`events/${EVENT_ID}/registrations`, 'target-2')!.ticketId).toBe(second.ticketId);
  });

  it('E-TKT-02 numbering continues from the stored ticketCount, it does not restart or scan existing tickets', async () => {
    db.__seed('events', EVENT_ID, {
      title: 'Founders Gala', venue: 'IST Auditorium', ticketCount: 41, paymentDetails: { isPaid: false },
    });
    seedUser('target-1');
    seedConfirmed('target-1');
    const body = await (await POST(req({ eventId: EVENT_ID, uid: 'target-1' }))).json();
    expect(body.ticketNumber).toBe(42);
    expect(body.ticketId).toMatch(/-0042$/);
    expect(db.__doc('events', EVENT_ID)!.ticketCount).toBe(42);
  });

  it('E-TKT-06 the stored ticket document carries exactly the pinned shape', async () => {
    seedUser('target-1');
    seedConfirmed('target-1');
    const body = await (await POST(req({ eventId: EVENT_ID, uid: 'target-1' }))).json();
    const stored = db.__doc('eventTickets', `${EVENT_ID}_target-1`)!;
    expect(Object.keys(stored).sort()).toEqual(
      [
        'ticketId', 'dbId', 'ticketNumber', 'uid', 'eventId', 'displayName', 'email',
        'eventTitle', 'eventDate', 'eventVenue', 'issuedAt', 'status', 'qrCodeDataUrl',
        'verificationUrl', 'uniqueTicketUrl', 'paymentMethod', 'paymentRef', 'registrationId',
      ].sort(),
    );
    expect(stored.status).toBe('valid');
    expect(stored.eventDate).toBe('2026-11-01T05:00:00.000Z'); // copied from event.startAt
    expect(stored.eventVenue).toBe('IST Auditorium');
    expect(stored.verificationUrl).toBe(`https://sedspakistan.live/verify/ticket/${body.ticketId}`);
    expect(stored.registrationId).toBe('target-1');

    const user = db.__doc('users', 'target-1')!;
    const attended = user.eventsAttended as any[];
    expect(attended).toHaveLength(1);
    expect(attended[0].eventId).toBe(EVENT_ID);
    expect(attended[0].ticketId).toBe(body.ticketId);
  });
});

describe('E-TKT: existing-ticket short-circuits', () => {
  it('E-TKT-03 a ticket matched by the (eventId, uid) query returns its DOC id as ticketId, existing:true, and moves nothing', async () => {
    seedUser('target-1');
    seedConfirmed('target-1');
    // Legacy-shaped ticket: doc id is the old readable-style id, and it
    // is what the query arm returns as `ticketId`.
    db.__seed('eventTickets', 'EVT-LEGACY-0007', {
      eventId: EVENT_ID, uid: 'target-1', ticketId: 'EVT-LEGACY-0007', ticketNumber: 7, status: 'valid',
    });
    const before = db.__doc('events', EVENT_ID);

    const res = await POST(req({ eventId: EVENT_ID, uid: 'target-1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true, ticketId: 'EVT-LEGACY-0007', ticketNumber: 7, existing: true,
    });
    expect(db.__doc('events', EVENT_ID)).toEqual(before); // ticketCount untouched
    expect(db.__doc(`events/${EVENT_ID}/registrations`, 'target-1')!.ticketId).toBeUndefined();
  });

  it('E-TKT-04 a ticket at the deterministic doc id that the field query misses is returned by the transaction arm with its readable id', async () => {
    seedUser('target-1');
    seedConfirmed('target-1');
    // Stored WITHOUT eventId/uid fields, so the (eventId, uid) query
    // cannot match it; only the transactional doc get can find it.
    db.__seed('eventTickets', `${EVENT_ID}_target-1`, {
      ticketId: 'EVT-GALA20-20261101-0009', ticketNumber: 9, status: 'valid',
    });
    const res = await POST(req({ eventId: EVENT_ID, uid: 'target-1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true, ticketId: 'EVT-GALA20-20261101-0009', ticketNumber: 9, existing: true,
    });
    expect(db.__doc('events', EVENT_ID)!.ticketCount).toBe(0);
  });

  it('E-TKT-03/04 re-issuing to the same attendee is idempotent: same number, no second ticket, no duplicate profile entry', async () => {
    seedUser('target-1');
    seedConfirmed('target-1');
    const first = await (await POST(req({ eventId: EVENT_ID, uid: 'target-1' }))).json();
    const secondRes = await POST(req({ eventId: EVENT_ID, uid: 'target-1' }));
    const second = await secondRes.json();
    expect(second.existing).toBe(true);
    expect(second.ticketNumber).toBe(first.ticketNumber);
    expect(db.__doc('events', EVENT_ID)!.ticketCount).toBe(1);
    expect((db.__doc('users', 'target-1')!.eventsAttended as any[])).toHaveLength(1);
  });
});

describe('E-TKT: validation arms', () => {
  it('E-TKT-05 a request with no Bearer token is 401 Unauthorized', async () => {
    const res = await POST(req({ eventId: EVENT_ID, uid: 'target-1' }, false));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it.each([
    ['missing eventId', { uid: 'target-1' }],
    ['missing uid', { eventId: EVENT_ID }],
    ['missing both', {}],
  ])('E-TKT-05 %s is 400 Missing eventId or uid', async (_label, body) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing eventId or uid' });
  });

  it('E-TKT-05 an unconfirmed registration is 400 naming its status, and no ticket is written', async () => {
    seedUser('target-1');
    seedConfirmed('target-1', { status: 'under_review', paymentStatus: 'pending' });
    const res = await POST(req({ eventId: EVENT_ID, uid: 'target-1' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Registration not confirmed (status: under_review)' });
    expect(db.__doc('eventTickets', `${EVENT_ID}_target-1`)).toBeUndefined();
    expect(db.__doc('events', EVENT_ID)!.ticketCount).toBe(0);
  });

  it("E-TKT-05 a 'verified' registration status is accepted as confirmed-equivalent", async () => {
    seedUser('target-1');
    seedConfirmed('target-1', { status: 'verified' });
    const res = await POST(req({ eventId: EVENT_ID, uid: 'target-1' }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('E-TKT-05 no registration and no order is 404 with the pinned message', async () => {
    seedUser('target-1');
    const res = await POST(req({ eventId: EVENT_ID, uid: 'target-1' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'Registration not found and no order exists for this user/event',
    });
  });

  it('E-TKT-05 with no database the route is 500 Firestore not initialized', async () => {
    mockHolder.db = null;
    const res = await POST(req({ eventId: EVENT_ID, uid: 'target-1' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Firestore not initialized' });
  });
});
