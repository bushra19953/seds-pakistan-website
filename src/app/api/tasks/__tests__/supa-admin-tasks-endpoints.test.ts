/**
 * @jest-environment node
 *
 * Supa migration (tasks cluster, group 3) — NEW seam-backed endpoints
 * and the batch-route mirror, all with a MOCKED adapter (zero live
 * reads):
 *
 * - GET /api/tasks/by-user  (assigned + created modes)
 * - GET /api/tasks/all      (bounded: default + capped limit)
 * - GET /api/tasks/by-workflow
 * - DELETE /api/tasks/batch (Firestore primary; seam mirror after
 *   commit; mirror failure never fails the request)
 *
 * Flag OFF parity: with no adapter resolved, the three GET endpoints
 * answer 404 and the batch route performs its exact Firestore flow
 * with no mirror call.
 */

const mockVerifyAuthentication = jest.fn();
const mockHasPermission = jest.fn(async () => true);

// ---- fake Firestore admin db -------------------------------------------
const mockBatchDelete = jest.fn();
const mockBatchSet = jest.fn();
const mockBatchCommit = jest.fn(async () => undefined);
const mockBatch = jest.fn(() => ({
  delete: mockBatchDelete,
  set: mockBatchSet,
  commit: mockBatchCommit,
}));
let mockSnapshots: any[] = [];
const mockDb: any = {
  collection: (name: string) => ({
    doc: (id: string) => ({ id, path: `${name}/${id}` }),
    where: () => mockDb.__chain,
    orderBy: () => mockDb.__chain,
    limit: () => mockDb.__chain,
  }),
  __chain: null as any,
  getAll: async (...refs: any[]) => mockSnapshots,
  batch: mockBatch,
};
mockDb.__chain = {
  where: () => mockDb.__chain,
  orderBy: () => mockDb.__chain,
  limit: () => mockDb.__chain,
  get: async () => ({ docs: [] }),
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDb,
  admin: { firestore: { FieldValue: { increment: (n: number) => ({ __increment: n }) } } },
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: (...args: any[]) => mockVerifyAuthentication(...args),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: (...args: any[]) => mockHasPermission(...args),
}));

import { GET as byUserGET } from '@/app/api/tasks/by-user/route';
import { GET as allGET } from '@/app/api/tasks/all/route';
import { GET as byWorkflowGET } from '@/app/api/tasks/by-workflow/route';
import { DELETE as batchDELETE } from '@/app/api/tasks/batch/route';
import {
  __setAdminTasksSupaAdapterForTests,
  __resetAdminTasksSupaAdapterForTests,
  type AdminTasksSupaAdapter,
} from '@/lib/supa/seam-admin-tasks';

function req(url: string, body?: any): any {
  return {
    url,
    json: async () => body ?? {},
    headers: new Headers(),
  };
}

function makeAdapter(overrides: Partial<AdminTasksSupaAdapter> = {}): AdminTasksSupaAdapter {
  return {
    getDoc: jest.fn(async () => null),
    listDocs: jest.fn(async () => []),
    countDocs: jest.fn(async () => 0),
    setDoc: jest.fn(async () => ({})),
    updateDoc: jest.fn(async () => ({})),
    deleteDoc: jest.fn(async () => undefined),
    ...overrides,
  } as AdminTasksSupaAdapter;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSnapshots = [];
  mockVerifyAuthentication.mockResolvedValue({
    authenticated: true,
    user: { user: { uid: 'admin-1', permissions: { manageTasks: true } } },
  });
});

afterEach(() => {
  __resetAdminTasksSupaAdapterForTests();
});

describe('flag OFF parity', () => {
  beforeEach(() => __setAdminTasksSupaAdapterForTests(null));

  it('by-user answers 404', async () => {
    const res = await byUserGET(req('http://x/api/tasks/by-user?userId=u1'));
    expect(res.status).toBe(404);
  });

  it('all answers 404', async () => {
    const res = await allGET(req('http://x/api/tasks/all'));
    expect(res.status).toBe(404);
  });

  it('by-workflow answers 404', async () => {
    const res = await byWorkflowGET(req('http://x/api/tasks/by-workflow?workflowId=w1'));
    expect(res.status).toBe(404);
  });

  it('batch DELETE performs the Firestore flow with no mirror', async () => {
    mockSnapshots = [
      { id: 't1', exists: true, ref: { id: 't1' }, data: () => ({ assigneeId: 'u1', status: 'completed' }) },
      { id: 't2', exists: false, ref: { id: 't2' }, data: () => undefined },
    ];
    const res = await batchDELETE(req('http://x/api/tasks/batch', { taskIds: ['t1', 't2'] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, deletedCount: 1 });
    expect(mockBatchDelete).toHaveBeenCalledTimes(1);
    expect(mockBatchSet).toHaveBeenCalledTimes(1); // u1 counter decrement
    expect(mockBatchCommit).toHaveBeenCalledTimes(1);
  });
});

describe('flag ON with mocked adapter', () => {
  it('by-user assigned unions both queries and dedupes', async () => {
    const adapter = makeAdapter({
      listDocs: jest.fn(async (_c: string, opts: any) => {
        const field = opts?.where?.[0]?.[0];
        if (field === 'assigneeId') return [{ id: 't1', title: 'A' }, { id: 't2', title: 'B' }];
        if (field === 'assigneeIds') return [{ id: 't2', title: 'B' }, { id: 't3', title: 'C' }];
        return [];
      }),
    });
    __setAdminTasksSupaAdapterForTests(adapter);
    const res = await byUserGET(req('http://x/api/tasks/by-user?userId=u1&mode=assigned'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tasks.map((t: any) => t.id)).toEqual(['t1', 't2', 't3']);
  });

  it('by-user created queries assignerId and normalizes ISO timestamps', async () => {
    const adapter = makeAdapter({
      listDocs: jest.fn(async () => [
        { id: 't9', title: 'Mine', createdAt: '2026-10-25T05:00:00.000Z' },
      ]),
    });
    __setAdminTasksSupaAdapterForTests(adapter);
    const res = await byUserGET(req('http://x/api/tasks/by-user?userId=u1&mode=created'));
    const json = await res.json();
    expect(json.tasks).toHaveLength(1);
    // SeamTimestamp serializes back to the same ISO string.
    expect(json.tasks[0].createdAt).toBe('2026-10-25T05:00:00.000Z');
    expect((adapter.listDocs as jest.Mock).mock.calls[0][1].where).toEqual([['assignerId', '==', 'u1']]);
  });

  it('by-user requires userId', async () => {
    __setAdminTasksSupaAdapterForTests(makeAdapter());
    const res = await byUserGET(req('http://x/api/tasks/by-user'));
    expect(res.status).toBe(400);
  });

  it('all forwards the default limit (500) and caps at 2000', async () => {
    const adapter = makeAdapter({ listDocs: jest.fn(async () => [{ id: 't1' }]) });
    __setAdminTasksSupaAdapterForTests(adapter);

    const res1 = await allGET(req('http://x/api/tasks/all'));
    const json1 = await res1.json();
    expect(json1.limit).toBe(500);
    expect((adapter.listDocs as jest.Mock).mock.calls[0][1].limit).toBe(500);

    const res2 = await allGET(req('http://x/api/tasks/all?limit=99999'));
    const json2 = await res2.json();
    expect(json2.limit).toBe(2000);
  });

  it('by-workflow queries workflowId with sequenceIndex order', async () => {
    const adapter = makeAdapter({
      listDocs: jest.fn(async () => [{ id: 's1', sequenceIndex: 0 }, { id: 's2', sequenceIndex: 1 }]),
    });
    __setAdminTasksSupaAdapterForTests(adapter);
    const res = await byWorkflowGET(req('http://x/api/tasks/by-workflow?workflowId=w1'));
    const json = await res.json();
    expect(json.tasks.map((t: any) => t.id)).toEqual(['s1', 's2']);
    const opts = (adapter.listDocs as jest.Mock).mock.calls[0][1];
    expect(opts.where).toEqual([['workflowId', '==', 'w1']]);
    expect(opts.orderBy).toEqual(['sequenceIndex', 'asc']);
  });

  it('batch DELETE mirrors deletes + counter decrements after commit', async () => {
    const adapter = makeAdapter({
      getDoc: jest.fn(async () => ({ id: 'u1', tasksAssignedCount: 5, tasksCompletedCount: 3 })),
    });
    __setAdminTasksSupaAdapterForTests(adapter);
    mockSnapshots = [
      { id: 't1', exists: true, ref: { id: 't1' }, data: () => ({ assigneeId: 'u1', status: 'completed' }) },
    ];
    const res = await batchDELETE(req('http://x/api/tasks/batch', { taskIds: ['t1'] }));
    expect(res.status).toBe(200);
    expect(mockBatchCommit).toHaveBeenCalledTimes(1);
    expect(adapter.deleteDoc).toHaveBeenCalledWith('tasks', 't1');
    expect(adapter.updateDoc).toHaveBeenCalledWith('users', 'u1', {
      tasksAssignedCount: 4,
      tasksCompletedCount: 2,
    });
  });

  it('batch mirror failure never fails the request', async () => {
    const adapter = makeAdapter({
      deleteDoc: jest.fn(async () => { throw new Error('supa down'); }),
      getDoc: jest.fn(async () => { throw new Error('supa down'); }),
    });
    __setAdminTasksSupaAdapterForTests(adapter);
    mockSnapshots = [
      { id: 't1', exists: true, ref: { id: 't1' }, data: () => ({ assigneeId: 'u1', status: 'pending' }) },
    ];
    const res = await batchDELETE(req('http://x/api/tasks/batch', { taskIds: ['t1'] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, deletedCount: 1 });
  });

  it('unauthenticated requests are rejected when flag is ON', async () => {
    __setAdminTasksSupaAdapterForTests(makeAdapter());
    mockVerifyAuthentication.mockResolvedValue({ authenticated: false, error: 'nope' });
    const res = await byUserGET(req('http://x/api/tasks/by-user?userId=u1'));
    expect(res.status).toBe(401);
  });
});
