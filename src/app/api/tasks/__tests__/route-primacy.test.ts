/**
 * @jest-environment node
 *
 * Cutover primacy route pins for /api/tasks (feat/supa-cut-tasks).
 * Mocked adapter + mocked Firestore — zero live reads.
 *
 * - DELETE primacy: with SUPA_SURFACES=tasks AND SUPA_PRIMARY=tasks,
 *   the adapter delete commits BEFORE the Firestore mirror delete; an
 *   adapter failure returns 500 and Firestore is never touched; a
 *   Firestore mirror failure after the primary commit still returns
 *   200. With SUPA_PRIMARY unset (dual-write), the pre-cutover order
 *   and failure tolerance hold (also pinned in route-supa-seam).
 * - GAP-T1-01 route pin: GET ?assigneeId=&status=pending&limit=2 over
 *   an over-bound fixture — the ON path returns only the in-bound
 *   pending doc; the doc beyond its leg bound is invisible even
 *   though it passes the filter (bound-before-filter, ratified).
 */

const HOLDER = 'holder-1';
const mockForUser = jest.fn();

function fakeTs(ms: number) {
  return {
    toMillis: () => ms,
    toDate: () => new Date(ms),
    seconds: Math.floor(ms / 1000),
  };
}

let callOrder: string[] = [];
let fsDeleteError: Error | null = null;
let taskDocData: any = null;

function makeTasksQuery(): any {
  const q: any = {
    where: () => q,
    orderBy: () => q,
    limit: () => q,
    startAfter: () => q,
    get: async () => ({ docs: [] }),
    doc: (id: string) => ({
      id,
      get: async () => ({ exists: taskDocData != null, id, data: () => taskDocData }),
      delete: async () => {
        callOrder.push('firestore-delete');
        if (fsDeleteError) throw fsDeleteError;
      },
      update: async () => undefined,
      collection: () => ({ add: async () => ({ id: 'activity-1' }) }),
    }),
  };
  return q;
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'tasks') return makeTasksQuery();
    if (name === 'roles') {
      return {
        doc: () => ({
          get: async () => ({ exists: true, data: () => ({ role: 'member', additionalRoles: [] }) }),
        }),
      };
    }
    if (name === 'users') {
      return {
        doc: () => ({
          get: async () => ({ exists: false, data: () => undefined }),
          set: async () => undefined,
        }),
      };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
  batch: () => ({ set: () => undefined, update: () => undefined, delete: () => undefined, commit: async () => undefined }),
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
    delete: () => ({ _methodName: 'deleteField' }),
    serverTimestamp: () => ({ _methodName: 'serverTimestamp' }),
    arrayUnion: (...vals: any[]) => ({ _methodName: 'arrayUnion', vals }),
    increment: (n: number) => ({ _methodName: 'increment', n }),
  };
  return {
    admin: {
      firestore: {
        Timestamp: {
          now: () => fakeTs(Date.now()),
          fromDate: (d: Date) => fakeTs(d.getTime()),
          fromMillis: (ms: number) => fakeTs(ms),
        },
        FieldValue,
      },
      messaging: () => ({ sendEachForMulticast: async () => ({ successCount: 0 }) }),
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
    verifyIdTokenString: async () => ({ uid: HOLDER, email: 'holder@example.com' }),
    SessionError: MockSessionError,
  };
});

jest.mock('@/lib/mailer', () => ({ sendEmailNotification: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/server/user-status', () => ({ validateUserStatus: jest.fn().mockResolvedValue({ isValid: true }) }));
jest.mock('@/lib/server/gamification-transaction', () => ({ executeGamificationTransaction: jest.fn() }));
jest.mock('@/lib/server/hierarchy-utils', () => ({
  isManagerAbove: jest.fn().mockResolvedValue(false),
  getDirectSubordinates: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/server/hierarchy', () => ({
  canValidateTask: jest.fn(),
  getValidatorChainUids: jest.fn().mockResolvedValue([]),
  resolveDisplayName: jest.fn().mockResolvedValue('Test User'),
}));
jest.mock('@/lib/server/validation-notifications', () => ({
  notifyValidatorsOnSubmission: jest.fn(),
  notifyOnDecision: jest.fn(),
  notifyAcceptanceRequest: jest.fn(),
  notifyChainOnDecline: jest.fn(),
  resolveValidatorSubmissionAlerts: jest.fn(),
}));
jest.mock('@/lib/server/validation-audit', () => ({
  logValidationDecision: jest.fn(),
  logDeniedValidationAttempt: jest.fn(),
}));
jest.mock('@/lib/server/discipline/suspension', () => ({ suspensionBlock: jest.fn().mockResolvedValue(null) }));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(false),
  hasServerPermissionForUser: (...args: any[]) => mockForUser(...args),
  resolveUserRole: jest.fn().mockResolvedValue('member'),
  assertChapterAccess: jest.fn().mockResolvedValue({ allowed: true }),
}));

import { GET, DELETE } from '../route';
import {
  __setTasksSupaAdapterForTests,
  __resetTasksSupaAdapterForTests,
  type TasksSupaAdapter,
} from '@/lib/supa/seam-tasks-route';

function makeAdapter(overrides: Partial<TasksSupaAdapter> = {}): TasksSupaAdapter {
  return {
    getDoc: jest.fn(async () => null),
    listDocs: jest.fn(async () => []),
    countDocs: jest.fn(async () => 0),
    setDoc: jest.fn(async () => undefined),
    updateDoc: jest.fn(async () => undefined),
    deleteDoc: jest.fn(async () => {
      callOrder.push('supa-delete');
    }),
    ...overrides,
  };
}

function makeRequest(url: string, body?: any): any {
  const req: any = {
    json: async () => body ?? {},
    nextUrl: new URL(url),
    url,
    headers: { get: () => null },
    cookies: { get: () => undefined },
  };
  req.clone = () => req;
  return req;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'debug').mockImplementation(() => undefined);
  mockForUser.mockResolvedValue(true);
  callOrder = [];
  fsDeleteError = null;
  taskDocData = { title: 'Doomed', status: 'pending', assignerId: HOLDER, assigneeId: 'assignee-1' };
  delete process.env.SUPA_SURFACES;
  delete process.env.SUPA_PRIMARY;
  __resetTasksSupaAdapterForTests();
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.SUPA_SURFACES;
  delete process.env.SUPA_PRIMARY;
  __resetTasksSupaAdapterForTests();
});

describe('DELETE /api/tasks write primacy', () => {
  it('primary: adapter delete commits BEFORE the Firestore mirror delete', async () => {
    process.env.SUPA_SURFACES = 'tasks';
    process.env.SUPA_PRIMARY = 'tasks';
    const adapter = makeAdapter();
    __setTasksSupaAdapterForTests(adapter);

    const res: any = await DELETE(makeRequest('http://localhost/api/tasks', { taskId: 'task-9' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, deleted: 'task-9' });
    expect(adapter.deleteDoc).toHaveBeenCalledWith('tasks', 'task-9');
    expect(callOrder).toEqual(['supa-delete', 'firestore-delete']);
  });

  it('primary: adapter failure -> 500 and Firestore is never touched', async () => {
    process.env.SUPA_SURFACES = 'tasks';
    process.env.SUPA_PRIMARY = 'tasks';
    const adapter = makeAdapter({
      deleteDoc: jest.fn(async () => {
        callOrder.push('supa-delete');
        throw new Error('supa down');
      }),
    });
    __setTasksSupaAdapterForTests(adapter);

    const res: any = await DELETE(makeRequest('http://localhost/api/tasks', { taskId: 'task-9' }));
    expect(res.status).toBe(500);
    expect(callOrder).toEqual(['supa-delete']);
  });

  it('primary: a Firestore mirror failure after the primary commit still returns 200', async () => {
    process.env.SUPA_SURFACES = 'tasks';
    process.env.SUPA_PRIMARY = 'tasks';
    fsDeleteError = new Error('firestore down');
    const adapter = makeAdapter();
    __setTasksSupaAdapterForTests(adapter);

    const res: any = await DELETE(makeRequest('http://localhost/api/tasks', { taskId: 'task-9' }));
    expect(res.status).toBe(200);
    expect(callOrder).toEqual(['supa-delete', 'firestore-delete']);
  });

  it('dual-write (SUPA_PRIMARY unset): pre-cutover order, Firestore first', async () => {
    process.env.SUPA_SURFACES = 'tasks';
    const adapter = makeAdapter();
    __setTasksSupaAdapterForTests(adapter);

    const res: any = await DELETE(makeRequest('http://localhost/api/tasks', { taskId: 'task-9' }));
    expect(res.status).toBe(200);
    expect(callOrder).toEqual(['firestore-delete', 'supa-delete']);
  });
});

describe('GAP-T1-01 route pin: bound-before-filter on the assignee union', () => {
  it('over-bound fixture: the pending doc beyond its leg bound is invisible on the ON path', async () => {
    process.env.SUPA_SURFACES = 'tasks';
    // Storage order on the assigneeId leg; the adapter enforces the
    // per-leg limit exactly as the real adapter's finishing does.
    const leg = [
      { id: 'a', title: 'A', status: 'pending', assigneeId: 'u1', createdAt: '2026-10-25T03:00:00.000Z' },
      { id: 'b', title: 'B', status: 'completed', assigneeId: 'u1', createdAt: '2026-10-25T02:00:00.000Z' },
      { id: 'c', title: 'C', status: 'pending', assigneeId: 'u1', createdAt: '2026-10-25T01:00:00.000Z' },
    ];
    const adapter = makeAdapter({
      listDocs: jest.fn(async (_c: string, opts: any) => {
        const field = opts.where?.[0]?.[0];
        if (field === 'assigneeId') return leg.slice(0, opts.limit);
        return [];
      }),
    });
    __setTasksSupaAdapterForTests(adapter);

    const res: any = await GET(
      makeRequest('http://localhost/api/tasks?assigneeId=u1&status=pending&limit=2'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Bound-before-filter: legs capped at 2 -> union {a,b} -> status
    // filter -> {a}. The OFF path (unbounded legs) would return
    // {a, c}; 'c' is the ratified GAP-T1-01 divergence.
    expect(body.items.map((i: any) => i.id)).toEqual(['a']);
    expect(body.count).toBe(1);
    for (const call of (adapter.listDocs as jest.Mock).mock.calls) {
      expect(call[1].limit).toBe(2);
    }
  });
});
