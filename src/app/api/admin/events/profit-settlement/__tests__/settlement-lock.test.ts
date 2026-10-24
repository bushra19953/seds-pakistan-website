/**
 * @jest-environment node
 *
 * EV-P10 regression suite: the settlement dual-sign lock.
 *
 * Before this fix, POST /api/admin/events/profit-settlement preserved
 * both sign-offs while accepting NEW figures and hard-coding status
 * back to "draft" — so signatures certified figures that could be
 * silently replaced afterwards, and a reconciled ledger could be
 * un-reconciled by a plain save.
 *
 * Specified behaviour under test:
 *  - Figures stay editable with zero or one sign-off.
 *  - Once BOTH sign-offs exist, a POST that changes any of the four
 *    signed figures, or that carries signAs, is rejected 409 (the
 *    codebase's conflict code) and the stored record is untouched.
 *  - A POST that changes nothing (figures omitted or identical, no
 *    signAs) is still accepted while the record is an unreconciled
 *    draft: this API has no non-figure fields to update, so that
 *    no-op save is the only "non-figure update" that exists.
 *  - Once status is "reconciled", every POST is rejected 409: the
 *    ledger is final and must never flip back to "draft" via POST.
 *  - PATCH reconcile recomputes the complimentary cap from the stored
 *    figures instead of trusting the stored flag.
 *
 * Auth is stubbed (verifySession / hasServerPermissionForUser) and the
 * caller's primary role is read for real from a FakeFirestore roles
 * doc, exactly as the route's getCallerRole does in production.
 */

const mockState = {
  decoded: { uid: 'mgr', email: 'mgr@seds.test' } as { uid: string; email: string },
  canManage: true,
};

jest.mock('@/lib/auth/verifySession', () => ({
  verifySession: jest.fn(async () => mockState.decoded),
  toSessionErrorResponse: () => null,
  SessionError: class SessionError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

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

import { NextRequest } from 'next/server';
import { createFakeDb, type FakeDb } from '@/lib/server/__tests__/fake-firestore';
import { POST, PATCH } from '../route';

const EVENT = 'ev-1';
const FIGURES = { grossTicketCount: 100, ticketPrice: 500, capacity: 200, complimentaryCount: 5 };

const PRES = { uid: 'pres', email: 'pres@seds.test' };
const TREAS = { uid: 'treas', email: 'treas@seds.test' };
const MGR = { uid: 'mgr', email: 'mgr@seds.test' };

function as(caller: { uid: string; email: string }) {
  mockState.decoded = caller;
}

function req(method: 'POST' | 'PATCH', body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/admin/events/profit-settlement', {
    method,
    headers: { 'Content-Type': 'application/json', authorization: 'Bearer test-token' },
    body: JSON.stringify(body),
  });
}

function post(body: Record<string, unknown>) {
  return POST(req('POST', body));
}

function patch() {
  return PATCH(req('PATCH', { id: EVENT }));
}

function db() {
  return mockDbHolder.db as FakeDb;
}

function eventDoc() {
  return db().read('events', EVENT) as Record<string, any>;
}

function settlement() {
  return eventDoc().profitSettlement;
}

function dualSignedSettlement(overrides: Record<string, unknown> = {}) {
  return {
    ...FIGURES,
    grossRevenue: 50000,
    venueShare: 12500,
    sedsSurplus: 37500,
    complimentaryCapExceeded: false,
    presidentSignoff: { uid: PRES.uid, email: PRES.email, at: '2026-10-24T00:00:00.000Z', role: 'president_national' },
    treasurerSignoff: { uid: TREAS.uid, email: TREAS.email, at: '2026-10-24T00:05:00.000Z', role: 'treasurer' },
    status: 'draft',
    updatedAt: 'seed-ts',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState.canManage = true;
  as(MGR);
  mockDbHolder.db = createFakeDb();
  db().seed('roles', MGR.uid, { role: 'chapter_events_chair' });
  db().seed('roles', PRES.uid, { role: 'president_national' });
  db().seed('roles', TREAS.uid, { role: 'treasurer' });
  db().seed('events', EVENT, { title: 'Launch Night' });
});

describe('settlement figures before dual sign-off', () => {
  it('pre-signature figure edit succeeds and computes the split', async () => {
    const res = await post({ id: EVENT, ...FIGURES });
    expect(res.status).toBe(200);
    const s = settlement();
    expect(s.grossTicketCount).toBe(100);
    expect(s.ticketPrice).toBe(500);
    expect(s.grossRevenue).toBe(50000);
    expect(s.venueShare).toBe(12500);
    expect(s.sedsSurplus).toBe(37500);
    expect(s.status).toBe('draft');
    expect(s.presidentSignoff).toBeNull();
    expect(s.treasurerSignoff).toBeNull();
  });

  it('president sign-off succeeds, then a single-signature figure edit still succeeds', async () => {
    as(PRES);
    const signRes = await post({ id: EVENT, ...FIGURES, signAs: 'president' });
    expect(signRes.status).toBe(200);
    expect(settlement().presidentSignoff.uid).toBe(PRES.uid);
    expect(settlement().treasurerSignoff).toBeNull();

    as(MGR);
    const editRes = await post({ id: EVENT, ...FIGURES, ticketPrice: 600 });
    expect(editRes.status).toBe(200);
    expect(settlement().ticketPrice).toBe(600);
    expect(settlement().grossRevenue).toBe(60000);
    // The single existing sign-off is preserved across the edit.
    expect(settlement().presidentSignoff.uid).toBe(PRES.uid);
  });

  it('treasurer sign-off completes the pair', async () => {
    as(PRES);
    await post({ id: EVENT, ...FIGURES, signAs: 'president' });
    as(TREAS);
    const res = await post({ id: EVENT, signAs: 'treasurer' });
    expect(res.status).toBe(200);
    expect(settlement().presidentSignoff.uid).toBe(PRES.uid);
    expect(settlement().treasurerSignoff.uid).toBe(TREAS.uid);
  });

  it('a non-president still cannot sign as president', async () => {
    as(MGR);
    const res = await post({ id: EVENT, ...FIGURES, signAs: 'president' });
    expect(res.status).toBe(403);
    expect(settlement()).toBeUndefined();
  });
});

describe('dual-signed settlement is locked (EV-P10)', () => {
  beforeEach(() => {
    db().seed('events', EVENT, { title: 'Launch Night', profitSettlement: dualSignedSettlement() });
  });

  it('figure edit after both sign-offs is rejected 409 and the record is byte-identical', async () => {
    const before = eventDoc();
    const res = await post({ id: EVENT, ...FIGURES, ticketPrice: 999 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/locked/i);
    expect(eventDoc()).toEqual(before);
    expect(settlement().status).toBe('draft');
    expect(settlement().presidentSignoff.uid).toBe(PRES.uid);
    expect(settlement().treasurerSignoff.uid).toBe(TREAS.uid);
  });

  it.each(['grossTicketCount', 'capacity', 'complimentaryCount'])(
    'changing only %s after both sign-offs is also rejected',
    async (field) => {
      const before = eventDoc();
      const res = await post({ id: EVENT, [field]: (FIGURES as any)[field] + 1 });
      expect(res.status).toBe(409);
      expect(eventDoc()).toEqual(before);
    }
  );

  it('a further sign-off attempt after both sign-offs is rejected 409', async () => {
    const before = eventDoc();
    as(PRES);
    const res = await post({ id: EVENT, signAs: 'president' });
    expect(res.status).toBe(409);
    expect(eventDoc()).toEqual(before);
  });

  it('a no-change POST (no figure keys, no signAs) is accepted and leaves figures and status intact', async () => {
    const res = await post({ id: EVENT });
    expect(res.status).toBe(200);
    const s = settlement();
    expect(s.grossTicketCount).toBe(FIGURES.grossTicketCount);
    expect(s.ticketPrice).toBe(FIGURES.ticketPrice);
    expect(s.capacity).toBe(FIGURES.capacity);
    expect(s.complimentaryCount).toBe(FIGURES.complimentaryCount);
    expect(s.status).toBe('draft');
    expect(s.presidentSignoff.uid).toBe(PRES.uid);
    expect(s.treasurerSignoff.uid).toBe(TREAS.uid);
  });

  it('a POST repeating the identical figures explicitly is also accepted', async () => {
    const res = await post({ id: EVENT, ...FIGURES });
    expect(res.status).toBe(200);
    expect(settlement().ticketPrice).toBe(FIGURES.ticketPrice);
  });
});

describe('reconciled settlement cannot be un-reconciled by POST', () => {
  beforeEach(() => {
    db().seed('events', EVENT, {
      title: 'Launch Night',
      profitSettlement: dualSignedSettlement({ status: 'reconciled', reconciledAt: 'seed-ts' }),
    });
  });

  it('plain POST with no changes is rejected 409 and the record stays reconciled, byte-identical', async () => {
    const before = eventDoc();
    const res = await post({ id: EVENT });
    expect(res.status).toBe(409);
    expect(eventDoc()).toEqual(before);
    expect(settlement().status).toBe('reconciled');
  });

  it('POST with changed figures is rejected 409 and the record stays reconciled', async () => {
    const before = eventDoc();
    const res = await post({ id: EVENT, ...FIGURES, grossTicketCount: 1 });
    expect(res.status).toBe(409);
    expect(eventDoc()).toEqual(before);
    expect(settlement().status).toBe('reconciled');
  });
});

describe('PATCH reconcile', () => {
  it('reconciles a dual-signed settlement within the cap', async () => {
    db().seed('events', EVENT, { title: 'Launch Night', profitSettlement: dualSignedSettlement() });
    const res = await patch();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, status: 'reconciled' });
  });

  it('recomputes the cap from stored figures instead of trusting a stale stored flag', async () => {
    // Stored flag claims the cap is fine, but 50 complimentary passes
    // against a capacity of 100 exceeds the 10% cap.
    db().seed('events', EVENT, {
      title: 'Launch Night',
      profitSettlement: dualSignedSettlement({
        capacity: 100,
        complimentaryCount: 50,
        complimentaryCapExceeded: false,
      }),
    });
    const res = await patch();
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/cap/i);
  });

  it('still refuses when both sign-offs come from the same person', async () => {
    db().seed('events', EVENT, {
      title: 'Launch Night',
      profitSettlement: dualSignedSettlement({
        treasurerSignoff: { uid: PRES.uid, email: PRES.email, at: '2026-10-24T00:05:00.000Z', role: 'founder_patron' },
      }),
    });
    const res = await patch();
    expect(res.status).toBe(422);
  });
});
