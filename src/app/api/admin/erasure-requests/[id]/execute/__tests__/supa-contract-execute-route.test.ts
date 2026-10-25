/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION CONTRACT — COMPLIANCE/DISCIPLINE, cluster 6
 * (route half).
 *
 * POST /api/admin/erasure-requests/[id]/execute
 * (src/app/api/admin/erasure-requests/[id]/execute/route.ts) is the
 * ONLY path that deletes a Firebase Auth account. Pinned behaviour:
 *  - unauthenticated -> 401 {error:'Unauthorized'}, nothing executes;
 *  - authenticated without canManageUsers -> 403 {error:'Forbidden'},
 *    nothing executes;
 *  - executor failures (e.g. cooling-off not ended, request not in
 *    cooling_off) surface as 400 with the executor's message;
 *  - success -> 200 {success:true, uid, pseudonym} from the REAL
 *    executeErasure (only the deps wiring is stubbed, over an
 *    in-memory Firestore — the gate parity companion lives in
 *    route-parity.test.ts in this folder).
 */

const state = {
  authResult: null as any,
  allowed: true,
  db: null as any,
  authDeletes: [] as string[],
  audits: [] as Array<Record<string, unknown>>,
  clock: new Date('2026-10-20T00:00:00.000Z'),
};

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));
jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({}),
}));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => state.allowed),
}));
jest.mock('@/lib/retention/server-deps', () => ({
  createErasureDeps: jest.fn(() => ({
    db: state.db,
    deleteAuthUser: async (uid: string) => { state.authDeletes.push(uid); },
    writeAudit: async (entry: Record<string, unknown>) => { state.audits.push(entry); },
    now: () => state.clock,
  })),
}));

import { NextRequest } from 'next/server';
import { FakeFirestore } from '@/lib/governance/__tests__/fake-firestore';
import { pseudonymFor } from '@/lib/retention/erasure';
import { POST } from '../route';

function authFor(uid: string) {
  return { authenticated: true, user: { userId: uid, role: 'superadmin' } };
}

function seedWorld(executeAfter: string) {
  const db = new FakeFirestore();
  db.seed('users', 'u-erase', { displayName: 'Leaving', email: 'l@example.com', memberStatus: 'active' });
  db.seed('erasure_requests', 'req-1', {
    uid: 'u-erase', status: 'cooling_off', reason: null,
    requestedAt: '2026-10-01T00:00:00.000Z', executeAfter, executedAt: null, executedBy: null,
  });
  state.db = db;
  return db;
}

function req() {
  return new NextRequest('http://localhost/api/admin/erasure-requests/req-1/execute', { method: 'POST' });
}
const ctx = { params: { id: 'req-1' } };
const PAST = '2026-10-15T00:00:00.000Z';
const FUTURE = '2026-11-01T00:00:00.000Z';

beforeEach(() => {
  jest.clearAllMocks();
  state.authResult = authFor('admin-1');
  state.allowed = true;
  state.authDeletes = [];
  state.audits = [];
});

describe('CONTRACT 6d: erasure execute route gates', () => {
  it('unauthenticated -> 401 and nothing executes', async () => {
    const db = seedWorld(PAST);
    state.authResult = { authenticated: false };
    const res = await POST(req(), ctx);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(state.authDeletes).toHaveLength(0);
    expect(db.getDoc('erasure_requests', 'req-1')?.status).toBe('cooling_off');
    expect(db.getDoc('users', 'u-erase')?.memberStatus).toBe('active');
  });

  it('authenticated without canManageUsers -> 403 Forbidden and nothing executes', async () => {
    const db = seedWorld(PAST);
    state.allowed = false;
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(state.authDeletes).toHaveLength(0);
    expect(db.getDoc('erasure_requests', 'req-1')?.status).toBe('cooling_off');
  });

  it('cooling-off not ended -> 400 with the executor message, nothing deleted', async () => {
    const db = seedWorld(FUTURE);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Cooling-off period has not ended/);
    expect(state.authDeletes).toHaveLength(0);
    expect(db.getDoc('users', 'u-erase')?.memberStatus).toBe('active');
  });

  it('permitted + cooled-off -> 200 {success, uid, pseudonym} and the request is executed by the caller', async () => {
    const db = seedWorld(PAST);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, uid: 'u-erase', pseudonym: pseudonymFor('u-erase') });
    const done = db.getDoc('erasure_requests', 'req-1');
    expect(done?.status).toBe('executed');
    expect(done?.executedBy).toBe('admin-1');
    expect(state.authDeletes).toEqual(['u-erase']);
  });
});
