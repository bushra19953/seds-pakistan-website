/**
 * @jest-environment node
 *
 * Supabase-migration CONTRACT tests for GET/POST
 * /api/cron/custom-role-expiry-sweep — companion to the existing
 * route.test.ts in this folder (which pins the SEC-08 auth arms).
 * This file pins the delegation arguments, the response spread, and
 * the two 500 init/db failure bodies.
 *
 * The sweep engine is mocked; zero live reads.
 */

import { NextRequest } from 'next/server';

const state = {
  authResult: { authenticated: false } as any,
  canManageRoles: false,
  adminInit: true,
  db: { __sentinel: 'crs-db' } as any,
  summary: { reminded: [{ uid: 'u-1' }], expiredMaterialised: [], failures: [] } as any,
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
  hasServerPermission: jest.fn(async () => state.canManageRoles),
}));

jest.mock('@/lib/server/custom-role-expiry-sweep', () => ({
  runCustomRoleExpirySweep: jest.fn(async (...args: any[]) => {
    state.sweepCalls.push(args);
    return state.summary;
  }),
}));

import { GET, POST } from '../route';

const SECRET = 'test-cron-secret';

function req(method = 'GET', headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/cron/custom-role-expiry-sweep', { method, headers });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  state.authResult = { authenticated: false };
  state.canManageRoles = false;
  state.adminInit = true;
  state.db = { __sentinel: 'crs-db' };
  state.sweepCalls = [];
});

afterAll(() => {
  delete process.env.CRON_SECRET;
});

describe('/api/cron/custom-role-expiry-sweep — delegation + failure contract', () => {
  it('cron run: delegates exactly (db, Date) and responds { ok: true, ...summary }', async () => {
    const res = await GET(req('GET', { Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...state.summary });
    expect(state.sweepCalls).toHaveLength(1);
    expect(state.sweepCalls[0]).toHaveLength(2);
    expect(state.sweepCalls[0][0]).toBe(state.db);
    expect(state.sweepCalls[0][1]).toBeInstanceOf(Date);
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
    const res = await POST(req('POST', { Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Firestore not initialized' });
    expect(state.sweepCalls).toHaveLength(0);
  });
});
