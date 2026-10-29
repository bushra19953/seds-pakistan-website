/**
 * @jest-environment node
 *
 * Read-bleed incident hardening for GET /api/tasks (mocked only — zero
 * live reads):
 *  (a) When the Firestore authz legs throw RESOURCE_EXHAUSTED, a caller
 *      who can be authorized from non-Firestore evidence (the Supabase
 *      roles doc, via the same supaGetDoc seam the identity bundle
 *      uses) is served the seam task list instead of a 500.
 *  (a2) A throwing Firestore roles get (Leg A fallback, seam OFF) does
 *      not abort the request when the holder check still authorizes.
 *  (b) A caller with no grant anywhere is still denied — the transient
 *      fallback never turns an error into an allow.
 *  (b2) Transient failure with NO authorization evidence at all keeps
 *      the old semantics: 500 from the outer catch, not a blanket deny
 *      and not an allow.
 */

const HOLDER = 'holder-1';
const mockForUser = jest.fn();
const mockStaticPermission = jest.fn();
const mockSupaGetDoc = jest.fn();

function quotaError() {
  return Object.assign(new Error('Quota exceeded. RESOURCE_EXHAUSTED'), { code: 8 });
}

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
let fsRolesGetCount = 0;
let fsRolesGetImpl: () => Promise<any> = async () => ({ exists: true, data: () => ({ role: 'member' }) });
let fsTasksGetCount = 0;

function makeTasksQuery(): any {
  const q: any = {
    where: () => q,
    orderBy: () => q,
    limit: () => q,
    startAfter: () => q,
    get: async () => {
      fsTasksGetCount += 1;
      return { docs: fsDocs };
    },
    doc: (id: string) => ({
      id,
      get: async () => ({ exists: false, data: () => undefined }),
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
          get: async () => {
            fsRolesGetCount += 1;
            return fsRolesGetImpl();
          },
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
  hasServerPermission: (...args: any[]) => mockStaticPermission(...args),
  hasServerPermissionForUser: (...args: any[]) => mockForUser(...args),
  resolveUserRole: jest.fn().mockResolvedValue('member'),
  assertChapterAccess: jest.fn().mockResolvedValue({ allowed: true }),
}));
jest.mock('@/lib/server/supa-roles-seam', () => ({
  supaGetDoc: (...args: any[]) => mockSupaGetDoc(...args),
  supaListDocs: jest.fn(async () => null),
  supaMirrorSet: jest.fn(async () => false),
  supaMirrorUpdate: jest.fn(async () => false),
  supaMirrorDelete: jest.fn(async () => false),
  supaEnabledFor: jest.fn(async () => false),
  supaEnabledSyncFor: jest.fn(() => false),
  supaRolesPrimaryEnabled: jest.fn(async () => false),
  supaPrimarySet: jest.fn(async () => undefined),
  supaPrimaryUpdate: jest.fn(async () => undefined),
  supaPrimaryDelete: jest.fn(async () => undefined),
  __setSupaAdapterForTests: jest.fn(),
  ROLES_SUPA_SURFACE: 'roles',
}));

import { GET } from '../route';
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

const ORIGINAL_SUPA_SURFACES = process.env.SUPA_SURFACES;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'debug').mockImplementation(() => undefined);
  fsDocs = [];
  fsRolesGetCount = 0;
  fsTasksGetCount = 0;
  fsRolesGetImpl = async () => ({ exists: true, data: () => ({ role: 'member' }) });
  mockSupaGetDoc.mockResolvedValue(null);
  mockForUser.mockResolvedValue(false);
  mockStaticPermission.mockResolvedValue(false);
  delete process.env.SUPA_SURFACES;
  __resetTasksSupaAdapterForTests();
});

afterEach(() => {
  jest.restoreAllMocks();
  if (ORIGINAL_SUPA_SURFACES === undefined) delete process.env.SUPA_SURFACES;
  else process.env.SUPA_SURFACES = ORIGINAL_SUPA_SURFACES;
  __resetTasksSupaAdapterForTests();
});

describe('GET /api/tasks authz legs under RESOURCE_EXHAUSTED', () => {
  it('(a) Supa roles evidence authorizes and the seam list is served even when both Firestore authz legs throw quota', async () => {
    process.env.SUPA_SURFACES = 'tasks';
    const adapter = makeAdapter({
      listDocs: jest.fn(async () => [
        { id: 's1', title: 'Seam 1', status: 'pending', createdAt: '2026-10-25T07:51:00.000Z' },
      ]),
    });
    __setTasksSupaAdapterForTests(adapter);

    // Leg A: Supabase hit (a Firestore roles get would throw quota, and
    // must not even be attempted on a seam hit).
    mockSupaGetDoc.mockResolvedValue({ exists: true, data: { role: 'tasks_admin' } });
    fsRolesGetImpl = async () => { throw quotaError(); };
    // Leg B: the identity bundle's always-Firestore users leg throws quota.
    mockForUser.mockRejectedValue(quotaError());
    // Tasks-local fallback: the Supa role string grants via the
    // static-config path.
    mockStaticPermission.mockResolvedValue(true);

    const res: any = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: any) => i.id)).toEqual(['s1']);
    expect(mockSupaGetDoc).toHaveBeenCalledWith('roles', HOLDER);
    expect(fsRolesGetCount).toBe(0);
    expect(fsTasksGetCount).toBe(0);
    expect(mockStaticPermission).toHaveBeenCalledWith('tasks_admin', 'canManageTasks');
  });

  it('(a2) seam OFF: a quota throw from the Firestore roles get does not abort the request when the holder check authorizes', async () => {
    mockSupaGetDoc.mockResolvedValue(null); // flag OFF / unavailable -> Firestore fallback
    fsRolesGetImpl = async () => { throw quotaError(); };
    mockForUser.mockResolvedValue(true);
    fsDocs = [makeFsDoc('fs-a', 300)];

    const res: any = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: any) => i.id)).toEqual(['fs-a']);
    expect(fsRolesGetCount).toBe(1);
  });

  it('(b) a caller with no grant anywhere is still denied (normal holder decision)', async () => {
    mockSupaGetDoc.mockResolvedValue({ exists: true, data: { role: 'member' } });
    mockForUser.mockResolvedValue(false);

    const res: any = await GET(makeGetRequest());
    expect(res.status).toBe(403);
    expect(mockStaticPermission).not.toHaveBeenCalled();
  });

  it('(b) a caller with no grant anywhere is still denied when the holder check throws quota (fallback decision is no)', async () => {
    mockSupaGetDoc.mockResolvedValue({ exists: true, data: { role: 'member' } });
    mockForUser.mockRejectedValue(quotaError());
    mockStaticPermission.mockResolvedValue(false);

    const res: any = await GET(makeGetRequest());
    expect(res.status).toBe(403);
    expect(mockStaticPermission).toHaveBeenCalledWith('member', 'canManageTasks');
  });

  it('(b2) transient failure with no authorization evidence at all: 500 as before, not an allow and not a blanket deny', async () => {
    mockSupaGetDoc.mockResolvedValue({ exists: false, data: undefined });
    mockForUser.mockRejectedValue(quotaError());
    mockStaticPermission.mockResolvedValue(true); // must NOT be consulted: no role evidence

    const res: any = await GET(makeGetRequest());
    expect(res.status).toBe(500);
    expect(mockStaticPermission).not.toHaveBeenCalled();
  });
});
