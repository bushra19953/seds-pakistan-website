/**
 * @jest-environment node
 *
 * GET/POST /api/cron/resync-consents (consents mirror guard):
 *  - cron bearer OR a signed-in Founder; unauthenticated -> 401,
 *    authenticated non-founder -> 403, resync never runs either way;
 *  - the DEFAULT mode is dry-run (report only);
 *  - repair requires the explicit body field mode: 'repair';
 *  - adapter unavailable (consents surface off) -> 503.
 * Modeled on the resync-applications route test.
 */

let cronOk = false;
let authed = true;
let userId = 'founder-uid';
let resyncResult: any = {
  mode: 'dry-run', overBudget: false, firestoreCount: 0, supaCount: 0,
  missingIds: [], repairedIds: [], unhealableIds: [], orphanIds: [], readsUsed: 0,
};
const resyncCalls: Array<{ mode: string }> = [];

jest.mock('@/lib/server/cron-auth', () => ({
  isCronRequest: () => cronOk,
}));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () =>
    authed
      ? { authenticated: true, user: { userId } }
      : { authenticated: false, user: null },
}));
jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({}),
}));
jest.mock('@/lib/roles', () => ({
  FOUNDER_UID: 'founder-uid',
}));
jest.mock('@/lib/consents-resync', () => ({
  runConsentsResync: async (_db: unknown, mode: string) => {
    resyncCalls.push({ mode });
    return resyncResult ? { ...resyncResult, mode } : null;
  },
}));

import { GET, POST } from '../route';
import { NextRequest } from 'next/server';

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/cron/resync-consents', {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe('/api/cron/resync-consents', () => {
  beforeEach(() => {
    cronOk = false;
    authed = true;
    userId = 'founder-uid';
    resyncCalls.length = 0;
    resyncResult = {
      mode: 'dry-run', overBudget: false, firestoreCount: 0, supaCount: 0,
      missingIds: [], repairedIds: [], unhealableIds: [], orphanIds: [], readsUsed: 0,
    };
  });

  it('cron caller: GET runs a dry-run and returns the report', async () => {
    cronOk = true;
    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.report.mode).toBe('dry-run');
    expect(resyncCalls).toEqual([{ mode: 'dry-run' }]);
  });

  it('founder caller: POST with mode repair runs a repair', async () => {
    const res = await POST(req('POST', { mode: 'repair' }));
    expect(res.status).toBe(200);
    expect(resyncCalls).toEqual([{ mode: 'repair' }]);
  });

  it('POST without a mode field stays dry-run', async () => {
    const res = await POST(req('POST', {}));
    expect(res.status).toBe(200);
    expect(resyncCalls).toEqual([{ mode: 'dry-run' }]);
  });

  it('unauthenticated -> 401 and the resync never runs', async () => {
    authed = false;
    const res = await GET(req('GET'));
    expect(res.status).toBe(401);
    expect(resyncCalls).toHaveLength(0);
  });

  it('authenticated non-founder -> 403 and the resync never runs', async () => {
    userId = 'someone-else';
    const res = await GET(req('GET'));
    expect(res.status).toBe(403);
    expect(resyncCalls).toHaveLength(0);
  });

  it('adapter unavailable -> 503', async () => {
    cronOk = true;
    resyncResult = null;
    const res = await GET(req('GET'));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe('supa_unavailable');
  });
});
