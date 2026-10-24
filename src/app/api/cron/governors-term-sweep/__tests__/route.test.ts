/**
 * @jest-environment node
 *
 * RP-02: POST/GET /api/cron/governors-term-sweep manual arm auth.
 *
 * The sweep materialises governor vacancies and writes history/audit, so
 * the manual arm is NOT "any authenticated caller": unauthenticated gets
 * 401, authenticated without canManageRoles gets 403, and the sweep never
 * runs in either case. A privileged manual run passes the caller's uid
 * as the sweep actor; the CRON_SECRET scheduled arm passes no actor
 * (the sweep keeps its historical 'system' actor). Mirrors the
 * custom-role-expiry-sweep route tests. The sweep module is mocked; its
 * behaviour is covered by the governors server suites.
 */

import { NextRequest } from 'next/server';

const state = {
  authResult: { authenticated: false } as any,
  canManageRoles: false,
  sweepCalls: [] as any[],
  permissionCalls: [] as any[],
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() => ({})),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async (...args: any[]) => {
    state.permissionCalls.push(args);
    return state.canManageRoles;
  }),
}));

jest.mock('@/lib/server/governors/term-sweep', () => ({
  runGovernorTermSweep: jest.fn(async (...args: any[]) => {
    state.sweepCalls.push(args);
    return { reminded: [], expiredMaterialised: [], failures: [] };
  }),
}));

import { GET, POST } from '../route';

const TEST_SECRET = 'test-cron-secret';

function req(method: string, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/cron/governors-term-sweep', {
    method,
    headers,
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = TEST_SECRET;
  state.authResult = { authenticated: false };
  state.canManageRoles = false;
  state.sweepCalls = [];
  state.permissionCalls = [];
});

describe('/api/cron/governors-term-sweep (RP-02 manual arm)', () => {
  it('unauthenticated caller gets 401 and the sweep never runs', async () => {
    const res = await POST(req('POST'));
    expect(res.status).toBe(401);
    expect(state.sweepCalls).toHaveLength(0);
  });

  it('authenticated caller without canManageRoles gets 403 and the sweep never runs', async () => {
    state.authResult = { authenticated: true, user: { userId: 'uid-member', role: 'member' } };
    state.canManageRoles = false;
    const res = await POST(req('POST'));
    expect(res.status).toBe(403);
    expect(state.permissionCalls[0]?.[1]).toBe('canManageRoles');
    expect(state.sweepCalls).toHaveLength(0);
  });

  it('privileged manual caller runs the sweep with their uid as actor', async () => {
    state.authResult = { authenticated: true, user: { userId: 'uid-admin', role: 'founder_patron' } };
    state.canManageRoles = true;
    const res = await POST(req('POST'));
    expect(res.status).toBe(200);
    expect(state.sweepCalls).toHaveLength(1);
    expect(state.sweepCalls[0]?.[2]).toEqual({ actorUid: 'uid-admin' });
  });

  it('CRON_SECRET bearer runs the sweep with no actor option (system actor kept)', async () => {
    const res = await GET(req('GET', { Authorization: `Bearer ${TEST_SECRET}` }));
    expect(res.status).toBe(200);
    expect(state.sweepCalls).toHaveLength(1);
    expect(state.sweepCalls[0]?.[2]).toBeUndefined();
  });

  it('a wrong cron secret with no session still gets 401', async () => {
    const res = await GET(req('GET', { Authorization: 'Bearer wrong-secret' }));
    expect(res.status).toBe(401);
    expect(state.sweepCalls).toHaveLength(0);
  });
});
