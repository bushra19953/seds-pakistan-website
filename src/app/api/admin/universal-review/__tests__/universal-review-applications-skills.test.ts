/**
 * Tests for the application skill sync in PATCH /api/admin/universal-review.
 *
 * CONTRACT UNDER TEST:
 * - approving an application reads applications/{uid}.skills (array of
 *   strings) and, for each name, finds or creates a doc in the skills
 *   collection matched by slug (created docs carry status 'active').
 * - the resolved skill doc ids are added to users/{uid}.skillIds via
 *   arrayUnion.
 * - approving twice is idempotent: no duplicate skill docs, no duplicate
 *   skillIds entries.
 * - reject never syncs skills.
 * - missing or empty skills is a no-op that does not fail the approval.
 *
 * PATTERN: follows universal-review-leave.test.ts. The real PATCH export is
 * exercised with a fully mocked Firestore, and the mock batch commit
 * applies ops to in-memory docs so a second approve reads the same state
 * as production.
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
            .filter(([path, data]) => path.startsWith(`${name}/`) && data && data[field] === value)
            .slice(0, n)
            .map(([path, data]) => ({ id: path.split('/').pop(), data: () => data }));
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

function seedApplication(appId: string, uid: string, overrides: Record<string, any> = {}): void {
  mockDocs[`applications/${appId}`] = {
    userId: uid,
    title: 'Induction Application',
    status: 'pending',
    skills: ['React', 'Python'],
    ...overrides,
  };
  mockDocs['users/reviewer-1'] = { displayName: 'Reviewer Admin' };
  mockDocs[`users/${uid}`] = { displayName: 'Applicant' };
}

function skillDocPaths(): string[] {
  return Object.keys(mockDocs).filter((p) => p.startsWith('skills/'));
}

function skillIdsOf(uid: string): any {
  return mockDocs[`users/${uid}`]?.skillIds;
}

const APPROVE_APP_1 = { collection: 'applications', ids: ['app-1'], action: 'approve' };

describe('PATCH /api/admin/universal-review application skill sync', () => {
  beforeEach(() => {
    mockBatchOps.length = 0;
    mockDocs = {};
    autoIdCounter = 0;
    committedUpTo = 0;
  });

  test('approve creates one skills doc per claimed skill with status active and slug from name', async () => {
    seedApplication('app-1', 'member-1');
    const res: any = await PATCH(makeRequest(APPROVE_APP_1));
    expect(res.status).toBe(200);

    const paths = skillDocPaths();
    expect(paths).toHaveLength(2);
    const bySlug = Object.fromEntries(paths.map((p) => [mockDocs[p].slug, mockDocs[p]]));
    expect(bySlug['react'].name).toBe('React');
    expect(bySlug['react'].status).toBe('active');
    expect(bySlug['python'].name).toBe('Python');
    expect(bySlug['python'].status).toBe('active');
    expect(bySlug['react'].createdAt).toBeDefined();
  });

  test('approve arrayUnions the created skill ids onto users/{uid}.skillIds', async () => {
    seedApplication('app-1', 'member-1');
    await PATCH(makeRequest(APPROVE_APP_1));

    const ids = skillIdsOf('member-1');
    expect(Array.isArray(ids)).toBe(true);
    expect(ids).toHaveLength(2);
    const docIds = skillDocPaths().map((p) => p.split('/')[1]);
    expect(new Set(ids)).toEqual(new Set(docIds));
  });

  test('approve still flips the application status to approved', async () => {
    seedApplication('app-1', 'member-1');
    const res: any = await PATCH(makeRequest(APPROVE_APP_1));
    expect(res.status).toBe(200);
    expect(mockDocs['applications/app-1'].status).toBe('approved');
    const body = await res.json();
    expect(body.skillsSynced).toBe(2);
  });

  test('an existing skill matched by slug is reused, never recreated', async () => {
    mockDocs['skills/existing-react'] = {
      name: 'React',
      slug: 'react',
      category: 'Frontend',
      status: 'active',
    };
    seedApplication('app-1', 'member-1');
    await PATCH(makeRequest(APPROVE_APP_1));

    const paths = skillDocPaths();
    expect(paths).toHaveLength(2);
    expect(paths).toContain('skills/existing-react');
    const ids = skillIdsOf('member-1');
    expect(ids).toContain('existing-react');
    expect(ids).toHaveLength(2);
  });

  test('second approve is idempotent: no new skill docs and no duplicated skillIds', async () => {
    seedApplication('app-1', 'member-1');
    await PATCH(makeRequest(APPROVE_APP_1));
    const idsAfterFirst = [...skillIdsOf('member-1')];
    const docsAfterFirst = skillDocPaths();

    const second: any = await PATCH(makeRequest(APPROVE_APP_1));
    expect(second.status).toBe(200);
    expect(skillDocPaths()).toEqual(docsAfterFirst);
    expect(skillIdsOf('member-1')).toEqual(idsAfterFirst);
    expect(mockDocs['applications/app-1'].status).toBe('approved');
  });

  test('reject never syncs skills', async () => {
    seedApplication('app-1', 'member-1');
    const res: any = await PATCH(
      makeRequest({ collection: 'applications', ids: ['app-1'], action: 'reject' }),
    );
    expect(res.status).toBe(200);
    expect(mockDocs['applications/app-1'].status).toBe('rejected');
    expect(skillDocPaths()).toHaveLength(0);
    expect(mockDocs['users/member-1']).not.toHaveProperty('skillIds');
  });

  test('approve with no skills field succeeds with no skill writes', async () => {
    seedApplication('app-1', 'member-1', { skills: undefined });
    delete mockDocs['applications/app-1'].skills;
    const res: any = await PATCH(makeRequest(APPROVE_APP_1));
    expect(res.status).toBe(200);
    expect(mockDocs['applications/app-1'].status).toBe('approved');
    expect(skillDocPaths()).toHaveLength(0);
    expect(mockDocs['users/member-1']).not.toHaveProperty('skillIds');
    const body = await res.json();
    expect(body.skillsSynced).toBe(0);
  });

  test('approve with empty or blank skill entries syncs nothing', async () => {
    seedApplication('app-1', 'member-1', { skills: ['', '   ', 42, null] });
    const res: any = await PATCH(makeRequest(APPROVE_APP_1));
    expect(res.status).toBe(200);
    expect(skillDocPaths()).toHaveLength(0);
    expect(mockDocs['users/member-1']).not.toHaveProperty('skillIds');
  });

  test('approve accepts a comma-separated string skills value', async () => {
    seedApplication('app-1', 'member-1', { skills: 'React, Python ,Rust' });
    await PATCH(makeRequest(APPROVE_APP_1));
    expect(skillDocPaths()).toHaveLength(3);
    expect(skillIdsOf('member-1')).toHaveLength(3);
  });

  test('duplicate names in one application produce one skill doc and one skillId', async () => {
    seedApplication('app-1', 'member-1', { skills: ['React', 'react', '  React  '] });
    await PATCH(makeRequest(APPROVE_APP_1));
    expect(skillDocPaths()).toHaveLength(1);
    expect(mockDocs[skillDocPaths()[0]].name).toBe('React');
    expect(skillIdsOf('member-1')).toHaveLength(1);
  });

  test('two applications in one request claiming the same new skill share one skills doc', async () => {
    seedApplication('app-1', 'member-1', { skills: ['React'] });
    seedApplication('app-2', 'member-2', { skills: ['React'] });
    const res: any = await PATCH(
      makeRequest({ collection: 'applications', ids: ['app-1', 'app-2'], action: 'approve' }),
    );
    expect(res.status).toBe(200);
    expect(skillDocPaths()).toHaveLength(1);
    const sharedId = skillDocPaths()[0].split('/')[1];
    expect(skillIdsOf('member-1')).toEqual([sharedId]);
    expect(skillIdsOf('member-2')).toEqual([sharedId]);
  });

  test('skill sync preserves skillIds the user already had', async () => {
    mockDocs['skills/existing-rust'] = { name: 'Rust', slug: 'rust', status: 'active' };
    seedApplication('app-1', 'member-1', { skills: ['React', 'Rust'] });
    mockDocs['users/member-1'].skillIds = ['existing-rust'];
    await PATCH(makeRequest(APPROVE_APP_1));
    const ids = skillIdsOf('member-1');
    expect(ids).toHaveLength(2);
    expect(ids).toContain('existing-rust');
  });
});
