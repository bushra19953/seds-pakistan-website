/**
 * @jest-environment node
 *
 * Family G parity tests for /api/admin/universal-review (G8/G9,
 * SPECIAL S-UNIV-1/2).
 *
 * The permission key is DYNAMIC: COLLECTION_PERMISSION_MAP[collection]
 * (submissions/leave_requests/applications -> canManageApplications,
 * form_responses -> canManageForms, tasks -> canManageTasks), and the
 * 403 message interpolates the key. The gate now resolves holder-scoped
 * via hasServerPermissionForUser(getDb(), auth.user.userId,
 * requiredPermission); the map, the key derivation (including the PATCH
 * leave-ref collection rewriting) and the interpolated messages are
 * unchanged.
 *
 * Mocked at the permissions boundary (the resolver's Firestore-shape
 * behaviour is pinned by the permissions suites and the meetings /
 * positions parity suites): the caller's PRIMARY role is the plain
 * catalog role `member`; state.grantedKeys models exactly the keys the
 * holder's custom grant supplies to hasServerPermissionForUser.
 */

const HOLDER = 'holder-1';

const state = {
  grantedKeys: new Set<string>(),
};

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

function applyData(existing: Record<string, any>, data: Record<string, any>): Record<string, any> {
  const next = { ...existing };
  for (const [k, v] of Object.entries(data)) next[k] = applyValue(next[k], v);
  return next;
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

function queryGet(name: string, filters: Array<[string, any]>) {
  const docs = Object.entries(mockDocs)
    .filter(([p, data]) => {
      const parts = p.split('/');
      return (
        parts.length === 2 &&
        parts[0] === name &&
        data &&
        filters.every(([f, v]) => data[f] === v)
      );
    })
    .map(([p, data]) => ({ id: p.split('/').pop() as string, data: () => data }));
  return { docs, empty: docs.length === 0 };
}

function makeQuery(name: string, filters: Array<[string, any]> = []): any {
  return {
    where: (field: string, _op: string, value: any) => makeQuery(name, [...filters, [field, value]]),
    orderBy: () => ({
      limit: () => ({ get: async () => queryGet(name, filters) }),
    }),
    limit: () => ({ get: async () => queryGet(name, filters) }),
    get: async () => queryGet(name, filters),
  };
}

const mockDb = {
  collection: (name: string) => ({
    ...makeQuery(name),
    doc: (id?: string) => makeDocRef(name, id),
    where: (field: string, op: string, value: any) => makeQuery(name, [[field, value]]),
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
      for (const op of mockBatchOps.slice(committedUpTo)) {
        if (op.op === 'set') {
          const base = op.opts?.merge ? (mockDocs[op.path] ?? {}) : {};
          mockDocs[op.path] = applyData(base, op.data ?? {});
        } else if (op.op === 'update') {
          mockDocs[op.path] = applyData(mockDocs[op.path] ?? {}, op.data ?? {});
        } else if (op.op === 'delete') {
          delete mockDocs[op.path];
        }
      }
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

jest.mock('@/lib/server/cadetship/create', () => ({
  queueCadetshipEnrolmentInBatch: jest.fn(async () => ({
    cadetshipId: 'cad-1',
    created: false,
    cohortId: null,
  })),
}));

jest.mock('@/lib/server/governance-settings', () => ({
  isPhase2Live: jest.fn(async () => false),
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDb,
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({
    authenticated: true,
    user: {
      user: { uid: HOLDER },
      userId: HOLDER,
      email: 'holder@example.test',
      displayName: 'Holder One',
      emailVerified: true,
      role: 'member',
    },
  }),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(false),
  hasServerPermissionForUser: jest.fn(
    async (_db: unknown, _uid: string, key: string) => state.grantedKeys.has(key),
  ),
}));

import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { GET, PATCH } from '../route';

const mockForUser = hasServerPermissionForUser as jest.Mock;

function getRequest(collection: string): any {
  return {
    url: `http://localhost/api/admin/universal-review?collection=${collection}&status=pending`,
  };
}

function patchRequest(body: any): any {
  return { json: async () => body };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockForUser.mockImplementation(
    async (_db: unknown, _uid: string, key: string) => state.grantedKeys.has(key),
  );
  state.grantedKeys = new Set();
  mockBatchOps.length = 0;
  mockDocs = {};
  autoIdCounter = 0;
  committedUpTo = 0;
  mockDocs[`users/${HOLDER}`] = { displayName: 'Holder One' };
  mockDocs['users/member-1'] = { displayName: 'Member One' };
  mockDocs['submissions/sub-1'] = { userId: 'member-1', title: 'Entry', type: 'resource', status: 'pending' };
  mockDocs['tasks/task-1'] = { assigneeId: 'member-1', title: 'Task One', status: 'pending' };
});

describe('GET /api/admin/universal-review dynamic-key parity (G8)', () => {
  it('holder with canManageApplications via custom grant reaches the submissions queue', async () => {
    state.grantedKeys = new Set(['canManageApplications']);
    const res: any = await GET(getRequest('submissions'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('sub-1');
    expect(mockForUser).toHaveBeenCalledWith(expect.anything(), HOLDER, 'canManageApplications');
  });

  it('holder with ONLY canManageTasks is denied for submissions with the interpolated canManageApplications message', async () => {
    state.grantedKeys = new Set(['canManageTasks']);
    const res: any = await GET(getRequest('submissions'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Forbidden: 'canManageApplications' access required for this collection",
    });
  });

  it('the same canManageTasks-only holder is allowed for the tasks collection (pins the dynamic key)', async () => {
    state.grantedKeys = new Set(['canManageTasks']);
    const res: any = await GET(getRequest('tasks'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(mockForUser).toHaveBeenCalledWith(expect.anything(), HOLDER, 'canManageTasks');
  });

  it('holder with no grants keeps the original 403 for tasks', async () => {
    const res: any = await GET(getRequest('tasks'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Forbidden: 'canManageTasks' access required for this collection",
    });
  });
});

describe('PATCH /api/admin/universal-review dynamic-key parity (G9)', () => {
  it('holder with canManageApplications via custom grant can review a submission', async () => {
    state.grantedKeys = new Set(['canManageApplications']);
    const res: any = await PATCH(
      patchRequest({ collection: 'submissions', ids: ['sub-1'], action: 'approve' }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(mockDocs['submissions/sub-1'].status).toBe('approved');
    expect(mockForUser).toHaveBeenCalledWith(expect.anything(), HOLDER, 'canManageApplications');
  });

  it('holder with ONLY canManageTasks is denied for submissions with the interpolated PATCH message', async () => {
    state.grantedKeys = new Set(['canManageTasks']);
    const res: any = await PATCH(
      patchRequest({ collection: 'submissions', ids: ['sub-1'], action: 'approve' }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Forbidden: 'canManageApplications' access required",
    });
    expect(mockDocs['submissions/sub-1'].status).toBe('pending');
  });

  it('the same canManageTasks-only holder can review a task', async () => {
    state.grantedKeys = new Set(['canManageTasks']);
    const res: any = await PATCH(
      patchRequest({ collection: 'tasks', ids: ['task-1'], action: 'approve' }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    // Canonical task spelling: inbox approval lands on 'completed'.
    expect(mockDocs['tasks/task-1'].status).toBe('completed');
  });
});
