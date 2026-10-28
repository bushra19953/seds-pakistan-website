/**
 * @jest-environment node
 *
 * BEHAVIOR CONTRACTS — tasks cluster, group 1 surface: /api/tasks
 * (src/app/api/tasks/route.ts), recorded from the CURRENT Firestore
 * implementation at feat/integration-wave3 @ 4d5a1e16, ahead of the
 * Supabase migration (feat/supa-tasks-1). The Supabase seam
 * (src/lib/supa/seam-*.ts, useSupa('tasks'), default OFF, Firestore
 * fallback) must keep EVERY contract below byte-identical.
 *
 * Contract inventory:
 *   C-LIST-01  GET tier-1 success body: { ok:true, items, nextCursor,
 *              count } where count === items.length and nextCursor is
 *              String(createdAt.toMillis()) of the LAST item (null
 *              when the last doc has no Timestamp createdAt).
 *   C-LIST-02  Item shape: { id, ...storedData } with exactly the seven
 *              timestamp fields deadline, individualDeadline, createdAt,
 *              updatedAt, completedAt, releasedAt, submittedAt REPLACED
 *              by ISO strings (or null when absent). No other field is
 *              transformed. NOTE the spread order is { id, ...data,
 *              ...serialized }: a stored rogue `id` field inside the
 *              document data would OVERRIDE the document id in the
 *              response (same order as the client helpers). Pinned
 *              as-is — a seam that "fixes" the order is drift.
 *   C-LIST-03  Limit clamping: limit param is clamped to [1, 500],
 *              default 100; the executed tier-1 query carries exactly
 *              the clamped limit.
 *   C-LIST-04  Tier parity: the SAME fixture served by tier 1, tier 2
 *              (filters+limit, in-memory createdAt-desc sort) and
 *              tier 3 (orderBy+limit, no filters) yields deep-equal
 *              item arrays. (Tier mechanics themselves are pinned by
 *              route-list-fallback.test.ts; this pins shape parity.)
 *   C-LIST-05  All tiers failing -> 500 { error:'Internal Server
 *              Error', details } and every executed query was bounded.
 *   C-LIST-06  Assignee branch (assigneeId param): union of
 *              assigneeId== and assigneeIds array-contains, deduped by
 *              doc id, status/project filtered IN MEMORY, createdAt
 *              desc, sliced to limitParam, nextCursor = last page
 *              item's createdAt ms (null when 0). HAZARD PINNED: the
 *              two underlying .get() calls carry NO limit today; the
 *              bound exists only as the in-memory slice. A seam that
 *              forwards these as listDocs without a limit reproduces
 *              an unbounded read — see CONTRACTS.md GAP-T1-01.
 *   C-CREATE-01 POST success: 200 { success:true, created:[{ id,
 *              assigneeId: PRIMARY }] } where PRIMARY is the first of
 *              the SORTED, deduped assignee set (not request order).
 *   C-CREATE-02 POST side effects (exactly): one tasks.add with the
 *              shared doc (assigneeId=primary, assigneeIds=sorted set,
 *              dedupeKey, acceptanceStatus 'pending-acceptance',
 *              acceptanceBy seeded per assignee, serverTimestamp
 *              createdAt/updatedAt sentinels); one activity add
 *              { type:'create' }; per-assignee users/{uid} set-merge
 *              { tasksAssignedCount: increment(1),
 *              lastTaskAssignedAt: serverTimestamp }; per-assignee
 *              in-app notification write (users/{uid}/notifications).
 *   C-CREATE-03 POST dedupe: an identical create inside 60s returns
 *              200 { success:true, created:[{ id: EXISTING,
 *              assigneeId: primary }], deduped:true } and performs NO
 *              second tasks.add. The dedupe probe query is
 *              where('dedupeKey','==',key).limit(5) — bounded.
 *   C-CREATE-04 POST validation: 403 body for no grant; 400
 *              { error:'Invalid request', details } for schema failure;
 *              400 { error:'Deadline must be in the future' } for a
 *              past deadline.
 *   C-UPD-01   PATCH plain update: 200 { ok:true, taskId,
 *              badgeAwarded:false, pointsAwardedTotal:0,
 *              completedOnTime:false, transitionedToCompleted:false,
 *              taskBefore, taskAfter, uid } — taskAfter is
 *              { ...taskBefore, ...updatesToApply } with updatedAt
 *              stamped server-side.
 *   C-UPD-02   PATCH submit-for-review (assignee, report present):
 *              200, and the persisted update carries submittedBy =
 *              caller uid and a submittedAt Timestamp stamp; prior
 *              decision stamps are deleted (FieldValue.delete).
 *   C-UPD-03   PATCH changes-requested WITHOUT feedback_text: 400
 *              { error:'Feedback text is mandatory for requesting
 *              changes' } — before any write.
 *   C-UPD-04   PATCH submit-for-review with NO report (stored or
 *              incoming): 400 { error: 'A report is required before
 *              transmitting. Please write your report before
 *              submitting for review.' }.
 *   C-UPD-05   PATCH completion (validator allowed): 200 { ok:true,
 *              taskId, badgeAwarded:false,
 *              transitionedToCompleted:true, taskBefore, taskAfter,
 *              uid } — NOTE the shape DIFFERS from C-UPD-01: there are
 *              NO pointsAwardedTotal / completedOnTime keys on the
 *              completion path, and taskAfter merges the gamification
 *              transaction result over the update. Pin both shapes;
 *              a seam must not "normalize" them into one.
 *   C-UPD-06   PATCH self-validation: 403 { error:'Forbidden: you
 *              cannot validate your own submission' }.
 *   C-DEL-01   DELETE success: 200 { ok:true, deleted: taskId, uid }
 *              plus users/{assigneeId} set-merge
 *              { tasksAssignedCount: increment(-1) } (and
 *              tasksCompletedCount increment(-1) iff the task was
 *              completed).
 *   C-DEL-02   DELETE guards: missing taskId -> 400; unknown task ->
 *              404 { error:'Task not found' }; neither manager nor
 *              assigner -> 403 { error:'Forbidden: you do not have
 *              permission to delete this task' }.
 *   C-TS-01    Timestamp drift trap: on the Firestore path the seven
 *              serialized fields are ISO strings derived from
 *              Timestamp.toDate(); a stored { seconds } shape is also
 *              converted. A seam returning jsonb rows must produce
 *              the IDENTICAL strings — raw { seconds, nanoseconds }
 *              objects or epoch numbers in these fields are drift.
 */

const HOLDER = 'holder-1';
const ASSIGNEE = 'assignee-1';

const mockForUser = jest.fn();
const mockCanValidate = jest.fn();
const mockGamification = jest.fn();

/* ------------------------------------------------ recorded writes */
const addCalls: any[] = [];
const activityAdds: any[] = [];
const userSets: Array<{ uid: string; data: any; opts?: any }> = [];
const notifSets: Array<{ uid: string; data: any }> = [];
const projectSets: any[] = [];
const batchUpdates: Array<{ id: string; data: any }> = [];
const batchSets: any[] = [];
let batchCommits = 0;
const docDeletes: string[] = [];

/* ------------------------------------------------- query harness */
type QState = { wheres: Array<[string, string, any]>; hasOrderBy: boolean; hasLimit: boolean; limitValue: number | null; hasStartAfter: boolean };
const EMPTY: QState = { wheres: [], hasOrderBy: false, hasLimit: false, limitValue: null, hasStartAfter: false };
const queryGetCalls: QState[] = [];
let tasksGetHandler: (state: QState) => Promise<any> = async () => ({ docs: [] });

let mockTaskData: any = null; // data() of tasks/{id} for doc gets
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
          collection: () => ({ doc: () => ({ set: async (data: any) => { notifSets.push({ uid, data }); } }) }),
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

// Contact doorway (contact-gating fix): recipient addresses resolve
// from the gated contact record, not the public user doc. The fake
// user docs in this suite carry `${uid}@example.com`, so the doorway
// mock resolves the same addresses the doc reads used to supply.
jest.mock('@/lib/server/user-contact', () => ({
  resolveUserEmail: jest.fn(async (_db: any, uid: string) => `${uid}@example.com`),
  resolveUserEmails: jest.fn(async (_db: any, uids: string[]) => new Map(uids.map((u: string) => [u, `${u}@example.com`]))),
  getUserContact: jest.fn(async () => null),
  getUserContacts: jest.fn(async () => new Map()),
  setUserContact: jest.fn(async () => undefined),
  clearUserContact: jest.fn(async () => undefined),
  stripContactFields: (r: any) => r,
}));
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
}));
jest.mock('@/lib/server/validation-audit', () => ({ logValidationDecision: jest.fn().mockResolvedValue(undefined), logDeniedValidationAttempt: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/server/discipline/suspension', () => ({ suspensionBlock: jest.fn().mockResolvedValue(null) }));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(false),
  hasServerPermissionForUser: (...args: any[]) => mockForUser(...args),
  resolveUserRole: jest.fn().mockResolvedValue('member'),
  assertChapterAccess: jest.fn().mockResolvedValue({ allowed: true }),
}));

import { GET, POST, PATCH, DELETE } from '../route';

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

const CREATED_MS = 1_700_000_100_000;
const DEADLINE_MS = 1_800_000_000_000;

function listFixture() {
  return [
    makeDoc('t-new', { title: 'New', status: 'pending', createdAt: fakeTs(CREATED_MS + 2000), deadline: fakeTs(DEADLINE_MS), points: 5 }),
    makeDoc('t-old', { title: 'Old', status: 'pending', createdAt: fakeTs(CREATED_MS), deadline: { seconds: Math.floor(DEADLINE_MS / 1000) } }),
  ];
}

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
});

afterEach(() => { jest.restoreAllMocks(); });

/* ------------------------------------------------------------ GET */
describe('C-LIST: GET /api/tasks contracts', () => {
  it('C-LIST-01/02/03: tier-1 body, item shape, ISO serialization, nextCursor, default limit 100', async () => {
    tasksGetHandler = async () => ({ docs: listFixture() });
    const res: any = await GET(makeRequest(undefined, 'http://localhost/api/tasks?status=pending'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['count', 'items', 'nextCursor', 'ok']);
    expect(body.ok).toBe(true);
    expect(body.count).toBe(2);
    expect(body.nextCursor).toBe(String(CREATED_MS)); // last item's createdAt ms
    const [first, second] = body.items;
    expect(first.id).toBe('t-new');
    expect(first.createdAt).toBe(new Date(CREATED_MS + 2000).toISOString());
    expect(first.deadline).toBe(new Date(DEADLINE_MS).toISOString());
    expect(first.updatedAt).toBeNull(); // absent -> null, key still present
    expect(first.submittedAt).toBeNull();
    // { seconds } stored shape is converted identically (C-TS-01)
    expect(second.deadline).toBe(new Date(DEADLINE_MS).toISOString());
    expect(queryGetCalls).toHaveLength(1);
    expect(queryGetCalls[0].limitValue).toBe(100);
  });

  it('C-LIST-03: limit clamps to 500 max and 1 min', async () => {
    tasksGetHandler = async () => ({ docs: [] });
    await GET(makeRequest(undefined, 'http://localhost/api/tasks?limit=9999'));
    expect(queryGetCalls[0].limitValue).toBe(500);
    queryGetCalls.length = 0;
    await GET(makeRequest(undefined, 'http://localhost/api/tasks?limit=0'));
    // Number(0)||100 -> 100? No: params.get('limit') is '0', Number('0')=0 is falsy in `|| 100`? route: Number(params.get('limit') || 100) -> '0' is truthy string, Number=0, Math.max(1, ...) = 1
    expect(queryGetCalls[0].limitValue).toBe(1);
  });

  it('C-LIST-04: tier1/tier2/tier3 item arrays are deep-equal for the same fixture', async () => {
    const serve = async (mode: 't1' | 't2' | 't3') => {
      tasksGetHandler = async (state) => {
        if (mode === 't1') { if (!state.hasOrderBy) throw new Error('unexpected'); return { docs: listFixture() }; }
        if (mode === 't2') { if (state.hasOrderBy) throw new Error('index missing'); return { docs: [...listFixture()].reverse() }; }
        if (state.hasOrderBy && state.wheres.length > 0) throw new Error('index missing');
        if (!state.hasOrderBy) throw new Error('tier2 down');
        return { docs: listFixture() };
      };
      const res: any = await GET(makeRequest(undefined, 'http://localhost/api/tasks?status=pending&limit=50'));
      expect(res.status).toBe(200);
      return (await res.json()).items;
    };
    const t1 = await serve('t1');
    const t2 = await serve('t2');
    const t3 = await serve('t3');
    expect(t2).toEqual(t1);
    expect(t3).toEqual(t1);
  });

  it('C-LIST-05: all tiers fail -> 500 { error, details }, every query bounded', async () => {
    tasksGetHandler = async () => { throw new Error('still broken'); };
    const res: any = await GET(makeRequest(undefined, 'http://localhost/api/tasks?status=pending&limit=50'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Internal Server Error');
    expect(body.details).toBe('still broken');
    expect(queryGetCalls).toHaveLength(3);
    expect(queryGetCalls.every((s) => s.hasLimit)).toBe(true);
  });

  it('C-LIST-06: assignee branch unions, dedupes, filters in memory, slices to limit', async () => {
    const docs = [
      makeDoc('a1', { title: 'A1', status: 'pending', assigneeId: ASSIGNEE, createdAt: fakeTs(CREATED_MS + 3000) }),
      makeDoc('a2', { title: 'A2', status: 'completed', assigneeId: ASSIGNEE, createdAt: fakeTs(CREATED_MS + 2000) }),
      makeDoc('a3', { title: 'A3', status: 'pending', assigneeIds: [ASSIGNEE], createdAt: fakeTs(CREATED_MS + 1000) }),
    ];
    tasksGetHandler = async (state) => {
      const w = state.wheres[0];
      if (w && w[0] === 'assigneeId') return { docs: [docs[0], docs[1]] };
      if (w && w[0] === 'assigneeIds') return { docs: [docs[0], docs[2]] }; // a1 duplicated across legs
      throw new Error('unexpected query');
    };
    const res: any = await GET(makeRequest(undefined, `http://localhost/api/tasks?assigneeId=${ASSIGNEE}&status=pending&limit=1`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: any) => i.id)).toEqual(['a1']); // pending only, newest first, sliced to 1
    expect(body.count).toBe(1);
    expect(body.nextCursor).toBe(String(CREATED_MS + 3000));
    // HAZARD PINNED: neither underlying get carried a limit.
    expect(queryGetCalls).toHaveLength(2);
    expect(queryGetCalls.every((s) => !s.hasLimit)).toBe(true);
  });

  it('C-LIST-02b: no canManageTasks -> 403 exact body, no task query executed', async () => {
    mockForUser.mockResolvedValue(false);
    const res: any = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: insufficient privileges' });
    expect(queryGetCalls).toHaveLength(0);
  });
});

/* ----------------------------------------------------------- POST */
const futureDeadline = () => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

describe('C-CREATE: POST /api/tasks contracts', () => {
  it('C-CREATE-01/02: success shape (primary = first SORTED assignee) + side effects', async () => {
    const res: any = await POST(makeRequest({
      title: 'Build thing', description: 'desc', points: 10,
      deadline: futureDeadline(), assigneeIds: ['zeta-user', ASSIGNEE],
    }));
    expect(res.status).toBe(200);
    // sorted set: ['assignee-1','zeta-user'] -> primary 'assignee-1'
    expect(await res.json()).toEqual({ success: true, created: [{ id: 'new-task-1', assigneeId: ASSIGNEE }] });

    expect(addCalls).toHaveLength(1);
    const doc = addCalls[0];
    expect(doc.assigneeId).toBe(ASSIGNEE);
    expect(doc.assigneeIds).toEqual([ASSIGNEE, 'zeta-user']);
    expect(doc.assignerId).toBe(HOLDER);
    expect(doc.status).toBe('pending');
    expect(doc.acceptanceStatus).toBe('pending-acceptance');
    expect(doc.acceptanceBy[ASSIGNEE]).toEqual({ status: 'pending-acceptance', acceptedAt: null, acceptedBy: null });
    expect(doc.acceptanceBy['zeta-user']).toEqual({ status: 'pending-acceptance', acceptedAt: null, acceptedBy: null });
    expect(typeof doc.dedupeKey).toBe('string');
    expect(doc.createdAt).toEqual({ __fv: 'serverTimestamp' });
    expect(doc.updatedAt).toEqual({ __fv: 'serverTimestamp' });
    expect(doc.workflowParticipantIds).toEqual(expect.arrayContaining([ASSIGNEE, 'zeta-user', HOLDER]));

    expect(activityAdds).toHaveLength(1);
    expect(activityAdds[0].type).toBe('create');
    expect(activityAdds[0].userId).toBe(HOLDER);

    // per-assignee counters: exactly one increment(1) set-merge per assignee
    const counterSets = userSets.filter((s) => s.data && s.data.tasksAssignedCount);
    expect(counterSets.map((s) => s.uid).sort()).toEqual([ASSIGNEE, 'zeta-user']);
    for (const s of counterSets) {
      expect(s.data.tasksAssignedCount).toEqual({ __fv: 'increment', n: 1 });
      expect(s.opts).toEqual({ merge: true });
    }
    // in-app notifications written for both assignees (neither is the creator)
    expect(notifSets.map((n) => n.uid).sort()).toEqual([ASSIGNEE, 'zeta-user']);
    expect(notifSets[0].data.type).toBe('task_assigned');
  });

  it('C-CREATE-03: dedupe hit returns deduped:true and writes nothing new', async () => {
    const deadline = futureDeadline();
    const key = JSON.stringify([HOLDER, 'Build thing', new Date(deadline).getTime(), [ASSIGNEE]]);
    tasksGetHandler = async (state) => {
      if (state.wheres.some((w) => w[0] === 'dedupeKey' && w[2] === key)) {
        return { docs: [makeDoc('existing-1', { createdAt: fakeTs(Date.now()) })] };
      }
      return { docs: [] };
    };
    const res: any = await POST(makeRequest({ title: 'Build thing', description: 'd', points: 1, deadline, assigneeId: ASSIGNEE }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, created: [{ id: 'existing-1', assigneeId: ASSIGNEE }], deduped: true });
    expect(addCalls).toHaveLength(0);
    // the dedupe probe itself is bounded
    expect(queryGetCalls[0].limitValue).toBe(5);
  });

  it('C-CREATE-04: schema failure -> 400 Invalid request; past deadline -> 400', async () => {
    const bad: any = await POST(makeRequest({ title: 'x' }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('Invalid request');
    const past: any = await POST(makeRequest({
      title: 'T', description: 'd', points: 1,
      deadline: new Date(Date.now() - 1000).toISOString(), assigneeId: ASSIGNEE,
    }));
    expect(past.status).toBe(400);
    expect(await past.json()).toEqual({ error: 'Deadline must be in the future' });
    expect(addCalls).toHaveLength(0);
  });
});

/* ---------------------------------------------------------- PATCH */
describe('C-UPD: PATCH /api/tasks contracts', () => {
  it('C-UPD-01: plain manager update response shape', async () => {
    mockTaskData = { title: 'Old', status: 'pending', assigneeId: ASSIGNEE, assignerId: 'someone-else' };
    const res: any = await PATCH(makeRequest({ taskId: 'task-1', updates: { title: 'New title' } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual([
      'badgeAwarded', 'completedOnTime', 'ok', 'pointsAwardedTotal', 'taskAfter', 'taskBefore', 'taskId', 'transitionedToCompleted', 'uid',
    ]);
    expect(body).toMatchObject({ ok: true, taskId: 'task-1', badgeAwarded: false, pointsAwardedTotal: 0, completedOnTime: false, transitionedToCompleted: false, uid: HOLDER });
    expect(body.taskAfter.title).toBe('New title');
    expect(body.taskAfter.updatedAt).toBeDefined();
    expect(batchCommits).toBe(1);
  });

  it('C-UPD-02: assignee submit-for-review stamps submittedBy/submittedAt and clears decision stamps', async () => {
    mockUid = ASSIGNEE;
    mockForUser.mockResolvedValue(false);
    mockTaskData = { title: 'T', status: 'in-progress', assigneeId: ASSIGNEE, assignerId: HOLDER, report: 'work done' };
    const res: any = await PATCH(makeRequest({ taskId: 'task-1', updates: { status: 'submitted-for-review' } }));
    expect(res.status).toBe(200);
    const upd = batchUpdates.find((u) => u.id === 'task-1');
    expect(upd).toBeDefined();
    expect(upd!.data.submittedBy).toBe(ASSIGNEE);
    expect(upd!.data.submittedAt).toBeDefined();
    expect(upd!.data.approvedBy).toEqual({ __fv: 'delete' });
    expect(upd!.data.rejectedBy).toEqual({ __fv: 'delete' });
  });

  it('C-UPD-03: changes-requested without feedback_text -> 400 exact body, no write', async () => {
    mockTaskData = { title: 'T', status: 'submitted-for-review', assigneeId: ASSIGNEE, assignerId: HOLDER, submittedBy: ASSIGNEE };
    const res: any = await PATCH(makeRequest({ taskId: 'task-1', updates: { status: 'changes-requested' } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Feedback text is mandatory for requesting changes' });
    expect(batchCommits).toBe(0);
  });

  it('C-UPD-04: submit-for-review with no report anywhere -> 400 exact body', async () => {
    mockUid = ASSIGNEE;
    mockForUser.mockResolvedValue(false);
    mockTaskData = { title: 'T', status: 'in-progress', assigneeId: ASSIGNEE, assignerId: HOLDER };
    const res: any = await PATCH(makeRequest({ taskId: 'task-1', updates: { status: 'submitted-for-review' } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('A report is required before transmitting. Please write your report before submitting for review.');
  });

  it('C-UPD-05: completion response shape DIFFERS from plain update (no pointsAwardedTotal/completedOnTime keys)', async () => {
    mockTaskData = { title: 'T', status: 'submitted-for-review', assigneeId: ASSIGNEE, assignerId: HOLDER, submittedBy: ASSIGNEE };
    mockGamification.mockResolvedValue({ pointsAwardedTotal: 42 });
    const res: any = await PATCH(makeRequest({ taskId: 'task-1', updates: { status: 'completed' } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transitionedToCompleted).toBe(true);
    expect(body.badgeAwarded).toBe(false);
    expect('pointsAwardedTotal' in body).toBe(false);
    expect('completedOnTime' in body).toBe(false);
    expect(body.taskAfter.pointsAwardedTotal).toBe(42); // tx result merged into taskAfter only
    expect(mockGamification).toHaveBeenCalledTimes(1);
  });

  it('C-UPD-06: self-validation -> 403 exact body', async () => {
    mockTaskData = { title: 'T', status: 'submitted-for-review', assigneeId: ASSIGNEE, assignerId: 'x', submittedBy: HOLDER };
    const res: any = await PATCH(makeRequest({ taskId: 'task-1', updates: { status: 'completed' } }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: you cannot validate your own submission' });
    expect(mockGamification).not.toHaveBeenCalled();
  });

  it('C-UPD-07: unknown task -> 404; invalid body -> 400', async () => {
    mockTaskExists = false;
    const nf: any = await PATCH(makeRequest({ taskId: 'nope', updates: { title: 'x' } }));
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ error: 'Task not found' });
    mockTaskExists = true; mockTaskData = { status: 'pending' };
    const bad: any = await PATCH(makeRequest({ taskId: 'task-1', updates: { status: 'bogus-status' } }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('Invalid request');
  });
});

/* ------------------------------------- deadline fairness (2026-10-26) */
describe('C-UPD-DF: PATCH deadline-fairness contracts (founder rule 2026-10-26)', () => {
  const FUTURE_DEADLINE = '2027-06-01T00:00:00.000Z';
  const SFR_TASK = {
    title: 'T', status: 'submitted-for-review', assigneeId: ASSIGNEE,
    assignerId: HOLDER, submittedBy: ASSIGNEE,
  };

  it('C-UPD-DF-01: changes-requested with feedback but NO new deadline -> 400, no write', async () => {
    mockTaskData = { ...SFR_TASK };
    const res: any = await PATCH(makeRequest({ taskId: 'task-1', updates: { status: 'changes-requested', feedback_text: 'Needs more detail' } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'A new deadline is mandatory for requesting changes' });
    expect(batchCommits).toBe(0);
  });

  it('C-UPD-DF-02: changes-requested with feedback + new deadline -> 200, deadline rewritten, history carries both stamps', async () => {
    mockTaskData = { ...SFR_TASK, deadline: new Date('2026-10-20T00:00:00.000Z') };
    const res: any = await PATCH(makeRequest({
      taskId: 'task-1',
      updates: { status: 'changes-requested', feedback_text: 'Needs more detail', reviewDeadline: FUTURE_DEADLINE },
    }));
    expect(res.status).toBe(200);
    const upd = batchUpdates.find((u) => u.id === 'task-1');
    expect(upd).toBeDefined();
    expect(upd!.data.status).toBe('changes-requested');
    expect(upd!.data.deadline).toEqual(new Date(FUTURE_DEADLINE));
    expect(upd!.data.reviewDeadline).toBeUndefined();
    expect(upd!.data.rejectedBy).toBe(HOLDER);
    const hist = upd!.data.feedback_history;
    expect(hist.__fv).toBe('arrayUnion');
    expect(hist.vals[0].text).toBe('Needs more detail');
    expect(hist.vals[0].new_deadline).toBe(FUTURE_DEADLINE);
  });

  it('C-UPD-DF-03: workflow step return writes individualDeadline, not deadline', async () => {
    mockTaskData = { ...SFR_TASK, workflowId: 'wf-1', individualDeadline: '2026-10-27T00:34:00.000Z' };
    const res: any = await PATCH(makeRequest({
      taskId: 'task-1',
      updates: { status: 'changes-requested', feedback_text: 'Redo the check', reviewDeadline: FUTURE_DEADLINE },
    }));
    expect(res.status).toBe(200);
    const upd = batchUpdates.find((u) => u.id === 'task-1');
    expect(upd).toBeDefined();
    expect(upd!.data.individualDeadline).toEqual(new Date(FUTURE_DEADLINE));
    expect(upd!.data.deadline).toBeUndefined();
  });

  it('C-UPD-DF-04: new deadline in the past -> 400', async () => {
    mockTaskData = { ...SFR_TASK };
    const res: any = await PATCH(makeRequest({
      taskId: 'task-1',
      updates: { status: 'changes-requested', feedback_text: 'Redo', reviewDeadline: '2020-01-01T00:00:00.000Z' },
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'The new deadline for requested changes must be in the future' });
    expect(batchCommits).toBe(0);
  });

  it('C-UPD-DF-05: list-path return (validator sends in-progress) without feedback/deadline -> 400 feedback mandate', async () => {
    mockTaskData = { ...SFR_TASK };
    const res: any = await PATCH(makeRequest({ taskId: 'task-1', updates: { status: 'in-progress' } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Feedback text is mandatory for requesting changes' });
    expect(batchCommits).toBe(0);
  });

  it('C-UPD-DF-06: list-path return WITH feedback + deadline lands as changes-requested', async () => {
    mockTaskData = { ...SFR_TASK, deadline: new Date('2026-10-20T00:00:00.000Z') };
    const res: any = await PATCH(makeRequest({
      taskId: 'task-1',
      updates: { status: 'in-progress', feedback_text: 'Redo', reviewDeadline: FUTURE_DEADLINE },
    }));
    expect(res.status).toBe(200);
    const upd = batchUpdates.find((u) => u.id === 'task-1');
    expect(upd).toBeDefined();
    expect(upd!.data.status).toBe('changes-requested');
    expect(upd!.data.deadline).toEqual(new Date(FUTURE_DEADLINE));
    expect(upd!.data.rejectedBy).toBe(HOLDER);
  });

  it('C-UPD-DF-07: submitter recall (SFR -> in-progress by the submitter) stays a plain update', async () => {
    mockUid = ASSIGNEE;
    mockForUser.mockResolvedValue(false);
    mockCanValidate.mockResolvedValue({ allowed: false, reason: 'self-validation' });
    mockTaskData = { ...SFR_TASK, report: 'work done' };
    const res: any = await PATCH(makeRequest({ taskId: 'task-1', updates: { status: 'in-progress' } }));
    expect(res.status).toBe(200);
    const upd = batchUpdates.find((u) => u.id === 'task-1');
    expect(upd).toBeDefined();
    expect(upd!.data.status).toBe('in-progress');
    expect(upd!.data.feedback_history).toBeUndefined();
  });

  it('C-UPD-DF-08: first submission stamps firstSubmittedAt; resubmission preserves it', async () => {
    mockUid = ASSIGNEE;
    mockForUser.mockResolvedValue(false);
    mockTaskData = { title: 'T', status: 'in-progress', assigneeId: ASSIGNEE, assignerId: HOLDER, report: 'work done' };
    const first: any = await PATCH(makeRequest({ taskId: 'task-1', updates: { status: 'submitted-for-review' } }));
    expect(first.status).toBe(200);
    const firstUpd = batchUpdates.find((u) => u.id === 'task-1');
    expect(firstUpd!.data.submittedAt).toBeDefined();
    expect(firstUpd!.data.firstSubmittedAt).toBeDefined();

    batchUpdates.length = 0;
    mockTaskData = {
      title: 'T', status: 'changes-requested', assigneeId: ASSIGNEE, assignerId: HOLDER,
      report: 'work done', firstSubmittedAt: { __ts: 'first-submission' },
    };
    const second: any = await PATCH(makeRequest({ taskId: 'task-1', updates: { status: 'submitted-for-review' } }));
    expect(second.status).toBe(200);
    const secondUpd = batchUpdates.find((u) => u.id === 'task-1');
    expect(secondUpd!.data.submittedAt).toBeDefined();
    expect(secondUpd!.data).not.toHaveProperty('firstSubmittedAt');
  });
});

/* --------------------------------------------------------- DELETE */
describe('C-DEL: DELETE /api/tasks contracts', () => {
  it('C-DEL-01: success shape + assignee counter decrement (completed adds completed decrement)', async () => {
    mockTaskData = { assignerId: 'someone-else', assigneeId: ASSIGNEE, status: 'completed' };
    const res: any = await DELETE(makeRequest({ taskId: 'task-9' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: 'task-9', uid: HOLDER });
    expect(docDeletes).toContain('task-9');
    const counter = userSets.find((s) => s.uid === ASSIGNEE);
    expect(counter?.data.tasksAssignedCount).toEqual({ __fv: 'increment', n: -1 });
    expect(counter?.data.tasksCompletedCount).toEqual({ __fv: 'increment', n: -1 });
  });

  it('C-DEL-02: guards — 400 missing taskId, 404 unknown, 403 neither manager nor assigner', async () => {
    const noId: any = await DELETE(makeRequest({}));
    expect(noId.status).toBe(400);
    expect(await noId.json()).toEqual({ error: 'Invalid request: taskId is required' });

    mockTaskExists = false;
    const nf: any = await DELETE(makeRequest({ taskId: 'ghost' }));
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ error: 'Task not found' });

    mockTaskExists = true;
    mockForUser.mockResolvedValue(false);
    mockTaskData = { assignerId: 'someone-else', assigneeId: ASSIGNEE, status: 'pending' };
    const forb: any = await DELETE(makeRequest({ taskId: 'task-1' }));
    expect(forb.status).toBe(403);
    expect(await forb.json()).toEqual({ error: 'Forbidden: you do not have permission to delete this task' });
    expect(docDeletes).toHaveLength(0);
  });
});
