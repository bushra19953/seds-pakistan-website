/**
 * @jest-environment node
 *
 * Supabase-migration CONTRACT tests for GET/POST /api/cron/elections-lifecycle.
 *
 * These tests pin CURRENT behaviour of the unmodified route so the
 * Supabase version can be audited against them. All Firestore access is
 * mocked: getDb returns a sentinel object and the sweep service is a
 * jest mock. Zero live reads.
 *
 * Delegation contract: the route has no data access of its own; it calls
 * runElectionLifecycleSweeps(db) exactly once and spreads the result
 * into { ok: true, ...result }.
 */

import { NextRequest } from 'next/server';

const state = {
  authResult: { authenticated: false } as any,
  db: { __sentinel: 'elections-db' } as any,
  sweepResult: {
    nominationsOpened: 1,
    pollsClosed: 2,
    challengesClosed: 0,
    vettingOverdueFlagged: 3,
  } as any,
};

const mockSweeps = jest.fn(async (_db: any) => state.sweepResult);
const mockVerify = jest.fn(async () => state.authResult);

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => state.db),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: (...args: any[]) => mockVerify(...args),
}));

jest.mock('@/lib/server/elections', () => ({
  runElectionLifecycleSweeps: (...args: any[]) => mockSweeps(...args),
}));

import { GET, POST } from '../route';

const SECRET = 'test-cron-secret';

function req(headers: Record<string, string> = {}, method = 'GET') {
  return new NextRequest('http://localhost/api/cron/elections-lifecycle', {
    method,
    headers,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  state.authResult = { authenticated: false };
  state.db = { __sentinel: 'elections-db' };
});

afterAll(() => {
  delete process.env.CRON_SECRET;
});

describe('/api/cron/elections-lifecycle — migration contract', () => {
  it('unauthenticated caller (no bearer, no session) gets 401 and the sweep never runs', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mockSweeps).not.toHaveBeenCalled();
  });

  it('wrong cron bearer with no session gets 401 and the sweep never runs', async () => {
    const res = await GET(req({ authorization: 'Bearer wrong-secret' }));
    expect(res.status).toBe(401);
    expect(mockSweeps).not.toHaveBeenCalled();
  });

  it('CRON_SECRET bearer runs the sweep without any session verification', async () => {
    const res = await GET(req({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockSweeps).toHaveBeenCalledTimes(1);
    expect(mockSweeps).toHaveBeenCalledWith(state.db);
  });

  // SECURITY FLAG (current behaviour, pinned not fixed): the manual arm
  // checks ONLY `auth.authenticated`. There is no role or permission
  // check at all — the mocked auth result below deliberately carries no
  // user and no role, and the sweep still runs. Any signed-in member
  // can trigger the election lifecycle sweeps today.
  it('SECURITY FLAG: any authenticated caller (no role/permission check) runs the sweep', async () => {
    state.authResult = { authenticated: true };
    const res = await POST(req({}, 'POST'));
    expect(res.status).toBe(200);
    expect(mockSweeps).toHaveBeenCalledTimes(1);
  });

  it('happy path response is exactly { ok: true, ...sweepResult }', async () => {
    const res = await GET(req({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...state.sweepResult });
  });

  it('db unavailable -> 500 with the exact misconfiguration body, sweep never runs', async () => {
    state.db = null;
    const res = await GET(req({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'Server misconfiguration: Firestore not available',
    });
    expect(mockSweeps).not.toHaveBeenCalled();
  });

  it('POST delegates identically to GET', async () => {
    const res = await POST(req({ authorization: `Bearer ${SECRET}` }, 'POST'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...state.sweepResult });
    expect(mockSweeps).toHaveBeenCalledTimes(1);
  });
});
