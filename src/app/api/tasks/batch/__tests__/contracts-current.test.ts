/**
 * @jest-environment node
 *
 * BEHAVIOR CONTRACTS — tasks cluster, group 3 surface (batch):
 * DELETE /api/tasks/batch, recorded from the CURRENT Firestore
 * implementation at feat/integration-wave3 @ 4d5a1e16, ahead of
 * feat/supa-tasks-3 (seam-admin-tasks; batch mirror-on-write behind
 * useSupa('tasks'), default OFF). Contracts:
 *   C-BATCH-01  No canManageTasks -> 403 { error:'Forbidden:
 *               insufficient privileges' }; unauthenticated -> 401.
 *   C-BATCH-02  Body validation: taskIds not a non-empty array ->
 *               400 { error:'Invalid request: taskIds must be an
 *               array' }; more than 500 ids -> 400 { error:'Batch
 *               size limit exceeded (max 500)' }.
 *   C-BATCH-03  Success: 200 { ok:true, deletedCount } where
 *               deletedCount counts only EXISTING docs (missing ids
 *               are skipped silently); exactly one batch commit.
 *   C-BATCH-04  Counter side effects are AGGREGATED per assignee:
 *               users/{uid} set-merge { tasksAssignedCount:
 *               increment(-n) } plus { tasksCompletedCount:
 *               increment(-m) } only for that assignee's completed
 *               tasks in the batch.
 */

const HOLDER = 'holder-1';
const mockForUser = jest.fn();
let mockAuth: any = null;

const store = new Map<string, any>();
const batchOps: any[] = [];
let batchCommits = 0;

const mockDb = {
  collection: (name: string) => {
    if (name === 'roles') return { doc: () => ({ get: async () => ({ exists: true, data: () => ({ role: 'member' }) }) }) };
    if (name === 'tasks') return { doc: (id: string) => ({ id, __ref: `tasks/${id}` }) };
    if (name === 'users') return { doc: (uid: string) => ({ id: uid, __ref: `users/${uid}` }) };
    throw new Error(`unexpected collection: ${name}`);
  },
  getAll: async (...refs: any[]) => refs.map((r: any) => ({
    exists: store.has(r.id),
    data: () => store.get(r.id),
    ref: r,
  })),
  batch: () => ({
    delete: (ref: any) => { batchOps.push({ op: 'delete', ref: ref.__ref }); },
    set: (ref: any, data: any, opts?: any) => { batchOps.push({ op: 'set', ref: ref.__ref, data, opts }); },
    commit: async () => { batchCommits++; },
  }),
};

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number; private payload: any;
    constructor(payload: any, init?: { status?: number }) { this.payload = payload; this.status = init?.status ?? 200; }
    static json(payload: any, init?: { status?: number }) { return new MockNextResponse(payload, init); }
    async json() { return this.payload; }
  }
  return { NextRequest: class {}, NextResponse: MockNextResponse };
});

jest.mock('@/lib/server/firebase-admin', () => ({
  admin: { firestore: { FieldValue: { increment: (n: number) => ({ __fv: 'increment', n }), serverTimestamp: () => ({ __fv: 'serverTimestamp' }) } } },
  getDb: () => mockDb,
}));

jest.mock('@/lib/auth-middleware', () => ({ verifyAuthentication: async () => mockAuth }));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(false),
  hasServerPermissionForUser: (...a: any[]) => mockForUser(...a),
}));

import { DELETE } from '../route';

function makeRequest(body?: any): any {
  const req: any = { json: async () => body ?? {}, url: 'http://localhost/api/tasks/batch', headers: { get: () => null }, cookies: { get: () => undefined } };
  req.clone = () => req;
  return req;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockAuth = { authenticated: true, user: { user: { uid: HOLDER }, userId: HOLDER, role: 'member' } };
  mockForUser.mockResolvedValue(true);
  store.clear(); batchOps.length = 0; batchCommits = 0;
});
afterEach(() => { jest.restoreAllMocks(); });

describe('C-BATCH: DELETE /api/tasks/batch', () => {
  it('C-BATCH-01: 403 without grant; 401 unauthenticated', async () => {
    mockForUser.mockResolvedValue(false);
    const forb: any = await DELETE(makeRequest({ taskIds: ['a'] }));
    expect(forb.status).toBe(403);
    expect(await forb.json()).toEqual({ error: 'Forbidden: insufficient privileges' });
    mockAuth = { authenticated: false, user: null, error: 'Unauthorized' };
    const unauth: any = await DELETE(makeRequest({ taskIds: ['a'] }));
    expect(unauth.status).toBe(401);
  });

  it('C-BATCH-02: body validation 400s', async () => {
    const notArray: any = await DELETE(makeRequest({ taskIds: 'a' }));
    expect(notArray.status).toBe(400);
    expect(await notArray.json()).toEqual({ error: 'Invalid request: taskIds must be an array' });
    const empty: any = await DELETE(makeRequest({ taskIds: [] }));
    expect(empty.status).toBe(400);
    const tooMany: any = await DELETE(makeRequest({ taskIds: Array.from({ length: 501 }, (_, i) => `t-${i}`) }));
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toEqual({ error: 'Batch size limit exceeded (max 500)' });
    expect(batchCommits).toBe(0);
  });

  it('C-BATCH-03/04: deletedCount counts existing only; counters aggregated per assignee in one commit', async () => {
    store.set('t-1', { assigneeId: 'user-a', status: 'completed' });
    store.set('t-2', { assigneeId: 'user-a', status: 'pending' });
    store.set('t-3', { assigneeId: 'user-b', status: 'completed' });
    const res: any = await DELETE(makeRequest({ taskIds: ['t-1', 't-2', 't-3', 'ghost'] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deletedCount: 3 });
    expect(batchCommits).toBe(1);
    expect(batchOps.filter((o) => o.op === 'delete')).toHaveLength(3);
    const sets = Object.fromEntries(batchOps.filter((o) => o.op === 'set').map((o) => [o.ref, o.data]));
    expect(sets['users/user-a'].tasksAssignedCount).toEqual({ __fv: 'increment', n: -2 });
    expect(sets['users/user-a'].tasksCompletedCount).toEqual({ __fv: 'increment', n: -1 });
    expect(sets['users/user-b'].tasksAssignedCount).toEqual({ __fv: 'increment', n: -1 });
    expect(sets['users/user-b'].tasksCompletedCount).toEqual({ __fv: 'increment', n: -1 });
  });
});
