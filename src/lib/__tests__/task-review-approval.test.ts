/**
 * Regression test for the Universal Inbox TASK_REVIEW approval hang:
 * "Deliverable B", Yahya, ref YG2NEE1K, POINTS TO AWARD = 10.
 *
 * Bug: clicking APPROVE in the Universal Inbox never landed. The review
 * stayed PENDING and 0 points were awarded.
 *
 * Root cause under test: task docs carry the submitter on `assigneeId`
 * (plus `submittedBy`), NOT on `userId`. The PATCH handler in
 * src/app/api/admin/universal-review/route.ts reads `docData.userId`
 * when it awards points, so for a task review that value is undefined
 * and `db.collection('users').doc(undefined)` throws under the real
 * Admin SDK. The throw happens before `batch.commit()`, so the handler
 * returns 500, the task is never marked approved, and no points or
 * ledger entry are ever written.
 *
 * This test exercises the real PATCH export with a fake Firestore that
 * enforces the real SDK rule (doc() with an undefined id throws), so it
 * fails against the unfixed handler and passes once the handler resolves
 * the submitter from the task doc (assigneeId / submittedBy) instead of
 * from a `userId` field that task docs do not carry.
 *
 * Follows the repo pattern from
 * src/app/api/tasks/__tests__/route.step-resources.test.ts and
 * src/lib/server/__tests__/gamification-transaction.test.ts: real handler,
 * mocked NextResponse / auth / permissions, in-memory fake Firestore.
 */

// --- Fake Firestore state -------------------------------------------------

const mockBatchOps: Array<{ op: string; path: string; data?: any }> = [];

function initialStore(): Record<string, any> {
  return {
    'tasks/YG2NEE1K': {
      title: 'Deliverable B',
      description: 'Task review for Deliverable B.',
      status: 'submitted-for-review',
      assigneeId: 'yahya-uid',
      assigneeName: 'Yahya',
      submittedBy: 'yahya-uid',
      submittedAt: '2026-10-14T00:00:00.000Z',
      points: 10,
    },
    'users/yahya-uid': {
      displayName: 'Yahya',
      total_points: 0,
      points: 0,
    },
    'users/admin-uid': {
      displayName: 'Admin Reviewer',
      email: 'admin@example.com',
    },
  };
}

let mockStore: Record<string, any> = initialStore();
let mockGenCounter = 0;

function mockResolveValue(value: any, existing: any): any {
  if (value !== null && typeof value === 'object' && value.__fv === 'increment') {
    return (typeof existing === 'number' ? existing : 0) + value.n;
  }
  if (value !== null && typeof value === 'object' && value.__fv === 'serverTimestamp') {
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => mockResolveValue(v, undefined));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = mockResolveValue(v, existing ? existing[k] : undefined);
    }
    return out;
  }
  return value;
}

function mockMakeDocRef(collectionName: string, docId: string): any {
  const path = `${collectionName}/${docId}`;
  return {
    __kind: 'doc',
    id: docId,
    path,
    collection: (subName: string) => ({
      doc: (...args: any[]) => {
        if (args.length > 0 && (args[0] === undefined || args[0] === null || args[0] === '')) {
          throw new Error(
            'Function doc() called with invalid data. Document path must be a non-empty string (found undefined id)',
          );
        }
        const subId = args.length > 0 ? String(args[0]) : `gen-${++mockGenCounter}`;
        return mockMakeDocRef(path + '/' + subName, subId);
      },
    }),
    get: async () => {
      const data = mockStore[path];
      return { exists: data !== undefined, data: () => data };
    },
  };
}

function mockMakeCollection(name: string): any {
  return {
    doc: (...args: any[]) => {
      // Mirror the real Admin SDK: an explicitly passed undefined id throws.
      // A call with no argument is the auto-id path used for ledger,
      // notification, and DLQ docs.
      if (args.length > 0 && (args[0] === undefined || args[0] === null || args[0] === '')) {
        throw new Error(
          'Function doc() called with invalid data. Document path must be a non-empty string (found undefined id)',
        );
      }
      const id = args.length > 0 ? String(args[0]) : `gen-${++mockGenCounter}`;
      return mockMakeDocRef(name, id);
    },
    where: () => ({ get: async () => ({ docs: [] }) }),
  };
}

const mockDb = {
  collection: (name: string) => mockMakeCollection(name),
  batch: () => ({
    update: (ref: any, data: any) => {
      mockBatchOps.push({ op: 'update', path: ref.path, data });
    },
    set: (ref: any, data: any, opts?: any) => {
      mockBatchOps.push({ op: 'set', path: ref.path, data, opts });
    },
    delete: (ref: any) => {
      mockBatchOps.push({ op: 'delete', path: ref.path });
    },
    commit: async () => {
      for (const op of mockBatchOps) {
        if (op.op === 'update') {
          const existing = mockStore[op.path] ?? {};
          mockStore[op.path] = { ...existing, ...mockResolveValue(op.data, existing) };
        } else if (op.op === 'set') {
          if (op.opts && op.opts.merge) {
            const existing = mockStore[op.path] ?? {};
            mockStore[op.path] = { ...existing, ...mockResolveValue(op.data, existing) };
          } else {
            mockStore[op.path] = mockResolveValue(op.data, undefined);
          }
        }
      }
    },
  }),
};

// --- Mocks (same shape as the repo API route tests) ------------------------

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

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDb,
}));

jest.mock('firebase-admin', () => ({
  firestore: {
    FieldValue: {
      serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
      increment: (n: number) => ({ __fv: 'increment', n }),
    },
  },
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({
    authenticated: true,
    user: { userId: 'admin-uid', role: 'admin', email: 'admin@example.com' },
  }),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(true),
  hasServerPermissionForUser: jest.fn().mockResolvedValue(true),
}));

import { PATCH } from '../../app/api/admin/universal-review/route';

function makeRequest(body: any): any {
  return { json: async () => body };
}

function approveDeliverableBRequest(): any {
  // Exactly what GenericInspector.handleAction('APPROVED') sends for this
  // inbox row: collection 'tasks', the task id, action 'approve', and the
  // POINTS TO AWARD value (10) from the inspector input.
  return makeRequest({
    collection: 'tasks',
    ids: ['YG2NEE1K'],
    action: 'approve',
    notes: '',
    points: 10,
    extraFields: { addToCompetitions: true },
  });
}

async function approveWithHangGuard(req: any): Promise<any> {
  const hangGuard = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('PATCH hung: did not settle within 5000ms')), 5000);
  });
  return Promise.race([PATCH(req), hangGuard]);
}

describe('PATCH /api/admin/universal-review TASK_REVIEW approval (Deliverable B, Yahya, YG2NEE1K)', () => {
  beforeEach(() => {
    mockStore = initialStore();
    mockBatchOps.length = 0;
    mockGenCounter = 0;
  });

  test('approving a TASK_REVIEW completes without hanging and returns success', async () => {
    const res: any = await approveWithHangGuard(approveDeliverableBRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test('approving awards the authorized 10 points to the task assignee and writes a ledger entry', async () => {
    const res: any = await approveWithHangGuard(approveDeliverableBRequest());
    expect(res.status).toBe(200);

    // Points must land on Yahya, the task assignee. No write may target
    // an undefined user doc (the unfixed handler throws before commit).
    const userWrite = mockBatchOps.find(
      (o) => o.op === 'set' && o.path === 'users/yahya-uid',
    );
    expect(userWrite).toBeDefined();
    expect(userWrite!.data.total_points).toEqual({ __fv: 'increment', n: 10 });
    expect(userWrite!.data.points).toEqual({ __fv: 'increment', n: 10 });
    expect(mockBatchOps.some((o) => o.path.includes('undefined'))).toBe(false);

    // Points ledger entry for the 10 awarded points.
    const ledgerWrite = mockBatchOps.find(
      (o) => o.op === 'set' && o.path.startsWith('points_ledger/'),
    );
    expect(ledgerWrite).toBeDefined();
    expect(ledgerWrite!.data.user_id).toBe('yahya-uid');
    expect(ledgerWrite!.data.task_id).toBe('YG2NEE1K');
    expect(ledgerWrite!.data.points_awarded).toBe(10);

    // Final stored balances reflect the award: 0 + 10.
    expect(mockStore['users/yahya-uid'].total_points).toBe(10);
    expect(mockStore['users/yahya-uid'].points).toBe(10);
  });

  test('the review ends up APPROVED, no longer pending', async () => {
    const res: any = await approveWithHangGuard(approveDeliverableBRequest());
    expect(res.status).toBe(200);

    const taskUpdate = mockBatchOps.find(
      (o) => o.op === 'update' && o.path === 'tasks/YG2NEE1K',
    );
    expect(taskUpdate).toBeDefined();
    // Status-semantics fix: the approval lands, and a TASK is stored
    // under the canonical terminal spelling 'completed' (the legacy
    // 'approved' stamp stranded tasks off boards and out of History).
    expect(taskUpdate!.data.status).toBe('completed');
    expect(taskUpdate!.data.pointsAwarded).toBe(10);
    expect(taskUpdate!.data.reviewedBy).toBe('admin-uid');

    // Final stored state: the review is approved, not submitted-for-review.
    expect(mockStore['tasks/YG2NEE1K'].status).toBe('completed');
    expect(mockStore['tasks/YG2NEE1K'].status).not.toBe('submitted-for-review');
    expect(mockStore['tasks/YG2NEE1K'].pointsAwarded).toBe(10);
  });
});
