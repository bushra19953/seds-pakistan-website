/**
 * @jest-environment node
 *
 * Deadline fairness for PATCH /api/admin/universal-review (founder
 * rule, 2026-10-26): rejecting a TASK SUBMISSION from the Universal
 * Inbox is a return from review, so it must carry a NEW deadline set
 * by the reviewer, and it lands on the canonical return status
 * 'changes-requested' (never the legacy foreign status 'rejected',
 * which stranded the assignee with no resubmit path, TS-P16).
 *
 * - reject of a submitted-for-review task WITHOUT reviewDeadline:
 *   the task is NOT decided; it is reported in failedTaskRejects and
 *   stays in review. (Fails on the pre-fix route, which rejected it
 *   into its already-passed deadline.)
 * - reject WITH a future reviewDeadline: status changes-requested,
 *   the new date is written into the effective deadline field, and
 *   feedback_history records the return with the new deadline.
 * - reject of a task carrying NO submission keeps legacy behavior
 *   (status 'rejected', no deadline needed).
 *
 * Harness follows universal-review-points-idempotency.test.ts: the
 * real PATCH runs against a mocked Firestore whose batch commit
 * applies ops to in-memory docs.
 */

const mockBatchOps: Array<{ op: string; path: string; data?: any; opts?: any }> = [];
let mockDocs: Record<string, any> = {};
let autoIdCounter = 0;
let committedUpTo = 0;

function isSentinel(value: any, kind: string): boolean {
  return value !== null && typeof value === 'object' && value.__fv === kind;
}

function applyValue(existing: any, value: any): any {
  if (isSentinel(value, 'serverTimestamp')) return 'SERVER_TIMESTAMP';
  if (isSentinel(value, 'delete')) return undefined;
  if (isSentinel(value, 'increment')) return (typeof existing === 'number' ? existing : 0) + value.n;
  if (isSentinel(value, 'arrayUnion')) {
    const base = Array.isArray(existing) ? [...existing] : [];
    for (const v of value.vals) {
      if (!base.includes(v)) base.push(v);
    }
    return base;
  }
  return value;
}

function applyDataToDoc(existing: Record<string, any>, data: Record<string, any>): Record<string, any> {
  const next = { ...existing };
  for (const [key, value] of Object.entries(data)) {
    const applied = applyValue(next[key], value);
    if (applied === undefined && isSentinel(value, 'delete')) {
      delete next[key];
    } else {
      next[key] = applied;
    }
  }
  return next;
}

function applyBatchOps(ops: Array<{ op: string; path: string; data?: any; opts?: any }>): void {
  for (const op of ops) {
    if (op.op === 'set') {
      const base = op.opts?.merge ? (mockDocs[op.path] ?? {}) : {};
      mockDocs[op.path] = applyDataToDoc(base, op.data ?? {});
    } else if (op.op === 'update') {
      mockDocs[op.path] = applyDataToDoc(mockDocs[op.path] ?? {}, op.data ?? {});
    } else if (op.op === 'delete') {
      delete mockDocs[op.path];
    }
  }
}

function makeDocRef(collectionName: string, id?: string): any {
  const docId = id ?? `generated-${++autoIdCounter}`;
  const path = `${collectionName}/${docId}`;
  return {
    id: docId,
    path,
    get: async () => {
      const data = mockDocs[path];
      return { exists: data !== undefined, data: () => data };
    },
    set: async (data: any, opts?: any) => {
      mockBatchOps.push({ op: 'set', path, data, opts });
    },
    update: async (data: any) => {
      mockBatchOps.push({ op: 'update', path, data });
    },
    delete: async () => {
      mockBatchOps.push({ op: 'delete', path });
    },
    collection: (sub: string) => ({
      doc: (subId?: string) => makeDocRef(`${path}/${sub}`, subId),
    }),
  };
}

const mockDb = {
  collection: (name: string) => ({
    doc: (id?: string) => makeDocRef(name, id),
    add: async (data: any) => {
      const ref = makeDocRef(name);
      mockBatchOps.push({ op: 'set', path: ref.path, data });
      return ref;
    },
    where: (field: string, _op: string, value: any) => ({
      limit: (n: number) => ({
        get: async () => {
          const docs = Object.entries(mockDocs)
            .filter(([p, data]) => {
              const parts = p.split('/');
              return parts.length === 2 && parts[0] === name && data && data[field] === value;
            })
            .slice(0, n)
            .map(([p, data]) => ({ id: p.split('/').pop(), data: () => data }));
          return { empty: docs.length === 0, docs };
        },
      }),
    }),
  }),
  batch: () => ({
    set: (ref: any, data: any, opts?: any) => {
      mockBatchOps.push({ op: 'set', path: ref.path, data, opts });
    },
    update: (ref: any, data: any) => {
      mockBatchOps.push({ op: 'update', path: ref.path, data });
    },
    delete: (ref: any) => {
      mockBatchOps.push({ op: 'delete', path: ref.path });
    },
    commit: async () => {
      applyBatchOps(mockBatchOps.slice(committedUpTo));
      committedUpTo = mockBatchOps.length;
    },
  }),
};

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number;
    private payload: any;
    constructor(payload: any, init?: { status?: number }) {
      this.payload = payload;
      this.status = init?.status ?? 200;
    }
    static json(payload: any, init?: { status?: number }) {
      return new MockNextResponse(payload, init);
    }
    async json() {
      return this.payload;
    }
  }
  return { NextRequest: class {}, NextResponse: MockNextResponse };
});

jest.mock('firebase-admin', () => {
  const FieldValue = {
    delete: () => ({ __fv: 'delete' }),
    serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
    arrayUnion: (...vals: any[]) => ({ __fv: 'arrayUnion', vals }),
    increment: (n: number) => ({ __fv: 'increment', n }),
  };
  return { firestore: { FieldValue } };
});

jest.mock('@/lib/server/leave-return', () => ({
  returnFromLeave: jest.fn(),
  RESTORABLE_TASK_STATUSES: ['pending', 'in_progress', 'in-progress', 'locked'],
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDb,
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({
    authenticated: true,
    user: {
      userId: 'reviewer-1',
      email: 'reviewer@example.com',
      displayName: 'Reviewer Admin',
      emailVerified: true,
      role: 'admin',
      user: {},
    },
  }),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(true),
  hasServerPermissionForUser: jest.fn().mockResolvedValue(true),
}));

import { PATCH } from '../route';

function makeRequest(body: any): any {
  return { json: async () => body };
}

const FUTURE_DEADLINE = '2027-06-01T00:00:00.000Z';

describe('PATCH /api/admin/universal-review deadline fairness (founder rule 2026-10-26)', () => {
  beforeEach(() => {
    mockBatchOps.length = 0;
    mockDocs = {};
    autoIdCounter = 0;
    committedUpTo = 0;
    mockDocs['users/reviewer-1'] = { displayName: 'Reviewer Admin' };
    mockDocs['users/member-1'] = { displayName: 'Member One', points: 0, total_points: 0 };
  });

  test('reject of a submitted task WITHOUT a new deadline: not decided, reported, stays in review', async () => {
    mockDocs['tasks/task-1'] = {
      assigneeId: 'member-1', title: 'Task One', status: 'submitted-for-review',
      deadline: new Date('2026-10-20T00:00:00.000Z'),
    };
    const res: any = await PATCH(makeRequest({ collection: 'tasks', ids: ['task-1'], action: 'reject', notes: 'Needs more detail' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.failedTaskRejects).toEqual([
      { id: 'task-1', error: 'A new deadline is mandatory for rejecting a task submission' },
    ]);
    expect(mockDocs['tasks/task-1'].status).toBe('submitted-for-review');
  });

  test('reject of a submitted task WITH a future deadline: changes-requested, deadline rewritten, history recorded', async () => {
    mockDocs['tasks/task-1'] = {
      assigneeId: 'member-1', title: 'Task One', status: 'submitted-for-review',
      deadline: new Date('2026-10-20T00:00:00.000Z'),
    };
    const res: any = await PATCH(makeRequest({
      collection: 'tasks', ids: ['task-1'], action: 'reject',
      notes: 'Needs more detail', reviewDeadline: FUTURE_DEADLINE,
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.failedTaskRejects).toEqual([]);
    expect(mockDocs['tasks/task-1'].status).toBe('changes-requested');
    expect(mockDocs['tasks/task-1'].deadline).toEqual(new Date(FUTURE_DEADLINE));
    const history = mockDocs['tasks/task-1'].feedback_history;
    expect(Array.isArray(history)).toBe(true);
    expect(history).toHaveLength(1);
    expect(history[0].text).toBe('Needs more detail');
    expect(history[0].new_deadline).toBe(FUTURE_DEADLINE);
  });

  test('workflow step return writes individualDeadline, not deadline', async () => {
    mockDocs['tasks/step-1'] = {
      assigneeId: 'member-1', title: 'Step One', status: 'submitted-for-review',
      workflowId: 'wf-1', individualDeadline: '2026-10-27T00:34:00.000Z',
    };
    const res: any = await PATCH(makeRequest({
      collection: 'tasks', ids: ['step-1'], action: 'reject',
      notes: 'Redo', reviewDeadline: FUTURE_DEADLINE,
    }));
    expect(res.status).toBe(200);
    expect(mockDocs['tasks/step-1'].status).toBe('changes-requested');
    expect(mockDocs['tasks/step-1'].individualDeadline).toEqual(new Date(FUTURE_DEADLINE));
    expect(mockDocs['tasks/step-1'].deadline).toBeUndefined();
  });

  test('reject with a past deadline is refused and reported', async () => {
    mockDocs['tasks/task-1'] = {
      assigneeId: 'member-1', title: 'Task One', status: 'submitted-for-review',
    };
    const res: any = await PATCH(makeRequest({
      collection: 'tasks', ids: ['task-1'], action: 'reject',
      notes: 'Redo', reviewDeadline: '2020-01-01T00:00:00.000Z',
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.failedTaskRejects).toEqual([
      { id: 'task-1', error: 'The new deadline for a rejected task must be in the future' },
    ]);
    expect(mockDocs['tasks/task-1'].status).toBe('submitted-for-review');
  });

  test('reject of a task with NO submission keeps legacy behavior (rejected, no deadline needed)', async () => {
    mockDocs['tasks/task-1'] = { assigneeId: 'member-1', title: 'Task One', status: 'pending' };
    const res: any = await PATCH(makeRequest({ collection: 'tasks', ids: ['task-1'], action: 'reject' }));
    expect(res.status).toBe(200);
    expect(mockDocs['tasks/task-1'].status).toBe('rejected');
  });
});
