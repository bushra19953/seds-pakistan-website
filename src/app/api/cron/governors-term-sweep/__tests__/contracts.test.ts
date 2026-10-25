/**
 * @jest-environment node
 *
 * Supabase-migration CONTRACT tests for GET/POST
 * /api/cron/governors-term-sweep — companion to the existing
 * route.test.ts in this folder (which pins the RP-02 manual-arm auth).
 * This file pins the delegation arguments, the response spread, and
 * the two 500 init/db failure bodies.
 *
 * The sweep engine is mocked; zero live reads.
 */

import { NextRequest } from 'next/server';

const state = {
  authResult: { authenticated: false } as any,
  adminInit: true,
  db: { __sentinel: 'sweep-db' } as any,
  summary: { expiredMaterialised: [{ seatId: 'seat-1' }], reminded: [], failures: [] } as any,
  sweepCalls: [] as any[],
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => state.adminInit),
  getDb: jest.fn(() => state.db),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async () => true),
}));

jest.mock('@/lib/server/governors/term-sweep', () => ({
  runGovernorTermSweep: jest.fn(async (...args: any[]) => {
    state.sweepCalls.push(args);
    return state.summary;
  }),
}));

import { GET, POST } from '../route';

const SECRET = 'test-cron-secret';

function req(method = 'GET', headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/cron/governors-term-sweep', { method, headers });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  state.authResult = { authenticated: false };
  state.adminInit = true;
  state.db = { __sentinel: 'sweep-db' };
  state.sweepCalls = [];
});

afterAll(() => {
  delete process.env.CRON_SECRET;
});

describe('/api/cron/governors-term-sweep — delegation + failure contract', () => {
  it('cron run: delegates (db, Date, undefined) and responds { ok: true, ...summary }', async () => {
    const res = await GET(req('GET', { Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...state.summary });
    expect(state.sweepCalls).toHaveLength(1);
    const [dbArg, dateArg, optsArg] = state.sweepCalls[0];
    expect(dbArg).toBe(state.db);
    expect(dateArg).toBeInstanceOf(Date);
    expect(optsArg).toBeUndefined();
  });

  it('manual privileged run: delegates with { actorUid } as the third argument', async () => {
    state.authResult = { authenticated: true, user: { userId: 'uid-admin', role: 'founder_patron' } };
    const res = await POST(req('POST'));
    expect(res.status).toBe(200);
    expect(state.sweepCalls[0][2]).toEqual({ actorUid: 'uid-admin' });
  });

  it('admin not initialized -> 500 { error: "Firebase Admin not initialized" }, sweep never runs', async () => {
    state.adminInit = false;
    const res = await GET(req('GET', { Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Firebase Admin not initialized' });
    expect(state.sweepCalls).toHaveLength(0);
  });

  it('db unavailable -> 500 { error: "Firestore not initialized" }, sweep never runs', async () => {
    state.db = null;
    const res = await GET(req('GET', { Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Firestore not initialized' });
    expect(state.sweepCalls).toHaveLength(0);
  });
});
