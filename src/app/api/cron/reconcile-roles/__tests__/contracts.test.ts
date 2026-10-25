/**
 * @jest-environment node
 *
 * Supabase-migration CONTRACT tests for GET/POST /api/cron/reconcile-roles —
 * companion to the existing route.test.ts in this folder (which pins
 * the RP-01 manual-arm auth: 401 / 403 / actor stamping). This file
 * pins what that suite does not:
 *
 *  - The response body is exactly { ok: true, report } with the report
 *    passed through verbatim.
 *  - The stored-report write set: reconciliation_reports/<YYYY-MM-DD>
 *    (date sliced from report.generatedAt) written with set(..., {
 *    merge: true }) carrying the report, a storedAt Date, and — on
 *    manual runs only — the actorUid.
 *  - Mode normalisation: only the exact string 'repair' repairs;
 *    any other/missing value runs 'report'.
 *  - The db-unavailable 500 and its exact body.
 *
 * The reconciliation engine is mocked; zero live reads.
 */

import { NextRequest } from 'next/server';

const state = {
  authResult: { authenticated: false } as any,
  canManageRoles: false,
  dbAvailable: true,
  report: {
    generatedAt: '2026-10-24T03:04:05.000Z',
    mode: 'report',
    divergences: [{ uid: 'u-1', field: 'role' }],
    totals: { checked: 220, divergent: 1 },
  } as any,
  reconcileCalls: [] as any[],
  setCalls: [] as Array<{ path: string; data: any; opts: any }>,
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() =>
    state.dbAvailable
      ? {
          collection: (name: string) => ({
            doc: (id: string) => ({
              set: async (data: any, opts: any) => {
                state.setCalls.push({ path: `${name}/${id}`, data, opts });
              },
            }),
          }),
        }
      : null,
  ),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async () => state.canManageRoles),
}));

jest.mock('@/lib/server/role-reconciliation', () => ({
  reconcileRoles: jest.fn(async (_db: any, options: any) => {
    state.reconcileCalls.push(options);
    return state.report;
  }),
}));

import { GET, POST } from '../route';

const SECRET = 'test-cron-secret';

function req(method = 'GET', headers: Record<string, string> = {}, body?: string) {
  return new NextRequest('http://localhost/api/cron/reconcile-roles', { method, headers, body });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  state.authResult = { authenticated: false };
  state.canManageRoles = false;
  state.dbAvailable = true;
  state.reconcileCalls = [];
  state.setCalls = [];
});

afterAll(() => {
  delete process.env.CRON_SECRET;
});

describe('/api/cron/reconcile-roles — response + stored-report contract', () => {
  it('cron run: response is exactly { ok: true, report } with the report verbatim', async () => {
    const res = await GET(req('GET', { authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, report: state.report });
  });

  it('cron run: the report is stored at reconciliation_reports/<date> with merge, storedAt Date, and NO actorUid', async () => {
    await GET(req('GET', { authorization: `Bearer ${SECRET}` }));
    expect(state.setCalls).toHaveLength(1);
    const call = state.setCalls[0];
    expect(call.path).toBe('reconciliation_reports/2026-10-24');
    expect(call.opts).toEqual({ merge: true });
    expect(call.data).toMatchObject(state.report);
    expect(call.data.storedAt).toBeInstanceOf(Date);
    expect(call.data).not.toHaveProperty('actorUid');
  });

  it('manual run: stored report and engine options both carry the caller uid as actorUid', async () => {
    state.authResult = { authenticated: true, user: { userId: 'uid-admin', role: 'founder_patron' } };
    state.canManageRoles = true;
    await POST(req('POST'));
    expect(state.reconcileCalls[0]).toEqual({ mode: 'report', actorUid: 'uid-admin' });
    expect(state.setCalls[0].data.actorUid).toBe('uid-admin');
  });

  it('mode normalisation: unknown mode strings run as report; only exact "repair" repairs', async () => {
    state.authResult = { authenticated: true, user: { userId: 'uid-admin', role: 'founder_patron' } };
    state.canManageRoles = true;
    await POST(req('POST', { 'content-type': 'application/json' }, JSON.stringify({ mode: 'REPAIR' })));
    await POST(req('POST', { 'content-type': 'application/json' }, JSON.stringify({ mode: 'repair' })));
    await POST(req('POST', { 'content-type': 'application/json' }, JSON.stringify({})));
    expect(state.reconcileCalls.map((c) => c.mode)).toEqual(['report', 'repair', 'report']);
  });

  it('a non-JSON body is treated as {} (report mode), not an error', async () => {
    const res = await POST(req('POST', { authorization: `Bearer ${SECRET}` }, 'not-json'));
    expect(res.status).toBe(200);
    expect(state.reconcileCalls[0]).toEqual({ mode: 'report' });
  });

  it('db unavailable -> 500 { error: "Database unavailable" }, engine never runs, nothing stored', async () => {
    state.dbAvailable = false;
    const res = await GET(req('GET', { authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Database unavailable' });
    expect(state.reconcileCalls).toHaveLength(0);
    expect(state.setCalls).toHaveLength(0);
  });
});
