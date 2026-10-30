/**
 * @jest-environment node
 *
 * wf-4 migration M5: the duplicate route's workflow_members listing.
 * Supa path: uid set comes from the seam (prefix filter + userId /
 * id-suffix extraction) and the Firestore collection .get() is never
 * called; member WRITES still land in the route's Firestore batch.
 * Fallback (seam null): the original full-collection scan runs.
 * All mocked — zero live reads.
 */
const HOLDER = 'holder-1';

const mockList = jest.fn();
jest.mock('@/lib/server/workflow-members-supa', () => {
  const actual = jest.requireActual('@/lib/server/workflow-members-supa');
  return { ...actual, listWorkflowMembersViaSupa: (...a: any[]) => mockList(...a) };
});

const membersGet = jest.fn(async () => ({
  docs: [{ id: 'wf-1_u9', data: () => ({ userId: 'u9' }) }],
}));
// Train 2: the Firestore members fallback is a documentId
// prefix-RANGE query (bounded), not a full-collection .get().
const membersRangeGet = jest.fn(async () => ({
  docs: [{ id: 'wf-1_u9', data: () => ({ userId: 'u9' }) }],
}));
const batchSet = jest.fn();
const batchCommit = jest.fn(async () => undefined);
const mockDb = {
  collection: (name: string) => {
    if (name === 'tasks') {
      const tasksGet = async () => ({
        empty: false,
        docs: [
          {
            ref: { __taskRef: 'src-1' },
            data: () => ({ title: 'Step One', workflowTitle: 'WF', sequenceIndex: 0, status: 'in-progress' }),
          },
        ],
      });
      return {
        where: () => ({
          limit: () => ({ get: tasksGet }),
          get: tasksGet,
        }),
        doc: () => ({ id: 'new-task-1' }),
      };
    }
    if (name === 'workflow_members') {
      const chain: any = {
        where: () => chain,
        limit: () => ({ get: membersRangeGet }),
        get: membersRangeGet,
      };
      return { get: membersGet, where: () => chain, doc: (id: string) => ({ __memberRef: id }) };
    }
    throw new Error(`unexpected ${name}`);
  },
  batch: () => ({ set: batchSet, commit: batchCommit }),
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
  ensureAdminInitialized: () => true,
  getDb: () => mockDb,
  admin: { firestore: { FieldValue: { serverTimestamp: () => ({ __fv: 'ts' }) }, FieldPath: { documentId: () => '__name__' } } },
}));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({
    authenticated: true,
    user: { userId: HOLDER, email: 'h@example.com', displayName: 'H', emailVerified: true, role: 'member' },
  }),
}));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(false),
  hasServerPermissionForUser: jest.fn().mockResolvedValue(true),
}));
jest.mock('@/lib/server/workflow-audit', () => ({ logWorkflowAudit: jest.fn().mockResolvedValue(undefined) }));

import { POST } from '../duplicate/route';

const params = { params: Promise.resolve({ id: 'wf-1' }) };

function memberWriteCalls() {
  return batchSet.mock.calls.filter((c: any[]) => c[0] && typeof c[0] === 'object' && '__memberRef' in c[0]);
}

beforeEach(() => {
  jest.clearAllMocks();
  membersGet.mockClear();
  batchSet.mockClear();
});

it('supa path: members copied from seam ids, Firestore members .get() untouched, writes stay batched', async () => {
  mockList.mockResolvedValue([
    { id: 'wf-1_u1', userId: 'u1' },
    { id: 'wf-1_u2' }, // uid from id suffix
    { id: 'wf-2_zz', userId: 'zz' }, // other workflow: excluded
  ]);
  const res: any = await POST({} as any, params);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(membersGet).not.toHaveBeenCalled();

  const calls = memberWriteCalls();
  const byUid = new Map<string, any>();
  for (const [ref, data] of calls) {
    byUid.set(String(data.userId), { ref: ref.__memberRef as string, data });
  }
  expect([...byUid.keys()].sort()).toEqual([HOLDER, 'u1', 'u2']);
  expect(byUid.get('u1').ref.endsWith('_u1')).toBe(true);
  expect(byUid.get('u1').data.role).toBe('member');
  expect(byUid.get(HOLDER).data.role).toBe('owner');
  expect(byUid.get('u1').data.workflowId).toBe(body.workflowId);
  expect(batchCommit).toHaveBeenCalledTimes(1);
});

it('fallback: seam null -> bounded Firestore prefix-range supplies the uid set (train 2)', async () => {
  // Census 05 #6: the fallback used to be a FULL-collection
  // workflow_members .get(); it is now a documentId prefix-range
  // query capped at 1000, so the collection .get() never runs.
  mockList.mockResolvedValue(null);
  const res: any = await POST({} as any, params);
  expect(res.status).toBe(200);
  expect(membersGet).not.toHaveBeenCalled();
  expect(membersRangeGet).toHaveBeenCalledTimes(1);
  const uids = memberWriteCalls().map((c: any[]) => String(c[1].userId)).sort();
  expect(uids).toEqual([HOLDER, 'u9']);
});
