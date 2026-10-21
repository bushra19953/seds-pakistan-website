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
 * PATTERN: follows universal-review-leave.test.ts. The real PATCH export
 * is exercised with a fully mocked Firestore, and the mock batch commit
 * applies ops to in-memory docs so a second PATCH reads the first
 * PATCH's committed status, exactly like production.
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
}));

import { PATCH } from '../route';

function makeRequest(body: any): any {
  return { json: async () => body };
}

function seedUsers(): void {
  mockDocs['users/reviewer-1'] = { displayName: 'Reviewer Admin' };
  mockDocs['users/member-1'] = { displayName: 'Member One', points: 0, total_points: 0 };
}

function ledgerSets(): Array<{ op: string; path: string; data?: any; opts?: any }> {
  return mockBatchOps.filter((o) => o.op === 'set' && o.path.startsWith('points_ledger/'));
}

function notificationSets(): Array<{ op: string; path: string; data?: any; opts?: any }> {
  return mockBatchOps.filter((o) => o.op === 'set' && o.path.includes('/notifications/'));
}

describe('PATCH /api/admin/universal-review points idempotency (Item 4)', () => {
  beforeEach(() => {
    mockBatchOps.length = 0;
    mockDocs = {};
    autoIdCounter = 0;
    committedUpTo = 0;
    seedUsers();
  });

  test('1. tasks: double approve awards once, second is skipped with no new ops', async () => {
    mockDocs['tasks/task-1'] = { assigneeId: 'member-1', title: 'Task One', status: 'pending' };
    const body = { collection: 'tasks', ids: ['task-1'], action: 'approve', points: 10 };
    const first: any = await PATCH(makeRequest(body));
    expect(first.status).toBe(200);
    expect(mockDocs['tasks/task-1'].status).toBe('approved');
    expect(mockDocs['users/member-1'].points).toBe(10);
    expect(mockDocs['users/member-1'].total_points).toBe(10);
    expect(ledgerSets()).toHaveLength(1);
    const opsAfterFirst = mockBatchOps.length;

    const second: any = await PATCH(makeRequest(body));
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.skippedAlreadyReviewed).toContain('task-1');
    expect(mockBatchOps.slice(opsAfterFirst)).toHaveLength(0);
    expect(ledgerSets()).toHaveLength(1);
    expect(mockDocs['users/member-1'].points).toBe(10);
    expect(mockDocs['users/member-1'].total_points).toBe(10);
    expect(mockDocs['tasks/task-1'].status).toBe('approved');
  });

  test('2. submissions via universal-review: double approve awards once, count incremented once', async () => {
    mockDocs['submissions/sub-1'] = { userId: 'member-1', title: 'Entry', type: 'resource', status: 'pending' };
    const body = { collection: 'submissions', ids: ['sub-1'], action: 'approve', points: 10 };
    await PATCH(makeRequest(body));
    const second: any = await PATCH(makeRequest(body));
    expect(second.status).toBe(200);
    expect((await second.json()).skippedAlreadyReviewed).toContain('sub-1');
    expect(ledgerSets()).toHaveLength(1);
    expect(mockDocs['users/member-1'].points).toBe(10);
    expect(mockDocs['users/member-1'].submissionsApprovedCount).toBe(1);
  });

  test('3. applications: double approve awards once', async () => {
    mockDocs['applications/app-1'] = { userId: 'member-1', title: 'Application', status: 'pending', skills: [] };
    const body = { collection: 'applications', ids: ['app-1'], action: 'approve', points: 10 };
    await PATCH(makeRequest(body));
    const second: any = await PATCH(makeRequest(body));
    expect(second.status).toBe(200);
    expect((await second.json()).skippedAlreadyReviewed).toContain('app-1');
    expect(ledgerSets()).toHaveLength(1);
    expect(mockDocs['users/member-1'].points).toBe(10);
    expect(mockDocs['applications/app-1'].status).toBe('approved');
  });

  test('4. form_responses: double approve awards once', async () => {
    mockDocs['form_responses/fr-1'] = { userId: 'member-1', title: 'Form', status: 'pending' };
    const body = { collection: 'form_responses', ids: ['fr-1'], action: 'approve', points: 10 };
    await PATCH(makeRequest(body));
    const second: any = await PATCH(makeRequest(body));
    expect(second.status).toBe(200);
    expect((await second.json()).skippedAlreadyReviewed).toContain('fr-1');
    expect(ledgerSets()).toHaveLength(1);
    expect(mockDocs['users/member-1'].points).toBe(10);
  });

  test('5a. approve after reject is skipped, status stays rejected, no points', async () => {
    mockDocs['tasks/task-1'] = { assigneeId: 'member-1', title: 'Task One', status: 'pending' };
    await PATCH(makeRequest({ collection: 'tasks', ids: ['task-1'], action: 'reject' }));
    expect(mockDocs['tasks/task-1'].status).toBe('rejected');
    const second: any = await PATCH(makeRequest({ collection: 'tasks', ids: ['task-1'], action: 'approve', points: 10 }));
    expect(second.status).toBe(200);
    expect((await second.json()).skippedAlreadyReviewed).toContain('task-1');
    expect(mockDocs['tasks/task-1'].status).toBe('rejected');
    expect(mockDocs['users/member-1'].points).toBe(0);
    expect(ledgerSets()).toHaveLength(0);
  });

  test('5b. reject after approve is skipped, status stays approved, no second notification', async () => {
    mockDocs['tasks/task-1'] = { assigneeId: 'member-1', title: 'Task One', status: 'pending' };
    await PATCH(makeRequest({ collection: 'tasks', ids: ['task-1'], action: 'approve', points: 10 }));
    expect(notificationSets()).toHaveLength(1);
    const second: any = await PATCH(makeRequest({ collection: 'tasks', ids: ['task-1'], action: 'reject' }));
    expect(second.status).toBe(200);
    expect((await second.json()).skippedAlreadyReviewed).toContain('task-1');
    expect(mockDocs['tasks/task-1'].status).toBe('approved');
    expect(notificationSets()).toHaveLength(1);
  });

  test('6. a task already completed is skipped by a universal-review approve with points', async () => {
    mockDocs['tasks/task-1'] = { assigneeId: 'member-1', title: 'Task One', status: 'completed' };
    const res: any = await PATCH(makeRequest({ collection: 'tasks', ids: ['task-1'], action: 'approve', points: 10 }));
    expect(res.status).toBe(200);
    expect((await res.json()).skippedAlreadyReviewed).toContain('task-1');
    expect(mockBatchOps).toHaveLength(0);
    expect(mockDocs['users/member-1'].points).toBe(0);
    expect(mockDocs['tasks/task-1'].status).toBe('completed');
  });

  test('7a. an application in under_review is NOT skipped: first approve processes normally', async () => {
    mockDocs['applications/app-1'] = { userId: 'member-1', title: 'Application', status: 'under_review', skills: [] };
    const res: any = await PATCH(makeRequest({ collection: 'applications', ids: ['app-1'], action: 'approve', points: 10 }));
    expect(res.status).toBe(200);
    expect((await res.json()).skippedAlreadyReviewed).toEqual([]);
    expect(mockDocs['applications/app-1'].status).toBe('approved');
    expect(mockDocs['users/member-1'].points).toBe(10);
    expect(ledgerSets()).toHaveLength(1);
  });

  test('7b. an application in shortlisted is NOT skipped', async () => {
    mockDocs['applications/app-1'] = { userId: 'member-1', title: 'Application', status: 'shortlisted', skills: [] };
    const res: any = await PATCH(makeRequest({ collection: 'applications', ids: ['app-1'], action: 'approve', points: 10 }));
    expect(res.status).toBe(200);
    expect((await res.json()).skippedAlreadyReviewed).toEqual([]);
    expect(mockDocs['applications/app-1'].status).toBe('approved');
    expect(mockDocs['users/member-1'].points).toBe(10);
  });

  test('8. mixed batch: pending doc awards normally, terminal doc is skipped', async () => {
    mockDocs['tasks/task-old'] = { assigneeId: 'member-1', title: 'Old', status: 'approved', pointsAwarded: 10 };
    mockDocs['tasks/task-new'] = { assigneeId: 'member-1', title: 'New', status: 'pending' };
    const res: any = await PATCH(makeRequest({ collection: 'tasks', ids: ['task-old', 'task-new'], action: 'approve', points: 10 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skippedAlreadyReviewed).toEqual(['task-old']);
    expect(mockDocs['tasks/task-new'].status).toBe('approved');
    expect(mockDocs['users/member-1'].points).toBe(10);
    expect(ledgerSets()).toHaveLength(1);
    expect(ledgerSets()[0].data.task_id).toBe('task-new');
  });

  test('9. repeat approve carrying a different points value is still skipped', async () => {
    mockDocs['tasks/task-1'] = { assigneeId: 'member-1', title: 'Task One', status: 'pending' };
    await PATCH(makeRequest({ collection: 'tasks', ids: ['task-1'], action: 'approve', points: 10 }));
    const second: any = await PATCH(makeRequest({ collection: 'tasks', ids: ['task-1'], action: 'approve', points: 99 }));
    expect(second.status).toBe(200);
    expect((await second.json()).skippedAlreadyReviewed).toContain('task-1');
    expect(mockDocs['users/member-1'].points).toBe(10);
    expect(ledgerSets()).toHaveLength(1);
  });

  test('10. terminal doc with no pointsAwarded field is still skipped', async () => {
    mockDocs['tasks/task-1'] = { assigneeId: 'member-1', title: 'Legacy', status: 'approved' };
    expect(mockDocs['tasks/task-1']).not.toHaveProperty('pointsAwarded');
    const res: any = await PATCH(makeRequest({ collection: 'tasks', ids: ['task-1'], action: 'approve', points: 10 }));
    expect(res.status).toBe(200);
    expect((await res.json()).skippedAlreadyReviewed).toContain('task-1');
    expect(mockBatchOps).toHaveLength(0);
    expect(mockDocs['users/member-1'].points).toBe(0);
  });
});
