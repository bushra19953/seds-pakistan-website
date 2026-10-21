/**
 * @jest-environment node
 *
 * Item 4: pointsAwarded / terminal-status guard for PATCH /api/submissions.
 *
 * CONTRACT UNDER TEST (spec section (e), submissions route suite):
 * - first approve: 200, points incremented once, one points_audit doc,
 *   pointsAwarded stored.
 * - second identical approve: HTTP 409, error 'Submission already
 *   reviewed', ZERO new batch ops, stored review stamps unchanged.
 * - status approved with NO pointsAwarded field: 409 (Clause 1).
 * - status pending but pointsAwarded > 0, on approve: 409 (Clause 2).
 * - first reject: 200, no points. Second reject and approve-after-reject:
 *   both 409.
 * - pending with pointsAwarded 0: proceeds normally.
 * - addToCompetitions double-approve creates exactly one competitions doc.
 *
 * PATTERN: same in-memory mock Firestore / batch harness as the
 * universal-review suites; the mock batch commit applies ops to
 * in-memory docs so a second PATCH reads the first PATCH's state.
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
  return {
    firestore: {
      FieldValue,
      Timestamp: { fromDate: (d: Date) => d },
    },
  };
});

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
      role: 'superadmin',
      user: {},
    },
  }),
}));

import { PATCH } from '../route';

function makeRequest(body: any): any {
  return { json: async () => body };
}

function seedSubmission(overrides: Record<string, any> = {}): void {
  mockDocs['submissions/sub-1'] = {
    userId: 'member-1',
    userDisplayName: 'Member One',
    type: 'resource',
    title: 'Useful Resource',
    url: 'https://example.com/resource',
    status: 'pending',
    ...overrides,
  };
  mockDocs['users/reviewer-1'] = { displayName: 'Reviewer Admin' };
  mockDocs['users/member-1'] = { displayName: 'Member One', points: 0 };
}

function auditSets(): Array<{ op: string; path: string; data?: any; opts?: any }> {
  return mockBatchOps.filter((o) => o.op === 'set' && o.path.startsWith('points_audit/'));
}

function competitionSets(): Array<{ op: string; path: string; data?: any; opts?: any }> {
  return mockBatchOps.filter((o) => o.op === 'set' && o.path.startsWith('competitions/'));
}

function notificationSets(): Array<{ op: string; path: string; data?: any; opts?: any }> {
  return mockBatchOps.filter((o) => o.op === 'set' && o.path.includes('/notifications/'));
}

const APPROVE = { submissionId: 'sub-1', action: 'approve', pointsToAward: 10 };
const REJECT = { submissionId: 'sub-1', action: 'reject' };

describe('PATCH /api/submissions points integrity (Item 4)', () => {
  beforeEach(() => {
    mockBatchOps.length = 0;
    mockDocs = {};
    autoIdCounter = 0;
    committedUpTo = 0;
    seedSubmission();
  });

  test('1. first approve: 200, points incremented once, one points_audit doc, pointsAwarded stored', async () => {
    const res: any = await PATCH(makeRequest(APPROVE));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.pointsAwarded).toBe(10);
    expect(mockDocs['users/member-1'].points).toBe(10);
    expect(mockDocs['users/member-1'].submissionsApprovedCount).toBe(1);
    expect(auditSets()).toHaveLength(1);
    expect(auditSets()[0].data.delta).toBe(10);
    expect(auditSets()[0].data.reason).toBe('submission_approved');
    expect(mockDocs['submissions/sub-1'].status).toBe('approved');
    expect(mockDocs['submissions/sub-1'].pointsAwarded).toBe(10);
  });

  test('2. second identical approve: 409, no new ops, stored review stamps unchanged', async () => {
    const first: any = await PATCH(makeRequest(APPROVE));
    expect(first.status).toBe(200);
    const storedAfterFirst = { ...mockDocs['submissions/sub-1'] };
    const opsAfterFirst = mockBatchOps.length;

    const second: any = await PATCH(makeRequest(APPROVE));
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.error).toBe('Submission already reviewed');
    expect(body.status).toBe('approved');
    expect(body.pointsAwarded).toBe(10);
    expect(mockBatchOps.slice(opsAfterFirst)).toHaveLength(0);
    expect(auditSets()).toHaveLength(1);
    expect(notificationSets()).toHaveLength(1);
    expect(mockDocs['users/member-1'].points).toBe(10);
    expect(mockDocs['users/member-1'].submissionsApprovedCount).toBe(1);
    expect(mockDocs['submissions/sub-1']).toEqual(storedAfterFirst);
  });

  test('3. approve on a doc with status approved but no pointsAwarded field: 409', async () => {
    seedSubmission({ status: 'approved' });
    delete mockDocs['submissions/sub-1'].pointsAwarded;
    const res: any = await PATCH(makeRequest(APPROVE));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('Submission already reviewed');
    expect(body.status).toBe('approved');
    expect(body.pointsAwarded).toBe(0);
    expect(mockBatchOps).toHaveLength(0);
    expect(mockDocs['users/member-1'].points).toBe(0);
  });

  test('4. approve on a pending doc with pointsAwarded 10: 409 via Clause 2, no increment', async () => {
    seedSubmission({ status: 'pending', pointsAwarded: 10 });
    const res: any = await PATCH(makeRequest(APPROVE));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('Submission already reviewed');
    expect(body.status).toBe('pending');
    expect(body.pointsAwarded).toBe(10);
    expect(mockBatchOps).toHaveLength(0);
    expect(mockDocs['users/member-1'].points).toBe(0);
    expect(auditSets()).toHaveLength(0);
  });

  test('5a. first reject: 200, no points, no audit', async () => {
    const res: any = await PATCH(makeRequest(REJECT));
    expect(res.status).toBe(200);
    expect(mockDocs['submissions/sub-1'].status).toBe('rejected');
    expect(mockDocs['submissions/sub-1'].pointsAwarded).toBe(0);
    expect(mockDocs['users/member-1'].points).toBe(0);
    expect(auditSets()).toHaveLength(0);
  });

  test('5b. second reject is 409', async () => {
    await PATCH(makeRequest(REJECT));
    const opsAfterFirst = mockBatchOps.length;
    const second: any = await PATCH(makeRequest(REJECT));
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe('Submission already reviewed');
    expect(mockBatchOps.slice(opsAfterFirst)).toHaveLength(0);
    expect(mockDocs['submissions/sub-1'].status).toBe('rejected');
  });

  test('5c. approve after reject is 409, no points awarded', async () => {
    await PATCH(makeRequest(REJECT));
    const second: any = await PATCH(makeRequest(APPROVE));
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe('Submission already reviewed');
    expect(mockDocs['submissions/sub-1'].status).toBe('rejected');
    expect(mockDocs['users/member-1'].points).toBe(0);
    expect(auditSets()).toHaveLength(0);
  });

  test('6. approve on a pending doc with pointsAwarded 0 proceeds normally', async () => {
    seedSubmission({ status: 'pending', pointsAwarded: 0 });
    const res: any = await PATCH(makeRequest(APPROVE));
    expect(res.status).toBe(200);
    expect(mockDocs['submissions/sub-1'].status).toBe('approved');
    expect(mockDocs['submissions/sub-1'].pointsAwarded).toBe(10);
    expect(mockDocs['users/member-1'].points).toBe(10);
    expect(auditSets()).toHaveLength(1);
  });

  test('7. addToCompetitions double-approve: exactly one competitions doc across both calls', async () => {
    seedSubmission({ type: 'competition' });
    const body = { submissionId: 'sub-1', action: 'approve', pointsToAward: 10, addToCompetitions: true };
    const first: any = await PATCH(makeRequest(body));
    expect(first.status).toBe(200);
    expect(competitionSets()).toHaveLength(1);
    const second: any = await PATCH(makeRequest(body));
    expect(second.status).toBe(409);
    expect(competitionSets()).toHaveLength(1);
    expect(mockDocs['users/member-1'].points).toBe(10);
  });
});
