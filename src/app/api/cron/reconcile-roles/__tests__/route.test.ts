/**
 * @jest-environment node
 *
 * RP-01: POST/GET /api/cron/reconcile-roles manual arm auth.
 *
 * The manual arm is NOT "any authenticated caller": reconciliation reads
 * every roles/users/roleHistory document (~440+ reads per run), so an
 * unauthenticated caller gets 401, an authenticated caller without
 * canManageRoles gets 403, and reconciliation never runs in either case.
 * A privileged manual run stamps the caller's uid as actorUid; the
 * CRON_SECRET scheduled arm runs with no actorUid (library default).
 * The reconciliation module itself is mocked; its behaviour is covered
 * by the server reconciliation suites.
 */

import { NextRequest } from 'next/server';

const state = {
  authResult: { authenticated: false } as any,
  canManageRoles: false,
  reconcileCalls: [] as any[],
  permissionCalls: [] as any[],
  storedDocs: [] as any[],
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() => ({
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        set: jest.fn(async (data: any) => {
          state.storedDocs.push(data);
        }),
      })),
    })),
  })),
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

jest.mock('@/lib/server/role-reconciliation', () => ({
  reconcileRoles: jest.fn(async (_db: any, options: any) => {
    state.reconcileCalls.push(options);
    return { generatedAt: '2026-10-24T00:00:00.000Z', mode: options?.mode ?? 'report', divergences: [] };
  }),
}));

import { GET, POST } from '../route';

const TEST_SECRET = 'test-cron-secret';

function req(method: string, headers: Record<string, string> = {}, body?: string) {
  return new NextRequest('http://localhost/api/cron/reconcile-roles', {
    method,
    headers,
    body,
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = TEST_SECRET;
  state.authResult = { authenticated: false };
  state.canManageRoles = false;
  state.reconcileCalls = [];
  state.permissionCalls = [];
  state.storedDocs = [];
});

describe('/api/cron/reconcile-roles (RP-01 manual arm)', () => {
  it('unauthenticated caller gets 401 and reconciliation never runs', async () => {
    const res = await POST(req('POST'));
    expect(res.status).toBe(401);
    expect(state.reconcileCalls).toHaveLength(0);
  });

  it('authenticated caller without canManageRoles gets 403 and reconciliation never runs', async () => {
    state.authResult = { authenticated: true, user: { userId: 'uid-member', role: 'member' } };
    state.canManageRoles = false;
    const res = await POST(req('POST'));
    expect(res.status).toBe(403);
    expect(state.permissionCalls[0]?.[1]).toBe('canManageRoles');
    expect(state.reconcileCalls).toHaveLength(0);
  });

  it('privileged manual caller runs reconciliation with their uid stamped as actorUid', async () => {
    state.authResult = { authenticated: true, user: { userId: 'uid-admin', role: 'founder_patron' } };
    state.canManageRoles = true;
    const res = await POST(req('POST'));
    expect(res.status).toBe(200);
    expect(state.reconcileCalls).toHaveLength(1);
    expect(state.reconcileCalls[0]).toMatchObject({ mode: 'report', actorUid: 'uid-admin' });
    expect(state.storedDocs[0]).toMatchObject({ actorUid: 'uid-admin' });
  });

  it('CRON_SECRET bearer runs with no actorUid (scheduled arm unchanged)', async () => {
    const res = await GET(req('GET', { authorization: `Bearer ${TEST_SECRET}` }));
    expect(res.status).toBe(200);
    expect(state.reconcileCalls).toHaveLength(1);
    expect(state.reconcileCalls[0]).not.toHaveProperty('actorUid');
    expect(state.storedDocs[0]).not.toHaveProperty('actorUid');
  });

  it('a wrong cron secret with no session still gets 401', async () => {
    const res = await GET(req('GET', { authorization: 'Bearer wrong-secret' }));
    expect(res.status).toBe(401);
    expect(state.reconcileCalls).toHaveLength(0);
  });

  it('repair mode still requires the privileged manual arm', async () => {
    state.authResult = { authenticated: true, user: { userId: 'uid-admin', role: 'founder_patron' } };
    state.canManageRoles = true;
    const res = await POST(
      req('POST', { 'content-type': 'application/json' }, JSON.stringify({ mode: 'repair' })),
    );
    expect(res.status).toBe(200);
    expect(state.reconcileCalls[0]).toMatchObject({ mode: 'repair', actorUid: 'uid-admin' });
  });
});
