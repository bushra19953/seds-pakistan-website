/**
 * CONTRACT TESTS — Tasks status-semantics fix (TS-P148 family, M3/M4/M5).
 *
 * Source of truth: the defect traces in ~/workspace/permissions_audit/
 * (profile_task_list_query.md, task_lifecycle_persistence.md,
 * task_doc_shapes.md) and the fix brief:
 *
 *  - ONE terminal spelling is written: approvals land on 'completed'.
 *    The legacy 'approved' spelling stays in the PATCH request schema
 *    for old clients but is normalized away before any write, and the
 *    gamification transaction stamps 'completed' unconditionally.
 *  - Readers honor BOTH spellings on stored docs until the data is
 *    unified: workflow progress, mission completion, sub-task rollup,
 *    the team list (via its route test), History, and the detail dialog.
 *  - A validation decision (approve OR changes-requested) resolves the
 *    "awaiting validation" alerts the submission fan-out sent.
 *
 * Part A pins the pure reader seams (workflow-progress, task-rollup).
 * Part B exercises the real PATCH /api/tasks handler with the real
 * gamification transaction against an in-memory fake Firestore (the
 * pattern from task-completion-update.test.ts; only Firestore, auth,
 * and the notification/audit helpers are faked).
 *
 * No em dashes are used in this file.
 */

// ---------------------------------------------------------------------
// Shared in-memory fake Firestore
// ---------------------------------------------------------------------

const written: Array<{ op: string; path: string; data?: any }> = [];
const batchOps: Array<{ op: string; path: string; data?: any }> = [];

function assertNoUndefined(value: any, fieldPath = ''): void {
  if (value === undefined) {
    throw new Error(
      `Function set() called with invalid data. Unsupported field value: undefined (found in field ${fieldPath || 'root'})`,
    );
  }
  if (value === null || typeof value !== 'object') return;
  if (value instanceof Date) return;
  if ((value as any).__fv !== undefined || (value as any).__ts !== undefined) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUndefined(v, `${fieldPath}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    assertNoUndefined(v, fieldPath ? `${fieldPath}.${k}` : k);
  }
}

function resolveValue(existing: any, value: any): any {
  if (value !== null && typeof value === 'object' && (value as any).__fv !== undefined) {
    if ((value as any).__fv === 'delete') return undefined;
    if ((value as any).__fv === 'increment') {
      return (typeof existing === 'number' ? existing : 0) + (value as any).n;
    }
    if ((value as any).__fv === 'arrayUnion') {
      const base = Array.isArray(existing) ? [...existing] : [];
      for (const v of (value as any).vals) {
        if (!base.includes(v)) base.push(v);
      }
      return base;
    }
    return value;
  }
  return value;
}

function applySet(existing: any, data: any, opts?: any): any {
  const base = opts && opts.merge ? { ...(existing || {}) } : {};
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(data)) {
    const resolved = resolveValue(out[k], v);
    if (resolved === undefined && v !== null && typeof v === 'object' && (v as any).__fv === 'delete') {
      delete out[k];
    } else {
      out[k] = resolved;
    }
  }
  return out;
}

function applyUpdate(existing: any, data: any): any {
  const out: Record<string, any> = { ...(existing || {}) };
  for (const [k, v] of Object.entries(data)) {
    const resolved = resolveValue(out[k], v);
    if (resolved === undefined && v !== null && typeof v === 'object' && (v as any).__fv === 'delete') {
      delete out[k];
    } else {
      out[k] = resolved;
    }
  }
  return out;
}

function applyBatchOp(op: { op: string; path: string; data?: any; opts?: any }): void {
  if (op.op === 'delete') {
    delete store[op.path];
    return;
  }
  assertNoUndefined(op.data);
  if (op.op === 'set') {
    store[op.path] = applySet(store[op.path], op.data, op.opts);
  } else if (op.op === 'update') {
    store[op.path] = applyUpdate(store[op.path], op.data);
  }
}

let genCounter = 0;
function nextId(): string {
  genCounter += 1;
  return `gen-${genCounter}`;
}

function makeDocRef(path: string): any {
  const id = path.split('/').pop() as string;
  return {
    id,
    path,
    get: async () => {
      const data = store[path];
      return { exists: data !== undefined, data: () => data, ref: makeDocRef(path) };
    },
    set: async (data: any, opts?: any) => {
      assertNoUndefined(data);
      store[path] = applySet(store[path], data, opts);
    },
    update: async (data: any) => {
      assertNoUndefined(data);
      store[path] = applyUpdate(store[path], data);
    },
    collection: (subName: string) => ({
      doc: (subId?: string) => makeDocRef(`${path}/${subName}/${subId ?? nextId()}`),
      add: async (data: any) => {
        const ref = makeDocRef(`${path}/${subName}/${nextId()}`);
        await ref.set(data);
        return ref;
      },
    }),
  };
}

function makeQuery(
  collectionName: string,
  filters: Array<{ field: string; op: string; val: any }>,
  limitN?: number,
): any {
  const q: any = {
    __kind: 'query',
    where: (field: string, op: string, val: any) =>
      makeQuery(collectionName, [...filters, { field, op, val }], limitN),
    limit: (n: number) => makeQuery(collectionName, filters, n),
    get: async () => {
      const docs = Object.entries(store)
        .filter(([p]) => {
          const parts = p.split('/');
          return parts.length === 2 && parts[0] === collectionName;
        })
        .filter(([, data]) => filters.every((f) => f.op === '==' && (data as any)[f.field] === f.val))
        .slice(0, limitN ?? Number.POSITIVE_INFINITY)
        .map(([p, data]) => {
          const docId = p.split('/')[1];
          return { id: docId, ref: makeDocRef(`${collectionName}/${docId}`), data: () => data };
        });
      return { empty: docs.length === 0, size: docs.length, docs };
    },
  };
  return q;
}

function makeCollection(name: string): any {
  return {
    doc: (id?: string) => makeDocRef(`${name}/${id ?? nextId()}`),
    where: (field: string, op: string, val: any) =>
      makeQuery(name, [{ field, op, val }]),
  };
}

const fakeTx = {
  get: async (refOrQuery: any) => {
    if (refOrQuery.__kind === 'query') return refOrQuery.get();
    const data = store[refOrQuery.path];
    return { exists: data !== undefined, data: () => data, ref: refOrQuery };
  },
  set: (ref: any, data: any, opts?: any) => {
    assertNoUndefined(data);
    written.push({ op: 'set', path: ref.path, data });
    store[ref.path] = applySet(store[ref.path], data, opts);
  },
  update: (ref: any, data: any) => {
    assertNoUndefined(data);
    written.push({ op: 'update', path: ref.path, data });
    store[ref.path] = applyUpdate(store[ref.path], data);
  },
};

const mockDb = {
  collection: (name: string) => makeCollection(name),
  batch: () => {
    const ops: Array<{ op: string; path: string; data?: any; opts?: any }> = [];
    return {
      update: (ref: any, data: any) => {
        ops.push({ op: 'update', path: ref.path, data });
      },
      set: (ref: any, data: any, opts?: any) => {
        ops.push({ op: 'set', path: ref.path, data, opts });
      },
      delete: (ref: any) => {
        ops.push({ op: 'delete', path: ref.path });
      },
      commit: async () => {
        for (const op of ops) {
          batchOps.push(op);
          applyBatchOp(op);
        }
      },
    };
  },
  runTransaction: async (fn: any) => fn(fakeTx),
};

const store: Record<string, any> = {};

function resetStore(): void {
  for (const k of Object.keys(store)) delete store[k];
  // A submitted task awaiting validation, plus the next step of its
  // workflow so the completion transaction has a step to release.
  store['tasks/task-a'] = {
    title: 'Deliverable A',
    description: 'Submitted work awaiting a decision.',
    status: 'submitted-for-review',
    submittedBy: 'maira-uid',
    assigneeId: 'maira-uid',
    assigneeIds: ['maira-uid'],
    assignerId: 'admin-uid',
    chapterId: 'seds-ist-chapter',
    workflowId: 'wf-1',
    workflowTitle: 'Mission One',
    workflowParticipantIds: ['maira-uid', 'yahya-uid'],
    sequenceIndex: 0,
    points: 4,
    penaltyPoints: 5,
    workflowBonusPoints: 10,
  };
  store['tasks/task-b'] = {
    title: 'Deliverable B',
    description: 'The next step.',
    status: 'pending',
    assigneeId: 'yahya-uid',
    assigneeIds: ['yahya-uid'],
    assignerId: 'admin-uid',
    chapterId: 'seds-ist-chapter',
    workflowId: 'wf-1',
    workflowTitle: 'Mission One',
    workflowParticipantIds: ['maira-uid', 'yahya-uid'],
    sequenceIndex: 1,
    points: 3,
    penaltyPoints: 5,
    workflowBonusPoints: 10,
  };
  // Rollup fixtures: two parents with sub-tasks in mixed states.
  store['tasks/parent-1'] = { title: 'Parent 1', status: 'in-progress' };
  store['tasks/sub-a'] = { status: 'completed', parentTaskId: 'parent-1' };
  store['tasks/sub-b'] = { status: 'approved', parentTaskId: 'parent-1' };
  store['tasks/sub-c'] = { status: 'in-progress', parentTaskId: 'parent-1' };
  store['tasks/parent-2'] = { title: 'Parent 2', status: 'in-progress' };
  store['tasks/sub-d'] = { status: 'pending', parentTaskId: 'parent-2' };
  store['tasks/sub-e'] = { status: 'submitted-for-review', parentTaskId: 'parent-2' };
}

// ---------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------

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

jest.mock('@/lib/server/firebase-admin', () => {
  const FieldValue = {
    delete: () => ({ __fv: 'delete' }),
    serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
    arrayUnion: (...vals: any[]) => ({ __fv: 'arrayUnion', vals }),
    increment: (n: number) => ({ __fv: 'increment', n }),
  };
  return {
    admin: {
      firestore: {
        Timestamp: {
          now: () => ({ __ts: 'now', toDate: () => new Date() }),
        },
        FieldValue,
      },
    },
    getDb: () => mockDb,
    ensureAdminInitialized: () => {},
  };
});

jest.mock('@/lib/auth/verifySession', () => {
  class MockSessionError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 401) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  return {
    extractBearerToken: () => 'test-bearer-token',
    verifyIdTokenString: async () => {
      const projectId =
        process.env.FIREBASE_PROJECT_ID ||
        process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
        'test-project';
      return {
        uid: 'admin-uid',
        role: 'admin',
        permissions: { manageTasks: true },
        iss: `https://securetoken.google.com/${projectId}`,
        aud: projectId,
      };
    },
    SessionError: MockSessionError,
  };
});

jest.mock('@/lib/mailer', () => ({
  sendEmailNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/server/user-status', () => ({
  validateUserStatus: jest.fn().mockResolvedValue({ isValid: true }),
}));

jest.mock('@/lib/server/hierarchy-utils', () => ({
  isManagerAbove: jest.fn().mockResolvedValue(false),
}));

jest.mock('@/lib/server/hierarchy', () => ({
  canValidateTask: jest
    .fn()
    .mockResolvedValue({ allowed: true, reason: 'role', via: 'role', depth: 0 }),
  getValidatorChainUids: jest.fn().mockResolvedValue(['validator-uid']),
  resolveDisplayName: jest.fn().mockResolvedValue('Test User'),
}));

const mockResolveValidatorSubmissionAlerts = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/server/validation-notifications', () => ({
  notifyValidatorsOnSubmission: jest.fn().mockResolvedValue(undefined),
  notifyOnDecision: jest.fn().mockResolvedValue(undefined),
  notifyAcceptanceRequest: jest.fn().mockResolvedValue(undefined),
  notifyChainOnDecline: jest.fn().mockResolvedValue(undefined),
  resolveValidatorSubmissionAlerts: mockResolveValidatorSubmissionAlerts,
}));

jest.mock('@/lib/server/validation-audit', () => ({
  logValidationDecision: jest.fn().mockResolvedValue(undefined),
  logDeniedValidationAttempt: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(true),
  resolveUserRole: jest.fn().mockResolvedValue('admin'),
  assertChapterAccess: jest.fn().mockResolvedValue({ allowed: true }),
}));

// NOTE: '@/lib/server/gamification-transaction', '@/lib/workflow-progress'
// and '@/lib/task-rollup' are deliberately NOT mocked. The real code runs
// against the fake Firestore above.
import { PATCH } from '../../app/api/tasks/route';
import {
  isStepWorkDone,
  isStepApproved,
  computeWorkflowProgress,
} from '../workflow-progress';
import { recalculateTaskRollup } from '../task-rollup';

function makeRequest(body: any): any {
  const req: any = { json: async () => body };
  req.clone = () => req;
  return req;
}

// ---------------------------------------------------------------------
// Part A: readers honor the legacy 'approved' spelling
// ---------------------------------------------------------------------

describe('MECHANISM: legacy approved is terminal in workflow progress', () => {
  test('isStepApproved treats legacy approved as approved', () => {
    expect(isStepApproved('approved')).toBe(true);
  });

  test('isStepWorkDone treats legacy approved as work done', () => {
    expect(isStepWorkDone('approved')).toBe(true);
  });

  test('a mission whose steps are completed + legacy approved is complete', () => {
    const p = computeWorkflowProgress(['completed', 'approved']);
    expect(p.isCompleted).toBe(true);
    expect(p.approvedSteps).toBe(2);
    expect(p.completedSteps).toBe(2);
    expect(p.progressPercentage).toBe(100);
  });

  // Controls: behavior that already held before the fix.
  test('control: submitted-for-review counts as work done but not approved', () => {
    expect(isStepWorkDone('submitted-for-review')).toBe(true);
    expect(isStepApproved('submitted-for-review')).toBe(false);
    expect(computeWorkflowProgress(['submitted-for-review']).isCompleted).toBe(false);
  });

  test('control: a pending step keeps the mission incomplete', () => {
    const p = computeWorkflowProgress(['completed', 'pending']);
    expect(p.isCompleted).toBe(false);
    expect(p.progressPercentage).toBe(50);
  });
});

describe('MECHANISM: legacy approved counts in the sub-task rollup', () => {
  beforeEach(() => {
    resetStore();
  });

  test('rollup counts a legacy approved sub-task as completed', async () => {
    await recalculateTaskRollup('parent-1');
    expect(store['tasks/parent-1'].subTaskCount).toBe(3);
    expect(store['tasks/parent-1'].subTaskCompletedCount).toBe(2);
  });

  test('control: no terminal sub-tasks means a zero completed count', async () => {
    await recalculateTaskRollup('parent-2');
    expect(store['tasks/parent-2'].subTaskCount).toBe(2);
    expect(store['tasks/parent-2'].subTaskCompletedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------
// Part B: the write path never stores 'approved' again, and a decision
// resolves the validators' submission alerts
// ---------------------------------------------------------------------

describe('MECHANISM: approval writes the canonical completed spelling', () => {
  beforeEach(() => {
    resetStore();
    written.length = 0;
    batchOps.length = 0;
    genCounter = 0;
    mockResolveValidatorSubmissionAlerts.mockClear();
  });

  test('a decision sent as legacy approved is stored as completed', async () => {
    const res: any = await PATCH(makeRequest({
      taskId: 'task-a',
      updates: { status: 'approved' },
    }));
    expect(res.status).toBe(200);
    expect(store['tasks/task-a'].status).toBe('completed');
    expect(store['tasks/task-a'].completedAt).toBeDefined();
    // No write anywhere in the flow may carry the legacy spelling.
    const legacyWrites = [...written, ...batchOps].filter(
      (w) => w.path === 'tasks/task-a' && w.data && w.data.status === 'approved',
    );
    expect(legacyWrites).toHaveLength(0);
  });

  test('control: a decision sent as completed is stored as completed', async () => {
    const res: any = await PATCH(makeRequest({
      taskId: 'task-a',
      updates: { status: 'completed' },
    }));
    expect(res.status).toBe(200);
    expect(store['tasks/task-a'].status).toBe('completed');
  });

  test('an approval decision resolves the validator submission alerts', async () => {
    const res: any = await PATCH(makeRequest({
      taskId: 'task-a',
      updates: { status: 'approved' },
    }));
    expect(res.status).toBe(200);
    expect(mockResolveValidatorSubmissionAlerts).toHaveBeenCalledTimes(1);
    expect(mockResolveValidatorSubmissionAlerts).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-a',
        submitterUid: 'maira-uid',
        validatorUids: ['validator-uid'],
      }),
    );
  });

  test('a changes-requested decision stores changes-requested and resolves the alerts', async () => {
    // Deadline fairness (founder rule, 2026-10-26): a return from
    // review must carry a reviewer-set new deadline, so the decision
    // now sends reviewDeadline and the task's deadline is rewritten.
    const res: any = await PATCH(makeRequest({
      taskId: 'task-a',
      updates: {
        status: 'changes-requested',
        feedback_text: 'Please tighten the second half.',
        reviewDeadline: '2027-06-01T00:00:00.000Z',
      },
    }));
    expect(res.status).toBe(200);
    expect(store['tasks/task-a'].status).toBe('changes-requested');
    expect(store['tasks/task-a'].deadline).toEqual(new Date('2027-06-01T00:00:00.000Z'));
    expect(mockResolveValidatorSubmissionAlerts).toHaveBeenCalledTimes(1);
    expect(mockResolveValidatorSubmissionAlerts).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-a', submitterUid: 'maira-uid' }),
    );
  });
});
