/**
 * @jest-environment node
 *
 * DEFECT 3 regression suite: GET /api/admin/events/profit-settlement/computed
 *
 * The settlement ledger's figures must be COMPUTED from the event's
 * confirmed, payment-verified registrations/orders — never from the
 * manually-entered profitSettlement doc (which nothing in the sales
 * flow ever writes, so a real PKR 500 sale showed as all zeros).
 *
 * This route is additive: the pinned GET/POST/PATCH shapes of
 * ../route.ts (supa-settlement-contracts, settlement-lock) are
 * untouched. Auth is stubbed exactly as in those suites; the database
 * is the shared FakeFirestore. Zero live reads.
 *
 * Fixture (EV2 PAID TEST, mirroring the live retest):
 *  - event capacity 100, paymentDetails.amount 500, linked product
 *    price 500, stored settlement holding only a manual
 *    complimentaryCount of 2 (and stale zero figures).
 *  - registrations: u1 confirmed+verified via store checkout (no
 *    amount on the registration; order ord-1 carries totalPkr 500),
 *    u2 confirmed+verified with amount 500 on the registration,
 *    u3 pending/pending, u4 confirmed/unpaid — only u1+u2 are sales.
 *  Expected computed: count 2, revenue 1000, base price 500,
 *  capacity 100, venue 250, SEDS 750, complimentaryCount 2.
 */

const mockState = {
  decoded: { uid: 'mgr', email: 'mgr@seds.test' } as { uid: string; email: string },
  canManage: true,
};

jest.mock('@/lib/auth/verifySession', () => {
  class SessionError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  return {
    verifySession: jest.fn(async () => mockState.decoded),
    SessionError,
    toSessionErrorResponse: (err: unknown) =>
      err instanceof SessionError
        ? NextResponse.json({ error: err.message }, { status: err.statusCode })
        : null,
  };
});

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => mockState.canManage),
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => 'ts' },
}));

import { NextRequest, NextResponse } from 'next/server';
import { createFakeDb, type FakeDb } from '@/lib/server/__tests__/fake-firestore';
import { GET } from '../route';

const EVENT = 'ev-2';
const MGR = { uid: 'mgr', email: 'mgr@seds.test' };
const REGS = `events/${EVENT}/registrations`;

function req(query = '') {
  return new NextRequest(`http://localhost/api/admin/events/profit-settlement/computed${query}`, {
    method: 'GET',
    headers: { authorization: 'Bearer test-token' },
  });
}

function db(): FakeDb {
  return mockDbHolder.db as FakeDb;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState.canManage = true;
  mockState.decoded = MGR;
  mockDbHolder.db = createFakeDb();
  db().seed('roles', MGR.uid, { role: 'chapter_events_chair' });
  db().seed('events', EVENT, {
    title: 'EV2 PAID TEST',
    capacity: 100,
    paymentDetails: { isPaid: true, amount: 500, currency: 'PKR' },
    linkedStoreProductId: 'prod-1',
    profitSettlement: {
      grossTicketCount: 0, ticketPrice: 0, capacity: 0, complimentaryCount: 2,
      grossRevenue: 0, venueShare: 0, sedsSurplus: 0, complimentaryCapExceeded: false,
      presidentSignoff: null, treasurerSignoff: null, status: 'draft', updatedAt: 'seed-ts',
    },
  });
  db().seed('products', 'prod-1', { price: 500, category: 'event_ticket', isActive: true });
  db().seed(REGS, 'u1', { uid: 'u1', status: 'confirmed', paymentStatus: 'verified', orderId: 'ord-1' });
  db().seed(REGS, 'u2', { uid: 'u2', status: 'confirmed', paymentStatus: 'verified', amount: 500 });
  db().seed(REGS, 'u3', { uid: 'u3', status: 'pending', paymentStatus: 'pending', amount: 500 });
  db().seed(REGS, 'u4', { uid: 'u4', status: 'confirmed', paymentStatus: 'unpaid', amount: 500 });
  db().seed('orders', 'ord-1', { totalPkr: 500, total: 500, eventId: EVENT });
});

describe('computed settlement figures', () => {
  it('computes count, revenue and the 25/75 split from confirmed+verified sales', async () => {
    const res = await GET(req(`?id=${EVENT}`));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.eventTitle).toBe('EV2 PAID TEST');
    expect(json.computed).toEqual({
      grossTicketCount: 2,
      ticketPrice: 500,
      capacity: 100,
      complimentaryCount: 2,
      grossRevenue: 1000,
      venueShare: 250,
      sedsSurplus: 750,
      complimentaryCapExceeded: false,
    });
  });

  it('falls back to the linked product price when the event carries no payment amount', async () => {
    db().seed('events', 'ev-3', {
      title: 'Product Priced',
      capacity: 50,
      linkedStoreProductId: 'prod-9',
    });
    db().seed('products', 'prod-9', { price: 800, category: 'event_ticket', isActive: true });
    db().seed('events/ev-3/registrations', 'u9', {
      uid: 'u9', status: 'confirmed', paymentStatus: 'verified',
    });
    const res = await GET(req('?id=ev-3'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.computed.grossTicketCount).toBe(1);
    expect(json.computed.ticketPrice).toBe(800);
    expect(json.computed.grossRevenue).toBe(800);
    expect(json.computed.capacity).toBe(50);
  });

  it('an event with no sales computes zeros (and does not invent figures)', async () => {
    db().seed('events', 'ev-4', { title: 'Empty', capacity: 10, paymentDetails: { amount: 500 } });
    const res = await GET(req('?id=ev-4'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.computed.grossTicketCount).toBe(0);
    expect(json.computed.grossRevenue).toBe(0);
    expect(json.computed.venueShare).toBe(0);
    expect(json.computed.sedsSurplus).toBe(0);
  });
});

describe('validation and authorization (same contract as the settlement route)', () => {
  it('missing id is 400', async () => {
    const res = await GET(req());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing event id' });
  });

  it('unknown event is 404', async () => {
    const res = await GET(req('?id=nope'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Event not found' });
  });

  it('a caller without canManageEvents is 403', async () => {
    mockState.canManage = false;
    const res = await GET(req(`?id=${EVENT}`));
    expect(res.status).toBe(403);
  });
});
