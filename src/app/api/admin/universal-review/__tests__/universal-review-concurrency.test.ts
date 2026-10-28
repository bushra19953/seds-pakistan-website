/**
 * @jest-environment node
 *
 * Item 4: points idempotency for PATCH /api/admin/universal-review.
 *
 * CONTRACT UNDER TEST (spec section (e), universal-review suite):
 * - the terminal-status guard (approved, rejected, cancelled, completed)
 *   applies to ALL collections, not only leave_requests.
 * - a repeat approve awards points exactly once: one users increment,
 *   one points_ledger doc, submissionsApprovedCount incremented once.
 * - approve-after-reject and reject-after-approve are both skipped.
 * - a task already 'completed' is skipped.
 * - an application in 'under_review' or 'shortlisted' is NOT skipped.
 * - a mixed batch processes the pending doc and skips the terminal doc.
 * - a repeat approve with a different points value is still skipped.
 * - a terminal doc with no pointsAwarded field is still skipped.
 *
 * SEC-RACE (audit item 11): CONCURRENT approvals. The sequential
 * suite (universal-review-points-idempotency.test.ts) pins repeat
 * approvals; this suite pins two approvals racing in the same tick.
 * The pre-fix code read the terminal-status guard BEFORE composing a
 * plain WriteBatch, so both racers passed the guard and both awarded.
 * The award is now claimed inside a serialized runTransaction keyed
 * on the deterministic ledger doc ur_<collection>_<id>.
 *
 * Harness: same in-memory Firestore as the sequential suite, with
 * runTransaction serialized through a promise chain so the racers'
 * transactions interleave like production.
 */

const mockBatchOps: Array<{ op: string; path: string; data?: any; opts?: any }> = [];
let mockDocs: Record<string, any> = {};
let autoIdCounter = 0;
let committedUpTo = 0;
let txChain: Promise<any> = Promise.resolve();

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
  // SEC-RACE: the route now claims points awards inside
  // runTransaction. Serialized like production: tx writes apply
  // immediately to mockDocs and are recorded as already-committed
  // ops so a later batch commit never re-applies them.
  runTransaction: (fn: any) => {
    const run = txChain.then(async () => {
      const tx = {
        get: async (ref: any) => ref.get(),
        set: async (ref: any, data: any, opts?: any) => {
          const base = opts?.merge ? (mockDocs[ref.path] ?? {}) : {};
          mockDocs[ref.path] = applyDataToDoc(base, data ?? {});
          mockBatchOps.push({ op: 'set', path: ref.path, data, opts });
          committedUpTo = mockBatchOps.length;
        },
        update: async (ref: any, data: any) => {
          mockDocs[ref.path] = applyDataToDoc(mockDocs[ref.path] ?? {}, data ?? {});
          mockBatchOps.push({ op: 'update', path: ref.path, data });
          committedUpTo = mockBatchOps.length;
        },
      };
      return fn(tx);
    });
    txChain = run.catch(() => undefined);
    return run;
  },
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

function seedUsers(): void {
  mockDocs['users/reviewer-1'] = { displayName: 'Reviewer Admin' };
  mockDocs['users/member-1'] = { displayName: 'Member One', points: 0, total_points: 0 };
}

function notificationSets(): Array<{ op: string; path: string; data?: any; opts?: any }> {
  return mockBatchOps.filter((o) => o.op === 'set' && o.path.includes('/notifications/'));
}

function ledgerSets(): Array<{ op: string; path: string; data?: any; opts?: any }> {
  return mockBatchOps.filter((o) => o.op === 'set' && o.path.startsWith('points_ledger/'));
}

describe('PATCH /api/admin/universal-review award concurrency (SEC-RACE item 11)', () => {
  beforeEach(() => {
    mockBatchOps.length = 0;
    mockDocs = {};
    autoIdCounter = 0;
    committedUpTo = 0;
    txChain = Promise.resolve();
    seedUsers();
  });

  test('two concurrent approvals of a submission award exactly once', async () => {
    mockDocs['submissions/sub-1'] = { userId: 'member-1', title: 'Entry', type: 'resource', status: 'pending' };
    const body = { collection: 'submissions', ids: ['sub-1'], action: 'approve', points: 10 };
    const [r1, r2]: any[] = await Promise.all([PATCH(makeRequest(body)), PATCH(makeRequest(body))]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(mockDocs['users/member-1'].points).toBe(10);
    expect(mockDocs['users/member-1'].total_points).toBe(10);
    expect(mockDocs['users/member-1'].submissionsApprovedCount).toBe(1);
    expect(ledgerSets()).toHaveLength(1);
    expect(ledgerSets()[0].path).toBe('points_ledger/ur_submissions_sub-1');
    expect(mockDocs['submissions/sub-1'].status).toBe('approved');
  });

  test('two concurrent approvals of a task award exactly once', async () => {
    mockDocs['tasks/task-1'] = { assigneeId: 'member-1', title: 'Task One', status: 'pending' };
    const body = { collection: 'tasks', ids: ['task-1'], action: 'approve', points: 25 };
    const [r1, r2]: any[] = await Promise.all([PATCH(makeRequest(body)), PATCH(makeRequest(body))]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(mockDocs['users/member-1'].points).toBe(25);
    expect(mockDocs['users/member-1'].total_points).toBe(25);
    expect(ledgerSets()).toHaveLength(1);
    expect(ledgerSets()[0].path).toBe('points_ledger/ur_tasks_task-1');
    expect(mockDocs['tasks/task-1'].status).toBe('completed');
  });

  test('a concurrent approve + reject cannot both land: exactly one terminal outcome, at most one award', async () => {
    mockDocs['submissions/sub-1'] = { userId: 'member-1', title: 'Entry', type: 'resource', status: 'pending' };
    const approve = { collection: 'submissions', ids: ['sub-1'], action: 'approve', points: 10 };
    const reject = { collection: 'submissions', ids: ['sub-1'], action: 'reject' };
    const [r1, r2]: any[] = await Promise.all([PATCH(makeRequest(approve)), PATCH(makeRequest(reject))]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Whichever review committed first owns the terminal state; the
    // award was paid at most once and only if approval won.
    expect(['approved', 'rejected']).toContain(mockDocs['submissions/sub-1'].status);
    if (mockDocs['submissions/sub-1'].status === 'approved') {
      expect(mockDocs['users/member-1'].points).toBe(10);
      expect(ledgerSets()).toHaveLength(1);
    } else {
      expect(mockDocs['users/member-1'].points).toBe(0);
      expect(ledgerSets()).toHaveLength(0);
    }
  });
});
