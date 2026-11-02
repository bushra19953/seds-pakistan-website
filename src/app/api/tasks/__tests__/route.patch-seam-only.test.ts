/**
 * MSG22 fix #2: PATCH /api/tasks save path for seam-only tasks.
 *
 * The 3 proof tasks exist only in the Supabase mirror (tasks is
 * SUPA_PRIMARY) with no Firestore doc. Before this fix, handleUpdate
 * read the task with a bare Firestore get and answered 404, so an
 * edit opened via the seam-first read could never be saved.
 *
 * Contract under test:
 *  (1) seam-only doc + simple field edit (the founder's deadline
 *      change: status sent back unchanged, no steps) commits through
 *      the adapter as the primary write (200, seamOnly: true), with
 *      the new deadline in the stored image, and NO Firestore batch
 *      update is attempted on the missing doc. The post-commit
 *      Firestore mirror is a merge-set on the doc ref.
 *  (2) seam-only doc + a status transition is refused LOUDLY (409,
 *      error_code task_seam_only_complex_edit) and nothing is
 *      written anywhere.
 *  (3) a doc present in BOTH stores keeps the exact legacy path:
 *      the Firestore batch performs the update (200, no seamOnly
 *      flag), proving the seam-first read did not reroute normal
 *      saves.
 */

const mockBatchOps: Array<{ op: string; path: string; data?: any; opts?: any }> = [];
const mockDocSets: Array<{ path: string; data: any; opts?: any }> = [];
const mockDocs: Record<string, any> = {};
const mockSeamStore: Record<string, any> = {};
const mockAdapterSetDoc = jest.fn(async (col: string, id: string, data: any) => {
  mockSeamStore[id] = { id, ...data };
});
const mockAdapter: any = {
  getDoc: jest.fn(async (_col: string, id: string) => mockSeamStore[id] ?? null),
  listDocs: jest.fn(async () => []),
  countDocs: jest.fn(async () => 0),
  setDoc: mockAdapterSetDoc,
  updateDoc: jest.fn(async () => undefined),
  deleteDoc: jest.fn(async () => undefined),
};

const mockDb = {
  collection: (name: string) => ({
    doc: (id?: string) => {
      const docId = id ?? 'generated-id';
      const path = `${name}/${docId}`;
      return {
        id: docId,
        path,
        get: async () => {
          const data = mockDocs[path];
          return { exists: data !== undefined, data: () => data };
        },
        set: async (data: any, opts?: any) => {
          mockDocSets.push({ path, data, opts });
          mockDocs[path] = { ...(mockDocs[path] || {}), ...data };
        },
      };
    },
    where: () => ({ get: async () => ({ docs: [] }) }),
  }),
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
    commit: async () => undefined,
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
          fromDate: (d: Date) => ({ __ts: 'fromDate', ms: d.getTime(), toDate: () => d }),
          fromMillis: (ms: number) => ({ __ts: 'fromMillis', ms, toDate: () => new Date(ms) }),
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
    verifyIdTokenString: async () => ({
      uid: 'admin-uid',
      role: 'admin',
      permissions: { manageTasks: true },
    }),
    SessionError: MockSessionError,
  };
});

jest.mock('@/lib/mailer', () => ({
  sendEmailNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/server/user-status', () => ({
  validateUserStatus: jest.fn().mockResolvedValue({ isValid: true }),
}));

jest.mock('@/lib/server/gamification-transaction', () => ({
  executeGamificationTransaction: jest.fn(),
}));

jest.mock('@/lib/server/hierarchy-utils', () => ({
  isManagerAbove: jest.fn().mockResolvedValue(false),
}));

jest.mock('@/lib/server/hierarchy', () => ({
  canValidateTask: jest.fn().mockResolvedValue({ allowed: true, reason: 'role', via: 'role', depth: 0 }),
  getValidatorChainUids: jest.fn().mockResolvedValue([]),
  resolveDisplayName: jest.fn().mockResolvedValue('Test User'),
}));

jest.mock('@/lib/server/validation-notifications', () => ({
  notifyValidatorsOnSubmission: jest.fn().mockResolvedValue(undefined),
  notifyOnDecision: jest.fn().mockResolvedValue(undefined),
  notifyAcceptanceRequest: jest.fn().mockResolvedValue(undefined),
  notifyChainOnDecline: jest.fn().mockResolvedValue(undefined),
  resolveValidatorSubmissionAlerts: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/server/validation-audit', () => ({
  logValidationDecision: jest.fn().mockResolvedValue(undefined),
  logDeniedValidationAttempt: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(true),
  hasServerPermissionForUser: jest.fn().mockResolvedValue(true),
  resolveUserRole: jest.fn().mockResolvedValue('admin'),
  assertChapterAccess: jest.fn().mockResolvedValue({ allowed: true }),
}));

jest.mock('@/lib/server/discipline/suspension', () => ({
  suspensionBlock: jest.fn().mockResolvedValue(null),
}));

jest.mock('@/lib/supa/seam-tasks-route', () => {
  const actual = jest.requireActual('@/lib/supa/seam-tasks-route');
  return {
    ...actual,
    getTaskDocViaSeam: jest.fn(async (id: string) => {
      const data = mockSeamStore[id];
      return data ? { exists: true, data: { ...data } } : { exists: false, data: null };
    }),
    resolveTasksSupaAdapter: jest.fn(async () => mockAdapter),
    tasksPrimaryActive: jest.fn(async () => true),
  };
});

import { PATCH } from '../route';
import { __setTasksSupaAdapterForTests } from '@/lib/supa/seam-tasks-route';

const GHOST_ID = 'lTJyJck1YWebBTTzh9qn';
const GHOST = {
  title: 'Email Premium Proof — Oct 25 (post-reset)',
  description: 'Proof that premium email delivery works',
  status: 'pending',
  assigneeId: 'member-uid',
  assigneeIds: ['member-uid'],
  assignerId: 'admin-uid',
  deadline: '2026-10-26T12:00:00.000Z',
  createdAt: '2026-10-25T10:00:00.000Z',
  updatedAt: '2026-10-25T10:00:00.000Z',
  points: 10,
  resources: [],
};

function makeRequest(body: any): any {
  const req: any = { json: async () => body };
  req.clone = () => req;
  return req;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBatchOps.length = 0;
  mockDocSets.length = 0;
  for (const k of Object.keys(mockDocs)) delete mockDocs[k];
  for (const k of Object.keys(mockSeamStore)) delete mockSeamStore[k];
  mockSeamStore[GHOST_ID] = { ...GHOST };
  process.env.SUPA_SURFACES = 'tasks';
  // The route's post-commit mirror helpers use the module-internal
  // resolver; point it at the same fake adapter.
  (__setTasksSupaAdapterForTests as any)(mockAdapter);
});

afterEach(() => {
  delete process.env.SUPA_SURFACES;
});

describe('PATCH /api/tasks seam-only save (MSG22 fix #2)', () => {
  it('(1) simple deadline edit on a seam-only doc commits through the primary store', async () => {
    const res: any = await PATCH(
      makeRequest({
        taskId: GHOST_ID,
        updates: {
          title: GHOST.title,
          description: GHOST.description,
          assigneeId: 'member-uid',
          assigneeIds: ['member-uid'],
          deadline: '2026-11-03T08:30:00.000Z',
          status: 'pending',
          points: 10,
          resources: [],
        },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.seamOnly).toBe(true);
    // Primary store now holds the new deadline.
    expect(mockSeamStore[GHOST_ID].deadline).toBe('2026-11-03T08:30:00.000Z');
    expect(mockSeamStore[GHOST_ID].title).toBe(GHOST.title);
    // No Firestore batch write was attempted on the missing doc.
    expect(mockBatchOps.filter((o) => o.path === `tasks/${GHOST_ID}`)).toHaveLength(0);
    // The post-commit mirror materialized the doc via a merge-set,
    // with the deadline converted to a Timestamp shape.
    const mirror = mockDocSets.find((s) => s.path === `tasks/${GHOST_ID}`);
    expect(mirror).toBeDefined();
    expect(mirror!.opts).toEqual({ merge: true });
    expect((mirror!.data.deadline as any).__ts).toBe('fromDate');
  });

  it('(2) status transition on a seam-only doc is refused loudly, nothing written', async () => {
    const res: any = await PATCH(
      makeRequest({
        taskId: GHOST_ID,
        updates: { status: 'in-progress', deadline: '2026-11-03T08:30:00.000Z' },
      })
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error_code).toBe('task_seam_only_complex_edit');
    expect(mockSeamStore[GHOST_ID].deadline).toBe(GHOST.deadline);
    expect(mockSeamStore[GHOST_ID].status).toBe('pending');
    expect(mockAdapterSetDoc).not.toHaveBeenCalled();
    expect(mockBatchOps).toHaveLength(0);
    expect(mockDocSets).toHaveLength(0);
  });

  it('(3) doc present in both stores keeps the legacy Firestore batch path', async () => {
    mockDocs['tasks/task-both'] = {
      title: 'Both-stores task',
      description: 'exists everywhere',
      status: 'pending',
      assigneeId: 'member-uid',
      assigneeIds: ['member-uid'],
      assignerId: 'admin-uid',
      points: 10,
    };
    mockSeamStore['task-both'] = { ...mockDocs['tasks/task-both'] };
    const res: any = await PATCH(
      makeRequest({
        taskId: 'task-both',
        updates: { deadline: '2026-11-03T08:30:00.000Z', status: 'pending' },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.seamOnly).toBeUndefined();
    const writes = mockBatchOps.filter(
      (o) => (o.op === 'update' || o.op === 'set') && o.path === 'tasks/task-both'
    );
    expect(writes.length).toBeGreaterThan(0);
  });
});
