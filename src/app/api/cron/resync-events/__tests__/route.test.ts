/**
 * @jest-environment node
 *
 * POST/GET /api/cron/resync-events (events mirror-staleness fix):
 *  - cron bearer OR a signed-in caller with canManageEvents;
 *    unauthenticated -> 401, authenticated without permission ->
 *    403, and the resync never runs in either case;
 *  - the DEFAULT mode is dry-run (report only, the resync lib is
 *    the only writer and it writes nothing in dry-run);
 *  - repair requires the explicit body field mode: 'repair';
 *  - adapter unavailable (events surface off) -> 503.
 */

let cronOk = false;
let authed = true;
let permitted = true;
let resyncResult: any = { mode: 'dry-run', totalSource: 0, totalMirror: 0, inSync: [], drifted: [], missing: [], orphans: [], applied: [] };
const resyncCalls: Array<{ mode: string }> = [];

jest.mock('@/lib/server/cron-auth', () => ({
  isCronRequest: () => cronOk,
}));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () =>
    authed
      ? { authenticated: true, user: { userId: 'admin-1' } }
      : { authenticated: false, user: null },
}));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: async () => permitted,
}));
jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({}),
}));
jest.mock('@/lib/supa-events/resync-events', () => ({
  runEventsResync: async (_db: unknown, mode: string) => {
    resyncCalls.push({ mode });
    return resyncResult ? { ...resyncResult, mode } : null;
  },
}));

import { GET, POST } from '../route';
import { NextRequest } from 'next/server';

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/cron/resync-events', {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe('/api/cron/resync-events', () => {
  beforeEach(() => {
    cronOk = false;
    authed = true;
    permitted = true;
    resyncCalls.length = 0;
    resyncResult = { mode: 'dry-run', totalSource: 0, totalMirror: 0, inSync: [], drifted: [], missing: [], orphans: [], applied: [] };
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

  it('POST without a mode field stays dry-run', async () => {
    const res = await POST(req('POST', {}));
    expect(res.status).toBe(200);
    expect(resyncCalls).toEqual([{ mode: 'dry-run' }]);
  });

  it("POST with mode 'repair' runs repair", async () => {
    const res = await POST(req('POST', { mode: 'repair' }));
    expect(res.status).toBe(200);
    expect(resyncCalls).toEqual([{ mode: 'repair' }]);
  });

  it('unauthenticated non-cron caller -> 401, resync never runs', async () => {
    authed = false;
    const res = await GET(req('GET'));
    expect(res.status).toBe(401);
    expect(resyncCalls).toEqual([]);
  });

  it('authenticated without canManageEvents -> 403, resync never runs', async () => {
    permitted = false;
    const res = await POST(req('POST', { mode: 'repair' }));
    expect(res.status).toBe(403);
    expect(resyncCalls).toEqual([]);
  });

  it('adapter unavailable -> 503', async () => {
    resyncResult = null;
    const res = await GET(req('GET'));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('supa_unavailable');
  });
});
