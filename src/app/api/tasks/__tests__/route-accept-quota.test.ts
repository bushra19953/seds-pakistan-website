/**
 * @jest-environment node
 *
 * Mission-accept 500 regression (2026-10-30 incident): during a
 * Firestore READ-quota exhaustion, PATCH { action: 'accept' } on
 * /api/tasks returned 500 even though tasks and users are
 * Supabase-PRIMARY. Three legs of the acceptance handshake still read
 * Firestore uncaught:
 *  (L4) suspensionBlock's raw users/{uid} get — since fixed at the
 *       shared reader (lib/server/discipline/suspension.ts gained an
 *       opt-in seam-first read; the acceptance call site opts in —
 *       other callers keep byte-identical legacy behavior because the
 *       events routes pin their adapter-call profile in parity
 *       contracts). The REAL suspension module runs in this suite on
 *       purpose: the seam-first behavior under test lives there,
 *       driven through the mocked supa-roles-seam.
 *  (task read) the handler's raw taskRef.get() — now seam-first via
 *       the route seam's getTaskDocViaSeam.
 *  (L7) the mirror-on-write fetchers re-read the task from Firestore
 *       after the update; under tasks primacy a failed re-read
 *       RETHROWS out of mirrorTaskDocById, so a committed accept still
 *       answered 500 — now the mirrors consume an in-memory
 *       post-update doc.
 *
 * Tests 1, 2 and 4 FAIL on the pre-fix tree (500) and PASS after.
 * Test 3 pins the unchanged flag-OFF behavior (accept, idempotent
 * re-accept, decline).
 */

const CALLER = 'assignee-1';
const TASK_ID = 'task-accept-1';
const mockSupaGetDoc = jest.fn();
const mockForUser = jest.fn();
const mockStaticPermission = jest.fn();

function quotaError() {
  return Object.assign(new Error('Quota exceeded. RESOURCE_EXHAUSTED'), { code: 8 });
}

function fakeTs(ms: number) {
  return {
    toMillis: () => ms,
    toDate: () => new Date(ms),
    toISOString: () => new Date(ms).toISOString(),
    seconds: Math.floor(ms / 1000),
  };
}

/* ------------------------------------------------------- Firestore stub */

let fsAllQuota = false;
let fsUsersGetCount = 0;
let fsUsersGetImpl: (uid: string) => Promise<any> = async () => ({
  exists: true,
  data: () => ({ displayName: 'Fixture Assignee' }),
});
let fsTaskGetCount = 0;
let fsTaskGetScript: Array<'ok' | 'quota'> = [];
let fsTaskDoc: any = null;
let fsUpdates: any[] = [];
let fsActivityAdds: any[] = [];

const mockDb = {
  collection: (name: string) => {
    if (name === 'users') {
      return {
        doc: (uid: string) => ({
          get: async () => {
            fsUsersGetCount += 1;
            if (fsAllQuota) throw quotaError();
            return fsUsersGetImpl(uid);
          },
        }),
      };
    }
    if (name === 'tasks') {
      return {
        doc: (id: string) => ({
          id,
          get: async () => {
            fsTaskGetCount += 1;
            if (fsAllQuota) throw quotaError();
            const behavior = fsTaskGetScript.length ? fsTaskGetScript.shift() : 'ok';
            if (behavior === 'quota') throw quotaError();
            return { exists: !!fsTaskDoc, data: () => fsTaskDoc };
          },
          update: async (updates: any) => {
            fsUpdates.push(updates);
          },
          collection: () => ({
            add: async (doc: any) => {
              fsActivityAdds.push(doc);
              return { id: 'activity-1' };
            },
          }),
        }),
      };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
  batch: () => ({ set: () => undefined, update: () => undefined, delete: () => undefined, commit: async () => undefined }),
};

/* ------------------------------------------------------------ mocks */

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
    verifyIdTokenString: async () => ({ uid: CALLER, email: 'assignee@example.com' }),
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
// NOTE: '@/lib/server/discipline/suspension' is deliberately NOT
// mocked — the shared reader's seam-first behavior is under test.
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

import { PATCH } from '../route';
import { suspensionBlock } from '@/lib/server/discipline/suspension';
import {
  __setTasksSupaAdapterForTests,
  __resetTasksSupaAdapterForTests,
  type TasksSupaAdapter,
} from '@/lib/supa/seam-tasks-route';
import { __setWorkflowWriteMirrorLoaderForTests } from '@/lib/server/workflow-write-mirror';

/* ------------------------------------------------------------ fixtures */

function makeTasksAdapter(overrides: Partial<TasksSupaAdapter> = {}): TasksSupaAdapter {
  return {
    getDoc: jest.fn(async () => null),
    listDocs: jest.fn(async () => []),
    countDocs: jest.fn(async () => 0),
    setDoc: jest.fn(async () => undefined),
    updateDoc: jest.fn(async () => undefined),
    deleteDoc: jest.fn(async () => undefined),
    ...overrides,
  } as TasksSupaAdapter;
}

function seamTaskRow(): any {
  // Shape of an fs_tasks jsonb row as the adapter returns it:
  // { id, ...data } with timestamps as ISO strings.
  return {
    id: TASK_ID,
    title: 'Deploy & Test Dual-Nation Registration Portal',
    status: 'pending',
    assigneeId: CALLER,
    assigneeIds: [CALLER],
    assignerId: 'assigner-1',
    workflowId: 'wf-fixture',
    acceptanceStatus: 'pending-acceptance',
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
  };
}

function firestoreTaskDoc(): any {
  return {
    title: 'Deploy & Test Dual-Nation Registration Portal',
    status: 'pending',
    assigneeId: CALLER,
    assigneeIds: [CALLER],
    assignerId: 'assigner-1',
    workflowId: 'wf-fixture',
    acceptanceStatus: 'pending-acceptance',
    createdAt: fakeTs(Date.parse('2026-10-28T00:00:00.000Z')),
    updatedAt: fakeTs(Date.parse('2026-10-28T00:00:00.000Z')),
  };
}

function makeReq(body: any): any {
  const req: any = {
    json: async () => body,
    headers: { get: () => null },
    cookies: { get: () => undefined },
  };
  req.clone = () => req;
  return req;
}

/* ------------------------------------------------------------ lifecycle */

const ORIGINAL_ENV = {
  SUPA_SURFACES: process.env.SUPA_SURFACES,
  SUPA_PRIMARY: process.env.SUPA_PRIMARY,
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'debug').mockImplementation(() => undefined);
  fsAllQuota = false;
  fsUsersGetCount = 0;
  fsUsersGetImpl = async () => ({ exists: true, data: () => ({ displayName: 'Fixture Assignee' }) });
  fsTaskGetCount = 0;
  fsTaskGetScript = [];
  fsTaskDoc = null;
  fsUpdates = [];
  fsActivityAdds = [];
  mockSupaGetDoc.mockResolvedValue(null);
  mockForUser.mockResolvedValue(false);
  mockStaticPermission.mockResolvedValue(false);
  delete process.env.SUPA_SURFACES;
  delete process.env.SUPA_PRIMARY;
  __resetTasksSupaAdapterForTests();
  __setWorkflowWriteMirrorLoaderForTests(null);
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __resetTasksSupaAdapterForTests();
  __setWorkflowWriteMirrorLoaderForTests(null);
});

function seamEnvOn() {
  process.env.SUPA_SURFACES = 'tasks,users,workflows';
  process.env.SUPA_PRIMARY = 'tasks,users';
}

/* ------------------------------------------------------------ tests */

describe('PATCH accept under RESOURCE_EXHAUSTED', () => {
  it('(1) full outage: accept succeeds from the seams with ZERO Firestore reads, mirror lands from the in-memory doc', async () => {
    seamEnvOn();
    fsAllQuota = true; // every Firestore get throws code 8
    mockSupaGetDoc.mockImplementation(async (collection: string, id: string) =>
      collection === 'users' && id === CALLER
        ? { exists: true, data: { displayName: 'Fixture Assignee' } }
        : null
    );
    const tasksSetDoc = jest.fn(async () => undefined);
    __setTasksSupaAdapterForTests(
      makeTasksAdapter({
        getDoc: jest.fn(async () => seamTaskRow()),
        setDoc: tasksSetDoc as any,
      })
    );
    const wfSetDocCalls: any[] = [];
    __setWorkflowWriteMirrorLoaderForTests(async () => ({
      useSupa: (surface: string): boolean => surface === 'workflows',
      getSupaClient: () => ({ fake: true }),
      getSupaAdapter: () => ({
        getDoc: async () => null,
        listDocs: async () => [],
        countDocs: async () => 0,
        setDoc: async (collection: string, id: string, data: any) => {
          wfSetDocCalls.push({ collection, id, data });
          return { id, ...data };
        },
        updateDoc: async (collection: string, id: string, data: any) => ({ id, ...data }),
        deleteDoc: async () => undefined,
      }),
    }));

    const res: any = await PATCH(makeReq({ taskId: TASK_ID, action: 'accept' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.acceptanceStatus).toBe('accepted');
    // The whole point: not one Firestore read was needed.
    expect(fsUsersGetCount).toBe(0);
    expect(fsTaskGetCount).toBe(0);
    // The write itself still lands on Firestore (dual-write design).
    expect(fsUpdates).toHaveLength(1);
    expect(fsUpdates[0][`acceptanceBy.${CALLER}.status`]).toBe('accepted');
    expect(fsUpdates[0].acceptanceStatus).toBe('accepted');
    expect(fsUpdates[0].acceptedBy).toBe(CALLER);
    // Tasks mirror received the accepted state without a re-read.
    expect(tasksSetDoc).toHaveBeenCalledTimes(1);
    const mirrored = (tasksSetDoc.mock.calls as any)[0][2];
    expect(mirrored.acceptanceStatus).toBe('accepted');
    expect(mirrored.acceptanceBy[CALLER].status).toBe('accepted');
    // Union gate: the workflow-linked step mirrored under 'workflows' too.
    expect(wfSetDocCalls).toHaveLength(1);
    expect(wfSetDocCalls[0].data.acceptanceStatus).toBe('accepted');
    expect(wfSetDocCalls[0].data.acceptanceBy[CALLER].status).toBe('accepted');
  });

  it('(2) mirror re-read trap: seam read errors, Firestore first read OK, post-commit re-read quota-dead — still 200, no re-read', async () => {
    seamEnvOn();
    // Users seam unavailable -> suspension falls back to a healthy
    // Firestore users read (not suspended).
    mockSupaGetDoc.mockResolvedValue(null);
    // Tasks adapter errors on read (fallback to Firestore) but accepts
    // mirror writes.
    const tasksSetDoc = jest.fn(async () => undefined);
    __setTasksSupaAdapterForTests(
      makeTasksAdapter({
        getDoc: jest.fn(async () => {
          throw new Error('supabase unavailable');
        }),
        setDoc: tasksSetDoc as any,
      })
    );
    fsTaskDoc = firestoreTaskDoc();
    fsTaskGetScript = ['ok', 'quota']; // the pre-fix mirror re-read dies here

    const res: any = await PATCH(makeReq({ taskId: TASK_ID, action: 'accept' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.acceptanceStatus).toBe('accepted');
    // Exactly one Firestore task read (the fallback before-image);
    // the mirror consumed the in-memory post-update doc.
    expect(fsTaskGetCount).toBe(1);
    expect(fsUpdates).toHaveLength(1);
    expect(tasksSetDoc).toHaveBeenCalledTimes(1);
    const mirrored = (tasksSetDoc.mock.calls as any)[0][2];
    expect(mirrored.acceptanceStatus).toBe('accepted');
    expect(mirrored.acceptanceBy[CALLER].status).toBe('accepted');
  });

  it('(4) suspension is still enforced from the seam copy during the outage', async () => {
    seamEnvOn();
    fsAllQuota = true;
    mockSupaGetDoc.mockImplementation(async (collection: string, id: string) =>
      collection === 'users' && id === CALLER
        ? {
            exists: true,
            data: {
              privilegesSuspendedUntil: new Date(Date.now() + 3600_000).toISOString(),
              suspensionCaseId: 'case-9',
            },
          }
        : null
    );
    __setTasksSupaAdapterForTests(
      makeTasksAdapter({ getDoc: jest.fn(async () => seamTaskRow()) })
    );

    const res: any = await PATCH(makeReq({ taskId: TASK_ID, action: 'accept' }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe('SUSPENDED');
    expect(body.caseId).toBe('case-9');
    expect(fsUpdates).toHaveLength(0);
    expect(fsTaskGetCount).toBe(0);
  });
});

describe('suspensionBlock seam-first is opt-in at the shared reader (census L4)', () => {
  it('(5) default call sites never touch the seam (events parity contracts); the opted-in accept call does', async () => {
    // The seam copy says SUSPENDED; the Firestore doc (default stub)
    // says not suspended.
    mockSupaGetDoc.mockImplementation(async (collection: string, id: string) =>
      collection === 'users' && id === CALLER
        ? {
            exists: true,
            data: {
              privilegesSuspendedUntil: new Date(Date.now() + 3600_000).toISOString(),
              suspensionCaseId: 'case-9',
            },
          }
        : null
    );

    // Default (every pre-existing caller: handleUpdate, workflows,
    // delegate, event registrations): legacy Firestore behavior, and
    // the seam is not consulted at all.
    const legacy = await suspensionBlock(mockDb as any, CALLER, new Date());
    expect(legacy).toBeNull();
    expect(mockSupaGetDoc).not.toHaveBeenCalled();

    // Opted in (the acceptance handshake): the seam state rules.
    const optedIn = await suspensionBlock(mockDb as any, CALLER, new Date(), { seamFirst: true });
    expect(optedIn?.error).toBe('SUSPENDED');
    expect(optedIn?.caseId).toBe('case-9');
    expect(mockSupaGetDoc).toHaveBeenCalledWith('users', CALLER);
  });
});

describe('PATCH accept/decline — normal path (seam OFF) unchanged', () => {
  it('(3) accept writes the handshake fields, re-accept is idempotent, decline stamps declined', async () => {
    // Flag OFF: no env, no adapter. Firestore healthy.
    fsTaskDoc = firestoreTaskDoc();

    const res1: any = await PATCH(makeReq({ taskId: TASK_ID, action: 'accept' }));
    const body1 = await res1.json();
    expect(res1.status).toBe(200);
    expect(body1.acceptanceStatus).toBe('accepted');
    expect(fsUpdates).toHaveLength(1);
    expect(fsUpdates[0][`acceptanceBy.${CALLER}.status`]).toBe('accepted');
    expect(fsUpdates[0].acceptanceStatus).toBe('accepted');
    expect(fsUpdates[0].acceptedBy).toBe(CALLER);

    // Idempotent re-accept against the accepted state: no second write.
    fsTaskDoc = {
      ...firestoreTaskDoc(),
      acceptanceStatus: 'accepted',
      acceptedAt: fakeTs(Date.parse('2026-10-29T00:00:00.000Z')),
      acceptedBy: CALLER,
      acceptanceBy: {
        [CALLER]: {
          status: 'accepted',
          acceptedAt: fakeTs(Date.parse('2026-10-29T00:00:00.000Z')),
          acceptedBy: CALLER,
        },
      },
    };
    const res2: any = await PATCH(makeReq({ taskId: TASK_ID, action: 'accept' }));
    const body2 = await res2.json();
    expect(res2.status).toBe(200);
    expect(body2.already).toBe(true);
    expect(fsUpdates).toHaveLength(1);

    // Decline on a fresh pending doc.
    fsTaskDoc = firestoreTaskDoc();
    const res3: any = await PATCH(makeReq({ taskId: TASK_ID, action: 'decline' }));
    const body3 = await res3.json();
    expect(res3.status).toBe(200);
    expect(body3.acceptanceStatus).toBe('declined');
    expect(fsUpdates).toHaveLength(2);
    expect(fsUpdates[1][`acceptanceBy.${CALLER}.status`]).toBe('declined');
    expect(fsUpdates[1].acceptanceStatus).toBe('declined');
  });
});
