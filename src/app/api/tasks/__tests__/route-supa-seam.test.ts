/**
 * @jest-environment node
 *
 * Supabase seam tests for GET/DELETE /api/tasks. Mocked adapter only —
 * zero live reads (no Firestore, no Supabase network).
 *
 * Covers:
 * - flag OFF: pure Firestore path, unchanged, even with an adapter present
 * - flag ON: GET list serves from the seam with normalized timestamps
 * - flag ON: the bounded degradation ladder applies to the seam (every
 *   executed seam query carries a limit), and total seam failure falls
 *   back to the Firestore ladder
 * - mirror-on-write on DELETE, including failure tolerance (a throwing
 *   mirror never fails the request)
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

function makeFsDoc(id: string, createdMs: number) {
  const data: any = {
    title: `Task ${id}`,
    status: 'pending',
    projectId: 'proj-1',
    createdAt: fakeTs(createdMs),
  };
  return { id, data: () => data, get: (field: string) => data[field] };
}

let fsDocs: any[] = [];
let fsQueryGetCount = 0;
let fsDeleteCalls: string[] = [];
let taskDocData: any = null;

function makeTasksQuery(): any {
  const q: any = {
    where: () => q,
    orderBy: () => q,
    limit: () => q,
    startAfter: () => q,
    get: async () => {
      fsQueryGetCount += 1;
      return { docs: fsDocs };
    },
    doc: (id: string) => ({
      id,
      get: async () => ({ exists: taskDocData != null, id, data: () => taskDocData }),
      delete: async () => {
        fsDeleteCalls.push(id);
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
    deleteDoc: jest.fn(async () => undefined),
    ...overrides,
  };
}

function makeGetRequest(url = 'http://localhost/api/tasks?status=pending&limit=50'): any {
  const req: any = {
    json: async () => ({}),
    nextUrl: new URL(url),
    url,
    headers: { get: () => null },
    cookies: { get: () => undefined },
  };
  req.clone = () => req;
  return req;
}

function makeDeleteRequest(taskId = 'task-9'): any {
  const req: any = {
    json: async () => ({ taskId }),
    nextUrl: new URL('http://localhost/api/tasks'),
    url: 'http://localhost/api/tasks',
    headers: { get: () => null },
    cookies: { get: () => undefined },
  };
  req.clone = () => req;
  return req;
}

const ORIGINAL_SUPA_SURFACES = process.env.SUPA_SURFACES;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'debug').mockImplementation(() => undefined);
  mockForUser.mockResolvedValue(true);
  fsDocs = [];
  fsQueryGetCount = 0;
  fsDeleteCalls = [];
  taskDocData = null;
  delete process.env.SUPA_SURFACES;
  __resetTasksSupaAdapterForTests();
});

afterEach(() => {
  jest.restoreAllMocks();
  if (ORIGINAL_SUPA_SURFACES === undefined) delete process.env.SUPA_SURFACES;
  else process.env.SUPA_SURFACES = ORIGINAL_SUPA_SURFACES;
  __resetTasksSupaAdapterForTests();
});

describe('GET /api/tasks Supabase seam', () => {
  it('flag OFF: pure Firestore path; the adapter is never touched', async () => {
    const adapter = makeAdapter();
    __setTasksSupaAdapterForTests(adapter);
    fsDocs = [makeFsDoc('fs-a', 300), makeFsDoc('fs-b', 100)];

    const res: any = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: any) => i.id)).toEqual(['fs-a', 'fs-b']);
    expect(body.nextCursor).toBe('100');
    expect(fsQueryGetCount).toBe(1);
    expect(adapter.listDocs).not.toHaveBeenCalled();
  });

  it('flag ON: serves the list from the seam and serializes jsonb timestamps to ISO strings', async () => {
    process.env.SUPA_SURFACES = 'tasks';
    const adapter = makeAdapter({
      listDocs: jest.fn(async () => [
        { id: 's1', title: 'Seam 1', status: 'pending', createdAt: '2026-10-25T07:51:00.000Z', deadline: '2026-11-01T00:00:00.000Z' },
        { id: 's2', title: 'Seam 2', status: 'pending', createdAt: '2026-10-24T07:51:00.000Z', deadline: null },
      ]),
    });
    __setTasksSupaAdapterForTests(adapter);
    fsDocs = [makeFsDoc('should-not-serve', 999)];

    const res: any = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: any) => i.id)).toEqual(['s1', 's2']);
    expect(body.items[0].createdAt).toBe('2026-10-25T07:51:00.000Z');
    expect(body.items[0].deadline).toBe('2026-11-01T00:00:00.000Z');
    expect(body.items[1].deadline).toBeNull();
    expect(body.nextCursor).toBe(String(Date.parse('2026-10-24T07:51:00.000Z')));
    expect(fsQueryGetCount).toBe(0);
    const [, opts] = (adapter.listDocs as jest.Mock).mock.calls[0];
    expect(opts.limit).toBe(50);
    expect(opts.where).toEqual([['status', '==', 'pending']]);
  });

  it('flag ON ladder: tier 1 fails -> tier 2 (filters + limit, in-memory sort); every seam query is bounded', async () => {
    process.env.SUPA_SURFACES = 'tasks';
    const calls: any[] = [];
    const adapter = makeAdapter({
      listDocs: jest.fn(async (_collection: string, opts: any) => {
        calls.push(opts);
        if (opts.orderBy) throw new Error('seam tier 1 unavailable');
        return [
          { id: 'old', status: 'pending', createdAt: '2026-10-20T00:00:00.000Z' },
          { id: 'new', status: 'pending', createdAt: '2026-10-25T00:00:00.000Z' },
        ];
      }),
    });
    __setTasksSupaAdapterForTests(adapter);

    const res: any = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: any) => i.id)).toEqual(['new', 'old']);
    expect(calls).toHaveLength(2);
    expect(calls.every((o) => typeof o.limit === 'number' && o.limit > 0)).toBe(true);
    expect(fsQueryGetCount).toBe(0);
  });

  it('flag ON: every seam tier fails -> the Firestore ladder serves instead', async () => {
    process.env.SUPA_SURFACES = 'tasks';
    const adapter = makeAdapter({
      listDocs: jest.fn(async () => {
        throw new Error('seam down');
      }),
    });
    __setTasksSupaAdapterForTests(adapter);
    fsDocs = [makeFsDoc('fs-fallback', 42)];

    const res: any = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: any) => i.id)).toEqual(['fs-fallback']);
    expect((adapter.listDocs as jest.Mock).mock.calls.length).toBe(3);
    expect((adapter.listDocs as jest.Mock).mock.calls.every((c) => typeof c[1].limit === 'number')).toBe(true);
    expect(fsQueryGetCount).toBe(1);
  });
});

describe('DELETE /api/tasks mirror-on-write', () => {
  beforeEach(() => {
    taskDocData = { title: 'Doomed', status: 'pending', assignerId: HOLDER, assigneeId: 'assignee-1' };
  });

  it('flag ON: deletes on Firestore and mirrors the delete', async () => {
    process.env.SUPA_SURFACES = 'tasks';
    const adapter = makeAdapter();
    __setTasksSupaAdapterForTests(adapter);

    const res: any = await DELETE(makeDeleteRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, deleted: 'task-9' });
    expect(fsDeleteCalls).toEqual(['task-9']);
    expect(adapter.deleteDoc).toHaveBeenCalledWith('tasks', 'task-9');
  });

  it('flag ON: a throwing mirror never fails the delete', async () => {
    process.env.SUPA_SURFACES = 'tasks';
    const adapter = makeAdapter({
      deleteDoc: jest.fn(async () => {
        throw new Error('mirror down');
      }),
    });
    __setTasksSupaAdapterForTests(adapter);

    const res: any = await DELETE(makeDeleteRequest());
    expect(res.status).toBe(200);
    expect(fsDeleteCalls).toEqual(['task-9']);
    expect(adapter.deleteDoc).toHaveBeenCalledTimes(1);
  });

  it('flag OFF: no mirror is attempted', async () => {
    const adapter = makeAdapter();
    __setTasksSupaAdapterForTests(adapter);

    const res: any = await DELETE(makeDeleteRequest());
    expect(res.status).toBe(200);
    expect(fsDeleteCalls).toEqual(['task-9']);
    expect(adapter.deleteDoc).not.toHaveBeenCalled();
  });
});
