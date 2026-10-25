/**
 * @jest-environment node
 *
 * Supabase seam integration for PATCH/GET /api/submissions
 * (tasks cluster, group 5).
 *
 * The route's Firestore behaviour is the product; the seam is mocked
 * here (its own behaviour is pinned in
 * src/lib/supa/__tests__/seam-submissions.test.ts with a mocked
 * ADAPTER). What this suite pins:
 * - flag OFF parity: with the seam reporting unavailable, responses
 *   and Firestore writes are exactly the pre-migration shapes (the
 *   pre-existing route.test.ts suite pins the same flows in depth).
 * - GET parity: submissions render with ISO timestamps produced by
 *   the unchanged .toDate() mapping.
 * - mirror-on-write: after a successful Firestore batch commit, the
 *   route hands the review decision to the seam mirror exactly once,
 *   with submission-vocabulary status literals ('approved' /
 *   'rejected' — NEVER 'completed'; that unification is for task docs
 *   and this route writes no task doc).
 * - a 409 repeat review never reaches the mirror (guard runs first).
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
    for (const v of value.vals) if (!base.includes(v)) base.push(v);
    return base;
  }
  return value;
}

function applyDataToDoc(existing: Record<string, any>, data: Record<string, any>): Record<string, any> {
  const next = { ...existing };
  for (const [key, value] of Object.entries(data)) {
    const applied = applyValue(next[key], value);
    if (applied === undefined && isSentinel(value, 'delete')) delete next[key];
    else next[key] = applied;
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

function makeCollection(name: string): any {
  const clauses: Array<[string, any]> = [];
  let limitN = 50;
  let orderField: string | null = null;
  const q: any = {
    doc: (id?: string) => makeDocRef(name, id),
    add: async (data: any) => {
      const ref = makeDocRef(name);
      mockBatchOps.push({ op: 'set', path: ref.path, data });
      return ref;
    },
    where: (field: string, _op: string, value: any) => {
      clauses.push([field, value]);
      return q;
    },
    orderBy: (field: string) => {
      orderField = field;
      return q;
    },
    limit: (n: number) => {
      limitN = n;
      return q;
    },
    get: async () => {
      let entries = Object.entries(mockDocs).filter(([p]) => {
        if (!p.startsWith(`${name}/`)) return false;
        return !p.slice(name.length + 1).includes('/');
      });
      for (const [field, value] of clauses) {
        entries = entries.filter(([, d]) => d[field] === value);
      }
      if (orderField) {
        const f = orderField;
        entries.sort((a, b) => {
          const av = a[1][f]?.toDate ? a[1][f].toDate().getTime() : 0;
          const bv = b[1][f]?.toDate ? b[1][f].toDate().getTime() : 0;
          return bv - av;
        });
      }
      const docs = entries.slice(0, limitN).map(([p, d]) => ({
        id: p.slice(name.length + 1),
        data: () => d,
      }));
      return { empty: docs.length === 0, docs };
    },
  };
  return q;
}

const mockDb = {
  collection: (name: string) => makeCollection(name),
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
      Timestamp: { fromDate: (d: Date) => ({ toDate: () => d }) },
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

// The seam is mocked at the module boundary: route tests assert the
// CALL, seam tests assert the behaviour behind it.
const mockMirror = jest.fn(async (_payload: any) => true);
jest.mock('@/lib/supa/seam-submissions', () => ({
  mirrorSubmissionReview: (payload: any) => mockMirror(payload),
}));

import { GET, PATCH } from '../route';

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

describe('PATCH /api/submissions — seam mirror-on-write', () => {
  beforeEach(() => {
    mockBatchOps.length = 0;
    mockDocs = {};
    autoIdCounter = 0;
    committedUpTo = 0;
    mockMirror.mockClear();
    seedSubmission();
  });

  test('approve: 200 unchanged shape, mirror called once with approved decision + audit payload', async () => {
    const res: any = await PATCH({ json: async () => ({ submissionId: 'sub-1', action: 'approve', pointsToAward: 10 }) } as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, action: 'approve', pointsAwarded: 10, linkedCompetitionId: null });
    expect(mockDocs['submissions/sub-1'].status).toBe('approved');
    expect(mockDocs['users/member-1'].points).toBe(10);

    expect(mockMirror).toHaveBeenCalledTimes(1);
    const payload = mockMirror.mock.calls[0][0];
    expect(payload.submissionId).toBe('sub-1');
    expect(payload.status).toBe('approved');
    expect(payload.pointsAwarded).toBe(10);
    expect(payload.reviewedBy).toBe('reviewer-1');
    expect(payload.reviewerDisplayName).toBe('Reviewer Admin');
    expect(typeof payload.reviewedAtIso).toBe('string');
    expect(payload.linkedCompetitionId).toBeNull();
    expect(payload.competition).toBeNull();
    expect(payload.auditId).toBeTruthy();
    expect(payload.audit).toMatchObject({
      userId: 'member-1',
      delta: 10,
      reason: 'submission_approved',
      submissionId: 'sub-1',
      actorId: 'reviewer-1',
    });
  });

  test('reject: mirror carries rejected status, zero points, no audit/competition', async () => {
    const res: any = await PATCH({ json: async () => ({ submissionId: 'sub-1', action: 'reject', reviewNotes: 'No' }) } as any);
    expect(res.status).toBe(200);
    expect(mockDocs['submissions/sub-1'].status).toBe('rejected');
    expect(mockMirror).toHaveBeenCalledTimes(1);
    const payload = mockMirror.mock.calls[0][0];
    expect(payload.status).toBe('rejected');
    expect(payload.pointsAwarded).toBe(0);
    expect(payload.reviewNotes).toBe('No');
    expect(payload.auditId).toBeNull();
    expect(payload.audit).toBeNull();
    expect(payload.linkedCompetitionId).toBeNull();
  });

  test('approve + addToCompetitions: mirror carries the linked competition id and payload', async () => {
    seedSubmission({ type: 'competition' });
    const res: any = await PATCH({
      json: async () => ({ submissionId: 'sub-1', action: 'approve', pointsToAward: 10, addToCompetitions: true }),
    } as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.linkedCompetitionId).toBeTruthy();
    expect(mockMirror).toHaveBeenCalledTimes(1);
    const payload = mockMirror.mock.calls[0][0];
    expect(payload.linkedCompetitionId).toBe(body.linkedCompetitionId);
    expect(payload.competition).toMatchObject({
      title: 'Useful Resource',
      sourceSubmissionId: 'sub-1',
      status: 'active',
      submittedBy: 'member-1',
    });
  });

  test('repeat approve: 409 from the guard, mirror NOT called a second time', async () => {
    const first: any = await PATCH({ json: async () => ({ submissionId: 'sub-1', action: 'approve', pointsToAward: 10 }) } as any);
    expect(first.status).toBe(200);
    expect(mockMirror).toHaveBeenCalledTimes(1);
    const second: any = await PATCH({ json: async () => ({ submissionId: 'sub-1', action: 'approve', pointsToAward: 10 }) } as any);
    expect(second.status).toBe(409);
    expect(mockMirror).toHaveBeenCalledTimes(1);
  });

  test('mirror result never changes the response (seam resolves false)', async () => {
    mockMirror.mockResolvedValueOnce(false as any);
    const res: any = await PATCH({ json: async () => ({ submissionId: 'sub-1', action: 'approve', pointsToAward: 10 }) } as any);
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });
});

describe('GET /api/submissions — flag OFF parity shape', () => {
  beforeEach(() => {
    mockBatchOps.length = 0;
    mockDocs = {};
    autoIdCounter = 0;
    committedUpTo = 0;
    mockMirror.mockClear();
    seedSubmission({
      submittedAt: { toDate: () => new Date('2026-01-02T03:04:05Z') },
      reviewedAt: { toDate: () => new Date('2026-01-03T03:04:05Z') },
      deadline: { toDate: () => new Date('2026-06-07T08:09:10Z') },
    });
  });

  test('lists submissions with .toDate() timestamps rendered as ISO strings', async () => {
    const res: any = await GET({ url: 'http://localhost/api/submissions?status=all' } as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.count).toBe(1);
    expect(body.submissions[0]).toMatchObject({
      id: 'sub-1',
      status: 'pending',
      submittedAt: '2026-01-02T03:04:05.000Z',
      reviewedAt: '2026-01-03T03:04:05.000Z',
      deadline: '2026-06-07T08:09:10.000Z',
    });
    expect(mockMirror).not.toHaveBeenCalled();
  });
});
