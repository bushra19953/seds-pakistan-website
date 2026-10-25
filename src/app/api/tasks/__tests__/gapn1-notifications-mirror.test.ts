/**
 * @jest-environment node
 *
 * GAP-N1 closure — POST /api/tasks route-local createNotification.
 *
 * The route's local createNotification helper wrote
 * users/{uid}/notifications directly, bypassing the mirrored helper
 * modules. It now mirrors via the notifications seam after the Firestore
 * set succeeds. Harness adapted from contracts-current.test.ts (same
 * fake Firestore); the notification doc refs carry ids here so the
 * mirror target can be asserted.
 *
 * flag ON  -> one adapter setDoc per created notification, path
 *             users/{uid}/notifications (fs_group_notifications)
 * flag OFF -> zero adapter calls, response identical
 * adapter failure -> POST still 200 (mirror never throws)
 */

const HOLDER = 'holder-1';
const ASSIGNEE = 'assignee-1';

const mockForUser = jest.fn();
const mockCanValidate = jest.fn();
const mockGamification = jest.fn();

const addCalls: any[] = [];
const activityAdds: any[] = [];
const userSets: Array<{ uid: string; data: any; opts?: any }> = [];
const notifSets: Array<{ uid: string; id: string; data: any }> = [];
const projectSets: any[] = [];
const batchUpdates: Array<{ id: string; data: any }> = [];
const batchSets: any[] = [];
let batchCommits = 0;
const docDeletes: string[] = [];

type QState = { wheres: Array<[string, string, any]>; hasOrderBy: boolean; hasLimit: boolean; limitValue: number | null; hasStartAfter: boolean };
const EMPTY: QState = { wheres: [], hasOrderBy: false, hasLimit: false, limitValue: null, hasStartAfter: false };
const queryGetCalls: QState[] = [];
let tasksGetHandler: (state: QState) => Promise<any> = async () => ({ docs: [] });
let mockTaskData: any = null;
let mockTaskExists = true;

function fakeTs(ms: number) {
  return {
    toMillis: () => ms,
    toDate: () => new Date(ms),
    toISOString: () => new Date(ms).toISOString(),
    seconds: Math.floor(ms / 1000),
    nanoseconds: 0,
  };
}

function makeDoc(id: string, data: any) {
  return { id, data: () => data, get: (f: string) => data[f] };
}

function makeQuery(state: QState): any {
  const q: any = {
    where: (field: string, op: string, value: any) => makeQuery({ ...state, wheres: [...state.wheres, [field, op, value]] }),
    orderBy: () => makeQuery({ ...state, hasOrderBy: true }),
    limit: (n: number) => makeQuery({ ...state, hasLimit: true, limitValue: n }),
    startAfter: () => makeQuery({ ...state, hasStartAfter: true }),
    get: async () => { queryGetCalls.push(state); return tasksGetHandler(state); },
    doc: (id: string) => makeDocRef(id),
    add: async (data: any) => { addCalls.push(data); return { id: 'new-task-1' }; },
  };
  return q;
}

function makeDocRef(id: string): any {
  return {
    id,
    get: async () => ({ exists: mockTaskExists, data: () => mockTaskData, ref: { id } }),
    update: async (data: any) => { batchUpdates.push({ id, data }); },
    delete: async () => { docDeletes.push(id); },
    collection: () => ({
      doc: () => ({ set: async () => undefined }),
      add: async (data: any) => { activityAdds.push(data); return { id: 'act-1' }; },
    }),
  };
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'tasks') return makeQuery({ ...EMPTY });
    if (name === 'roles') {
      return { doc: () => ({ get: async () => ({ exists: true, data: () => ({ role: 'member', additionalRoles: [] }) }) }) };
    }
    if (name === 'users') {
      return {
        doc: (uid: string) => ({
          get: async () => ({ exists: true, data: () => ({ displayName: `User ${uid}`, email: `${uid}@example.com` }) }),
          set: async (data: any, opts?: any) => { userSets.push({ uid, data, opts }); },
          collection: () => ({
            doc: () => {
              const id = `notif-for-${uid}`;
              return { id, set: async (data: any) => { notifSets.push({ uid, id, data }); } };
            },
          }),
        }),
      };
    }
    if (name === 'projects') {
      return { doc: (pid: string) => ({ set: async (data: any, opts?: any) => { projectSets.push({ pid, data, opts }); } }) };
    }
    if (name === 'workflow_members') {
      return { doc: (mid: string) => ({ id: mid }) };
    }
    if (name === 'dlq_points_retry') {
      return { doc: () => ({ set: async () => undefined }) };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
  batch: () => ({
    set: (ref: any, data: any, opts?: any) => { batchSets.push({ ref, data, opts }); },
    update: (ref: any, data: any) => { batchUpdates.push({ id: ref?.id, data }); },
    delete: (ref: any) => { docDeletes.push(ref?.id); },
    commit: async () => { batchCommits++; },
  }),
};

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number; private payload: any;
    constructor(payload: any, init?: { status?: number }) { this.payload = payload; this.status = init?.status ?? 200; }
    static json(payload: any, init?: { status?: number }) { return new MockNextResponse(payload, init); }
    async json() { return this.payload; }
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
          now: () => fakeTs(1_700_000_000_000),
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
  class MockSessionError extends Error { statusCode: number; constructor(m: string, s = 401) { super(m); this.statusCode = s; } }
  return {
    extractBearerToken: () => 'test-bearer-token',
    verifyIdTokenString: async () => ({ uid: mockUid, email: 'holder@example.com' }),
    SessionError: MockSessionError,
  };
});
let mockUid = HOLDER;

jest.mock('@/lib/mailer', () => ({ sendEmailNotification: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/server/user-status', () => ({ validateUserStatus: jest.fn().mockResolvedValue({ isValid: true }) }));
jest.mock('@/lib/server/gamification-transaction', () => ({ executeGamificationTransaction: (...a: any[]) => mockGamification(...a) }));
jest.mock('@/lib/server/hierarchy-utils', () => ({ isManagerAbove: jest.fn().mockResolvedValue(false), getDirectSubordinates: jest.fn().mockResolvedValue([]) }));
jest.mock('@/lib/server/hierarchy', () => ({
  canValidateTask: (...a: any[]) => mockCanValidate(...a),
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
jest.mock('@/lib/server/validation-audit', () => ({ logValidationDecision: jest.fn().mockResolvedValue(undefined), logDeniedValidationAttempt: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/server/discipline/suspension', () => ({ suspensionBlock: jest.fn().mockResolvedValue(null) }));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(false),
  hasServerPermissionForUser: (...args: any[]) => mockForUser(...args),
  resolveUserRole: jest.fn().mockResolvedValue('member'),
  assertChapterAccess: jest.fn().mockResolvedValue({ allowed: true }),
}));

import { POST } from '../route';
import {
  setNotificationsSupaAdapterForTests,
  type NotificationsSupaAdapter,
} from '@/lib/server/notifications-supa-seam';

function makeRequest(body?: any, url = 'http://localhost/api/tasks'): any {
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

function makeAdapter(fail = false) {
  const calls = { setDoc: [] as any[], updateDoc: [] as any[], deleteDoc: [] as any[] };
  const adapter: NotificationsSupaAdapter = {
    setDoc: async (...args: any[]) => {
      calls.setDoc.push(args);
      if (fail) throw new Error('supa down');
    },
    updateDoc: async (...args: any[]) => { calls.updateDoc.push(args); },
    deleteDoc: async (...args: any[]) => { calls.deleteDoc.push(args); },
    listDocs: async () => [],
  };
  return { adapter, calls };
}

const futureDeadline = () => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
const CREATE_BODY = {
  title: 'Build thing', description: 'desc', points: 10,
  deadline: futureDeadline(), assigneeIds: ['zeta-user', ASSIGNEE],
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'debug').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  mockForUser.mockResolvedValue(true);
  mockUid = HOLDER;
  mockTaskData = null; mockTaskExists = true;
  addCalls.length = 0; activityAdds.length = 0; userSets.length = 0;
  notifSets.length = 0; projectSets.length = 0; batchUpdates.length = 0;
  batchSets.length = 0; batchCommits = 0; docDeletes.length = 0;
  queryGetCalls.length = 0;
  tasksGetHandler = async () => ({ docs: [] });
  mockGamification.mockResolvedValue({});
  mockCanValidate.mockResolvedValue({ allowed: true, via: 'role', depth: 0 });
  delete process.env.SUPA_SURFACES;
  setNotificationsSupaAdapterForTests(null);
});

afterEach(() => {
  delete process.env.SUPA_SURFACES;
  setNotificationsSupaAdapterForTests(null);
  jest.restoreAllMocks();
});

describe('GAP-N1: POST /api/tasks createNotification mirror', () => {
  it('flag ON: every created notification is mirrored with its user path and doc id', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    process.env.SUPA_SURFACES = 'notifications';
    const res: any = await POST(makeRequest({ ...CREATE_BODY, deadline: futureDeadline() }));
    expect(res.status).toBe(200);
    expect(notifSets.map((n) => n.uid).sort()).toEqual([ASSIGNEE, 'zeta-user']);
    expect(calls.setDoc).toHaveLength(notifSets.length);
    for (const call of calls.setDoc) {
      expect(call[2].type).toBe('task_assigned');
      expect(call[2]).toHaveProperty('timestamp'); // sentinel->ISO serialization is pinned in the seam suite (this harness's fake sentinel is a plain object)
    }
    const byPath = Object.fromEntries(calls.setDoc.map((c) => [c[0], c]));
    expect(byPath[`users/${ASSIGNEE}/notifications`][1]).toBe(`notif-for-${ASSIGNEE}`);
    expect(byPath['users/zeta-user/notifications'][1]).toBe('notif-for-zeta-user');
  });

  it('flag OFF: notifications written, zero mirror calls', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    const res: any = await POST(makeRequest({ ...CREATE_BODY, deadline: futureDeadline() }));
    expect(res.status).toBe(200);
    expect(notifSets).toHaveLength(2);
    expect(calls.setDoc).toHaveLength(0);
  });

  it('mirror failure: POST still succeeds with the contract body', async () => {
    const { adapter } = makeAdapter(true);
    setNotificationsSupaAdapterForTests(adapter);
    process.env.SUPA_SURFACES = 'notifications';
    const res: any = await POST(makeRequest({ ...CREATE_BODY, deadline: futureDeadline() }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, created: [{ id: 'new-task-1', assigneeId: ASSIGNEE }] });
  });
});
