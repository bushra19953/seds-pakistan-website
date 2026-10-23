/**
 * @jest-environment node
 *
 * EXPIRY-CORE (plan section 8C): manual trigger route
 * GET/POST /api/cron/custom-role-expiry-sweep.
 *
 * Auth follows the SEC-08 trigger rule (parent ruling on plan C1,
 * OVERRIDING contracts 5.1's "any authenticated caller"): the route
 * accepts a CRON_SECRET bearer, or an authenticated caller holding
 * canManageRoles. Unauthenticated callers get 401; authenticated
 * callers without canManageRoles get 403; in both cases the sweep
 * never runs. The sweep module itself is mocked with a fixed summary;
 * the sweep's own behaviour is covered by
 * src/lib/server/__tests__/custom-role-expiry-sweep.test.ts.
 */

import { NextRequest } from 'next/server';

const state = {
  authResult: { authenticated: false } as any,
  canManageRoles: false,
  sweepCalls: 0,
};

const SUMMARY = {
  reminded: [{ uid: 'u-1', roleKey: 'custom_poster_team_lead', stage: 't30_sent' }],
  expiredMaterialised: [
    { uid: 'u-2', roleKey: 'custom_poster_team_lead', branch: 'restored_prior' },
  ],
  failures: [],
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => ({})),
  ensureAdminInitialized: jest.fn(() => true),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async () => state.canManageRoles),
}));

jest.mock('@/lib/server/custom-role-expiry-sweep', () => ({
  runCustomRoleExpirySweep: jest.fn(async () => {
    state.sweepCalls++;
    return SUMMARY;
  }),
}));

import { GET, POST } from '../route';

function req(method: string, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/cron/custom-role-expiry-sweep', {
    method,
    headers,
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = 'test-cron-secret';
  state.authResult = { authenticated: false };
  state.canManageRoles = false;
  state.sweepCalls = 0;
});

describe('GET/POST /api/cron/custom-role-expiry-sweep (plan 8C, SEC-08 auth)', () => {
  it('8C.1 no auth header and no session returns 401 and never runs the sweep', async () => {
    const res = await GET(req('GET'));
    expect(res.status).toBe(401);
    expect(state.sweepCalls).toBe(0);
  });

  it('a wrong cron secret with no session returns 401 and never runs the sweep', async () => {
    const res = await GET(
      req('GET', { Authorization: 'Bearer wrong-secret' }),
    );
    expect(res.status).toBe(401);
    expect(state.sweepCalls).toBe(0);
  });

  it('8C.2 a CRON_SECRET bearer returns 200 with the sweep summary in the body', async () => {
    const res = await GET(
      req('GET', { Authorization: 'Bearer test-cron-secret' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.reminded).toEqual(SUMMARY.reminded);
    expect(body.expiredMaterialised).toEqual(SUMMARY.expiredMaterialised);
    expect(body.failures).toEqual(SUMMARY.failures);
    expect(state.sweepCalls).toBe(1);
  });

  it('8C.3 (SEC-08) an authenticated caller WITH canManageRoles returns 200 without the secret', async () => {
    state.authResult = {
      authenticated: true,
      user: { userId: 'admin-1', role: 'president_national' },
    };
    state.canManageRoles = true;
    const res = await POST(req('POST'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.reminded).toEqual(SUMMARY.reminded);
    expect(state.sweepCalls).toBe(1);
  });

  it('8C.4 (SEC-08) an authenticated caller WITHOUT canManageRoles returns 403 and never runs the sweep', async () => {
    state.authResult = {
      authenticated: true,
      user: { userId: 'member-1', role: 'member' },
    };
    state.canManageRoles = false;
    const res = await GET(req('GET'));
    expect(res.status).toBe(403);
    expect(state.sweepCalls).toBe(0);
  });
});
