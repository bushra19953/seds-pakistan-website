/**
 * @jest-environment node
 *
 * Supabase-migration CONTRACT tests for GET/POST /api/cron/governance.
 *
 * Pins CURRENT behaviour of the unmodified route. The route is a pure
 * dispatcher: it performs no data access of its own and delegates to
 * runGovernanceCron(db, now, { dryRun }). All collaborators are mocked;
 * zero live reads.
 */

import { NextRequest } from 'next/server';

const state = {
  authResult: { authenticated: false } as any,
  adminInit: true,
  db: { __sentinel: 'governance-db' } as any,
  summary: {
    actions: { stampDeemedRatifications: { deemed: 2 } },
    dryRun: false,
    registrySize: 5,
  } as any,
  cronError: null as any,
};

const mockCron = jest.fn(async (..._args: any[]) => {
  if (state.cronError) throw state.cronError;
  return state.summary;
});

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => state.adminInit),
  getDb: jest.fn(() => state.db),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

jest.mock('@/lib/server/lifecycle-cron', () => ({
  runGovernanceCron: (...args: any[]) => mockCron(...args),
}));

import { GET, POST } from '../route';

const SECRET = 'test-cron-secret';

function req(url: string, headers: Record<string, string> = {}, method = 'GET', body?: string) {
  return new NextRequest(url, { method, headers, body });
}

const URL = 'http://localhost/api/cron/governance';

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  state.authResult = { authenticated: false };
  state.adminInit = true;
  state.db = { __sentinel: 'governance-db' };
  state.cronError = null;
});

afterAll(() => {
  delete process.env.CRON_SECRET;
});

describe('/api/cron/governance — migration contract', () => {
  it('unauthenticated caller gets 401 and the cron never runs', async () => {
    const res = await GET(req(URL));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mockCron).not.toHaveBeenCalled();
  });

  it('authenticated caller WITHOUT a role gets 401 (route requires auth.user.role)', async () => {
    state.authResult = { authenticated: true, user: { userId: 'u-1' } };
    const res = await GET(req(URL));
    expect(res.status).toBe(401);
    expect(mockCron).not.toHaveBeenCalled();
  });

  // SECURITY FLAG (current behaviour, pinned not fixed): beyond the
  // presence of SOME role, the manual arm performs NO permission check
  // (hasServerPermission is never imported by this route). Any
  // authenticated account with any role string — e.g. a plain member —
  // can trigger the full governance cron, including a non-dry run.
  it('SECURITY FLAG: any authenticated caller with any role (incl. plain member) runs the cron', async () => {
    state.authResult = { authenticated: true, user: { userId: 'u-member', role: 'member' } };
    const res = await GET(req(URL));
    expect(res.status).toBe(200);
    expect(mockCron).toHaveBeenCalledTimes(1);
  });

  it('CRON_SECRET bearer runs with { dryRun: false } by default and delegates (db, Date, opts)', async () => {
    const res = await GET(req(URL, { Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...state.summary });
    expect(mockCron).toHaveBeenCalledTimes(1);
    const [dbArg, dateArg, optsArg] = mockCron.mock.calls[0] as any[];
    expect(dbArg).toBe(state.db);
    expect(dateArg).toBeInstanceOf(Date);
    expect(optsArg).toEqual({ dryRun: false });
  });

  it('GET ?dryRun=1 delegates with { dryRun: true }', async () => {
    const res = await GET(req(`${URL}?dryRun=1`, { Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect((mockCron.mock.calls[0] as any[])[2]).toEqual({ dryRun: true });
  });

  it('GET ?dryRun=0 does NOT count as a dry run', async () => {
    await GET(req(`${URL}?dryRun=0`, { Authorization: `Bearer ${SECRET}` }));
    expect((mockCron.mock.calls[0] as any[])[2]).toEqual({ dryRun: false });
  });

  it('POST body { dryRun: true } delegates with { dryRun: true }', async () => {
    const res = await POST(
      req(URL, { Authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }, 'POST', JSON.stringify({ dryRun: true })),
    );
    expect(res.status).toBe(200);
    expect((mockCron.mock.calls[0] as any[])[2]).toEqual({ dryRun: true });
  });

  it('POST with an invalid JSON body is a plain run, not an error ({ dryRun: false })', async () => {
    const res = await POST(
      req(URL, { Authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }, 'POST', '{not-json'),
    );
    expect(res.status).toBe(200);
    expect((mockCron.mock.calls[0] as any[])[2]).toEqual({ dryRun: false });
  });

  it('admin not initialized -> 500 { error: "Firebase Admin not initialized" }, cron never runs', async () => {
    state.adminInit = false;
    const res = await GET(req(URL, { Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Firebase Admin not initialized' });
    expect(mockCron).not.toHaveBeenCalled();
  });

  it('db unavailable -> 500 { error: "Firestore not initialized" }, cron never runs', async () => {
    state.db = null;
    const res = await GET(req(URL, { Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Firestore not initialized' });
    expect(mockCron).not.toHaveBeenCalled();
  });

  it('engine throwing an Error -> 500 { error: <message> }', async () => {
    state.cronError = new Error('lifecycle engine died');
    const res = await GET(req(URL, { Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'lifecycle engine died' });
  });

  it('engine throwing a non-Error -> 500 { error: "Governance cron failed" }', async () => {
    state.cronError = 'string failure';
    const res = await GET(req(URL, { Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Governance cron failed' });
  });
});
