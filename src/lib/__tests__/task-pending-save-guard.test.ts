/**
 * Regression test for the missing task Pending save guard.
 *
 * Saving a task with Status Pending must still work: it must not throw,
 * the task must stay Pending, and no points may be awarded. A Pending save
 * is an ordinary edit, not a completion, so it must take the plain batch
 * path in PATCH /api/tasks and never run the gamification transaction
 * (no points, no ledger entry, no completion stamp).
 *
 * This test exercises the real PATCH handler from
 * src/app/api/tasks/route.ts against a fake Firestore, following the
 * pattern in src/lib/__tests__/task-completion-update.test.ts. Only the
 * Firestore Admin SDK and the surrounding notification, permission, and
 * validation helpers are faked. The fake Firestore enforces the real SDK
 * rule that set/update with any undefined field value throws.
 *
 * No em dashes are used in this file.
 */

const written: Array<{ op: string; path: string; data?: any }> = [];
const batchOps: Array<{ op: string; path: string; data?: any; opts?: any }> = [];

/**
 * Mirror the real Firestore SDK: undefined field values are rejected.
 * FieldValue and Timestamp sentinels from the admin mock carry __fv/__ts
 * markers and are allowed through.
 */
function assertNoUndefined(value: any, fieldPath = ''): void {
  if (value === undefined) {
    throw new Error(
      `Function set() called with invalid data. Unsupported field value: undefined (found in field ${fieldPath || 'root'})`,
    );
  }
  if (value === null || typeof value !== 'object') return;
  if (value instanceof Date) return;
  if (value.__fv !== undefined || value.__ts !== undefined) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUndefined(v, `${fieldPath}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    assertNoUndefined(v, fieldPath ? `${fieldPath}.${k}` : k);
  }
}

/** Resolve FieldValue sentinels the way Firestore would on write. */
function resolveValue(existing: any, value: any): any {
  if (value !== null && typeof value === 'object' && value.__fv !== undefined) {
    if (value.__fv === 'delete') return undefined;
    if (value.__fv === 'increment') {
      return (typeof existing === 'number' ? existing : 0) + value.n;
    }
    if (value.__fv === 'arrayUnion') {
      const base = Array.isArray(existing) ? [...existing] : [];
      for (const v of value.vals) {
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
      return { empty: docs.length === 0, docs };
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

// In-memory docs the fake Firestore serves (path -> data). Repopulated in
// beforeEach so each test starts from a Pending task with zero points.
const store: Record<string, any> = {};

function resetStore(): void {
  for (const k of Object.keys(store)) delete store[k];
  store['tasks/task-pending'] = {
    title: 'Pending task: draft deliverable',
    description: 'A task that is still Pending.',
    status: 'pending',
    assigneeId: 'maira-uid',
    assigneeIds: ['maira-uid'],
    assignerId: 'admin-uid',
    chapterId: 'seds-ist-chapter',
    points: 4,
    penaltyPoints: 5,
    workflowBonusPoints: 10,
  };
  store['users/maira-uid'] = {
    displayName: 'Maira Batool',
    total_points: 0,
    points: 0,
  };
  store['users/admin-uid'] = {
    displayName: 'Admin Reviewer',
    email: 'admin@example.com',
  };
}

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
  getValidatorChainUids: jest.fn().mockResolvedValue([]),
  resolveDisplayName: jest.fn().mockResolvedValue('Test User'),
}));

jest.mock('@/lib/server/validation-notifications', () => ({
  notifyValidatorsOnSubmission: jest.fn().mockResolvedValue(undefined),
  notifyOnDecision: jest.fn().mockResolvedValue(undefined),
  notifyAcceptanceRequest: jest.fn().mockResolvedValue(undefined),
  notifyChainOnDecline: jest.fn().mockResolvedValue(undefined),
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

// NOTE: '@/lib/server/gamification-transaction' is deliberately NOT mocked.
// A Pending save must never reach it, so the real module is left in place
// and the tests below assert that no gamification write happened.
import { PATCH } from '../../app/api/tasks/route';

function makeRequest(body: any): any {
  const req: any = { json: async () => body };
  req.clone = () => req;
  return req;
}

/**
 * The payload the Admin Edit Task form sends for a standalone task that
 * stays Pending: same assignee, same points, edited title, status Pending.
 * No steps array, no workflowId: this is the plain batch save path.
 */
function pendingSavePayload(): any {
  return {
    taskId: 'task-pending',
    updates: {
      title: 'Pending task: draft deliverable (edited)',
      description: 'A task that is still Pending.',
      assigneeId: 'maira-uid',
      assigneeIds: ['maira-uid'],
      points: 4,
      chapterId: 'seds-ist-chapter',
      resources: [],
      deadline: '2026-12-31T23:59:00.000Z',
      status: 'pending',
    },
  };
}

describe('PATCH /api/tasks Pending save guard', () => {
  beforeEach(() => {
    resetStore();
    written.length = 0;
    batchOps.length = 0;
    genCounter = 0;
  });

  test('saving a task with Status Pending does not throw and the task stays Pending', async () => {
    const res: any = await PATCH(makeRequest(pendingSavePayload()));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.transitionedToCompleted).toBe(false);

    // The edit itself persists (title changed) while the status stays Pending.
    expect(store['tasks/task-pending'].status).toBe('pending');
    expect(store['tasks/task-pending'].title).toBe('Pending task: draft deliverable (edited)');
    const taskUpdate = batchOps.find(
      (o) => o.op === 'update' && o.path === 'tasks/task-pending',
    );
    expect(taskUpdate).toBeDefined();
    expect(taskUpdate!.data.status).toBe('pending');
  });

  test('saving a task with Status Pending awards no points', async () => {
    const res: any = await PATCH(makeRequest(pendingSavePayload()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pointsAwardedTotal).toBe(0);

    // No gamification transaction ran: no ledger entry and no user points
    // write in either the batch path or the transaction path.
    const allWrites = [...batchOps, ...written];
    expect(allWrites.some((w) => w.path.startsWith('points_ledger/'))).toBe(false);
    expect(
      allWrites.some(
        (w) =>
          w.path === 'users/maira-uid' &&
          (w.data?.total_points !== undefined || w.data?.points !== undefined),
      ),
    ).toBe(false);

    // Stored balances are untouched, and no award stamp lands on the task.
    expect(store['users/maira-uid'].total_points).toBe(0);
    expect(store['users/maira-uid'].points).toBe(0);
    expect(store['tasks/task-pending'].pointsAwarded).toBeUndefined();
    expect(store['tasks/task-pending'].status).toBe('pending');
  });
});
