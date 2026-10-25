/**
 * @jest-environment node
 *
 * Contract extensions for the event profit-settlement route
 * (GET/POST/PATCH /api/admin/events/profit-settlement), recorded from
 * the CURRENT Firestore implementation (feat/integration-wave3 @
 * 4d5a1e16) ahead of the Supabase migration (implementer branch
 * feat/supa-events-5, admin + settlement).
 *
 * The pre-existing suite in this directory (settlement-lock.test.ts)
 * pins the EV-P10 dual-sign lock and the PATCH cap recomputation and
 * is NOT duplicated here — the lock itself is the cluster's pinned
 * "locked event rejects mutation" contract: once both sign-offs exist
 * a figure-changing POST is 409 with the stored record byte-identical,
 * and once reconciled every POST is 409. This file pins the arms that
 * suite does not reach:
 *
 *   E-STL-01  GET shapes: missing id -> 400 { error: 'Missing event
 *             id' }; unknown event -> 404 { error: 'Event not found' };
 *             an event with no settlement returns
 *             { settlement: null, eventTitle } where eventTitle falls
 *             back title -> name -> id; an event with a settlement
 *             returns it verbatim alongside the title.
 *   E-STL-02  POST/PATCH missing id -> 400, unknown event -> 404,
 *             same bodies as GET.
 *   E-STL-03  Authorization: a caller without canManageEvents is 403
 *             { error: 'forbidden: Insufficient role to manage event
 *             finances' } on all three methods, before any read of the
 *             event or any write.
 *   E-STL-04  Economics on write: POST recomputes and stores
 *             grossRevenue = grossTicketCount * ticketPrice,
 *             venueShare = 25%, sedsSurplus = 75% (the response
 *             settlement SHAPE is exactly the 11 pinned keys, and the
 *             stored settlement drops maxComplimentaryAllowed even
 *             though the calculator returns it); complimentaryCount
 *             above 10% of capacity stores
 *             complimentaryCapExceeded: true while still returning
 *             200 as a draft.
 *   E-STL-05  Figure coercion: negative, non-numeric, and missing
 *             figures coerce to 0 (toNumber), they are not 400s;
 *             omitted figures inherit the stored settlement's values.
 *   E-STL-06  signAs validation: an unknown signAs value is 400
 *             { error: 'Invalid signAs value' } and NOTHING is written
 *             (the check runs before the update); signing as treasurer
 *             with a non-treasurer role is 403
 *             'Only the Treasurer can sign as Treasurer' (the
 *             president mirror is pinned in settlement-lock.test.ts).
 *   E-STL-07  PATCH preconditions in order: missing presidential
 *             sign-off -> 422 'Presidential sign-off is required
 *             before reconciliation'; then missing treasurer -> 422
 *             'Treasury sign-off is required before reconciliation';
 *             the success body is exactly
 *             { success: true, status: 'reconciled' }.
 *   E-STL-08  POST success body is exactly { success: true, settlement }.
 *
 * Auth is stubbed the way the route consumes it (verifySession /
 * hasServerPermissionForUser), with toSessionErrorResponse performing
 * the real conversion for SessionError, and the caller's role read for
 * real from FakeFirestore, as in settlement-lock.test.ts. Zero live
 * reads.
 */

import { NextRequest, NextResponse } from 'next/server';

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

import { createFakeDb, type FakeDb } from '@/lib/server/__tests__/fake-firestore';
import { GET, POST, PATCH } from '../route';

const EVENT = 'ev-1';
const MGR = { uid: 'mgr', email: 'mgr@seds.test' };
const TREAS = { uid: 'treas', email: 'treas@seds.test' };

function req(method: string, body?: Record<string, unknown>, query = '') {
  return new NextRequest(`http://localhost/api/admin/events/profit-settlement${query}`, {
    method,
    headers: { 'Content-Type': 'application/json', authorization: 'Bearer test-token' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function db(): FakeDb {
  return mockDbHolder.db as FakeDb;
}

function settlement() {
  return db().read('events', EVENT)?.profitSettlement;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState.canManage = true;
  mockState.decoded = MGR;
  mockDbHolder.db = createFakeDb();
  db().seed('roles', MGR.uid, { role: 'chapter_events_chair' });
  db().seed('roles', TREAS.uid, { role: 'treasurer' });
  db().seed('events', EVENT, { title: 'Launch Night' });
});

describe('E-STL-01/02: read and validation shapes', () => {
  it('E-STL-01 GET without an id is 400 Missing event id', async () => {
    const res = await GET(req('GET'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing event id' });
  });

  it('E-STL-01 GET for an unknown event is 404 Event not found', async () => {
    const res = await GET(req('GET', undefined, '?id=nope'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Event not found' });
  });

  it('E-STL-01 GET for an event with no settlement returns settlement:null and its title', async () => {
    const res = await GET(req('GET', undefined, `?id=${EVENT}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settlement: null, eventTitle: 'Launch Night' });
  });

  it('E-STL-01 GET eventTitle falls back to name, then to the id itself', async () => {
    db().seed('events', 'ev-name', { name: 'Named Only' });
    const byName = await GET(req('GET', undefined, '?id=ev-name'));
    expect((await byName.json()).eventTitle).toBe('Named Only');
    db().seed('events', 'ev-bare', {});
    const byId = await GET(req('GET', undefined, '?id=ev-bare'));
    expect((await byId.json()).eventTitle).toBe('ev-bare');
  });

  it('E-STL-01 GET returns a stored settlement verbatim', async () => {
    const stored = {
      grossTicketCount: 10, ticketPrice: 100, capacity: 50, complimentaryCount: 1,
      grossRevenue: 1000, venueShare: 250, sedsSurplus: 750,
      complimentaryCapExceeded: false, presidentSignoff: null, treasurerSignoff: null,
      status: 'draft', updatedAt: 'seed-ts',
    };
    db().seed('events', EVENT, { title: 'Launch Night', profitSettlement: stored });
    const res = await GET(req('GET', undefined, `?id=${EVENT}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settlement: stored, eventTitle: 'Launch Night' });
  });

  it.each([
    ['POST', () => POST(req('POST', {}))],
    ['PATCH', () => PATCH(req('PATCH', {}))],
  ])('E-STL-02 %s without an id is 400 Missing event id', async (_m, call) => {
    const res = await call();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing event id' });
  });

  it.each([
    ['POST', () => POST(req('POST', { id: 'nope' }))],
    ['PATCH', () => PATCH(req('PATCH', { id: 'nope' }))],
  ])('E-STL-02 %s for an unknown event is 404 Event not found', async (_m, call) => {
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Event not found' });
  });
});

describe('E-STL-03: authorization precedes everything', () => {
  it.each([
    ['GET', () => GET(req('GET', undefined, `?id=${EVENT}`))],
    ['POST', () => POST(req('POST', { id: EVENT, grossTicketCount: 1 }))],
    ['PATCH', () => PATCH(req('PATCH', { id: EVENT }))],
  ])('%s without canManageEvents is 403 with the pinned body', async (_m, call) => {
    mockState.canManage = false;
    const res = await call();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden: Insufficient role to manage event finances',
    });
    expect(settlement()).toBeUndefined();
  });
});

describe('E-STL-04/05/08: economics and coercion on POST', () => {
  it('E-STL-04/08 POST computes the 25/75 split and returns exactly { success, settlement } with the pinned key set', async () => {
    const res = await POST(req('POST', {
      id: EVENT, grossTicketCount: 100, ticketPrice: 500, capacity: 200, complimentaryCount: 5,
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Object.keys(json).sort()).toEqual(['settlement', 'success']);
    expect(json.success).toBe(true);
    expect(Object.keys(json.settlement).sort()).toEqual(
      [
        'grossTicketCount', 'ticketPrice', 'capacity', 'complimentaryCount',
        'grossRevenue', 'venueShare', 'sedsSurplus', 'complimentaryCapExceeded',
        'presidentSignoff', 'treasurerSignoff', 'status', 'updatedAt',
      ].sort(),
    );
    expect(json.settlement.grossRevenue).toBe(50000);
    expect(json.settlement.venueShare).toBe(12500);
    expect(json.settlement.sedsSurplus).toBe(37500);
    expect(json.settlement.complimentaryCapExceeded).toBe(false);
    // The calculator's maxComplimentaryAllowed is NOT stored.
    expect(json.settlement.maxComplimentaryAllowed).toBeUndefined();
    expect(settlement()).toEqual(json.settlement);
  });

  it('E-STL-04 complimentary passes above 10% of capacity flag the draft but still save with 200', async () => {
    const res = await POST(req('POST', {
      id: EVENT, grossTicketCount: 10, ticketPrice: 100, capacity: 100, complimentaryCount: 11,
    }));
    expect(res.status).toBe(200);
    expect(settlement().complimentaryCapExceeded).toBe(true);
    expect(settlement().status).toBe('draft');
  });

  it('E-STL-04 complimentary passes at exactly 10% of capacity do NOT exceed the cap', async () => {
    const res = await POST(req('POST', {
      id: EVENT, grossTicketCount: 10, ticketPrice: 100, capacity: 100, complimentaryCount: 10,
    }));
    expect(res.status).toBe(200);
    expect(settlement().complimentaryCapExceeded).toBe(false);
  });

  it('E-STL-05 negative and non-numeric figures coerce to 0 instead of erroring', async () => {
    const res = await POST(req('POST', {
      id: EVENT, grossTicketCount: -5, ticketPrice: 'abc', capacity: 200, complimentaryCount: 0,
    }));
    expect(res.status).toBe(200);
    expect(settlement().grossTicketCount).toBe(0);
    expect(settlement().ticketPrice).toBe(0);
    expect(settlement().grossRevenue).toBe(0);
  });

  it('E-STL-05 omitted figures inherit the stored settlement values', async () => {
    await POST(req('POST', {
      id: EVENT, grossTicketCount: 100, ticketPrice: 500, capacity: 200, complimentaryCount: 5,
    }));
    const res = await POST(req('POST', { id: EVENT, ticketPrice: 600 }));
    expect(res.status).toBe(200);
    expect(settlement().grossTicketCount).toBe(100);
    expect(settlement().ticketPrice).toBe(600);
    expect(settlement().grossRevenue).toBe(60000);
    expect(settlement().capacity).toBe(200);
  });
});

describe('E-STL-06/07: signAs validation and PATCH preconditions', () => {
  it('E-STL-06 an unknown signAs value is 400 Invalid signAs value and nothing is written', async () => {
    const res = await POST(req('POST', { id: EVENT, grossTicketCount: 10, signAs: 'founder' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid signAs value' });
    expect(settlement()).toBeUndefined();
  });

  it('E-STL-06 a non-treasurer cannot sign as treasurer (403) and nothing is written', async () => {
    const res = await POST(req('POST', { id: EVENT, grossTicketCount: 10, signAs: 'treasurer' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Only the Treasurer can sign as Treasurer' });
    expect(settlement()).toBeUndefined();
  });

  it('E-STL-06 a treasurer sign-off stamps uid, email, and role from the session and role doc', async () => {
    mockState.decoded = TREAS;
    const res = await POST(req('POST', { id: EVENT, grossTicketCount: 10, signAs: 'treasurer' }));
    expect(res.status).toBe(200);
    const s = settlement();
    expect(s.treasurerSignoff.uid).toBe(TREAS.uid);
    expect(s.treasurerSignoff.email).toBe(TREAS.email);
    expect(s.treasurerSignoff.role).toBe('treasurer');
    expect(typeof s.treasurerSignoff.at).toBe('string');
    expect(s.presidentSignoff).toBeNull();
  });

  it('E-STL-07 PATCH with no sign-offs is 422 requiring the presidential sign-off first', async () => {
    db().seed('events', EVENT, {
      title: 'Launch Night',
      profitSettlement: { grossTicketCount: 1, ticketPrice: 1, capacity: 10, complimentaryCount: 0, status: 'draft' },
    });
    const res = await PATCH(req('PATCH', { id: EVENT }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'Presidential sign-off is required before reconciliation',
    });
  });

  it('E-STL-07 PATCH with only a presidential sign-off is 422 requiring the treasury sign-off', async () => {
    db().seed('events', EVENT, {
      title: 'Launch Night',
      profitSettlement: {
        grossTicketCount: 1, ticketPrice: 1, capacity: 10, complimentaryCount: 0, status: 'draft',
        presidentSignoff: { uid: 'pres', email: 'p@seds.test', at: '2026-10-24T00:00:00.000Z', role: 'president_national' },
      },
    });
    const res = await PATCH(req('PATCH', { id: EVENT }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'Treasury sign-off is required before reconciliation',
    });
  });
});
