/**
 * @jest-environment node
 *
 * BEHAVIOR CONTRACTS — tasks cluster, group 2 surfaces, recorded from
 * the CURRENT Firestore implementation at feat/integration-wave3 @
 * 4d5a1e16, ahead of feat/supa-tasks-2 (one seam:
 * src/lib/supa/seam-tasks-lists.ts, useSupa('tasks'), default OFF,
 * Firestore fallback). The seam must keep every contract byte-identical.
 *
 * Surfaces: GET /api/tasks/team, GET /api/tasks/review-queue,
 * GET /api/tasks/approval-rate, GET+POST /api/tasks/[id]/activity,
 * GET /api/tasks/[id]/validation.
 *
 * Contract inventory:
 *   C-TEAM-01  Team body: { tasks, teamSize } where teamSize counts the
 *              caller + ALL subordinates (reporting_relationships BFS
 *              UNION legacy users.managerId), and tasks is the deduped
 *              union of assigneeId-in / assigneeIds array-contains (per
 *              member) / assignerId==caller / createdBy==caller legs.
 *   C-TEAM-02  !!! NO STATUS FILTER — PINNED CURRENT BEHAVIOR.
 *              Completed, pending and submitted tasks ALL appear.
 *              A pending defect fix (fix/tasks-status-semantics) is
 *              expected to change this; when it lands this test MUST
 *              fail loudly and be re-pinned — the migration must NOT
 *              silently change it first. No query issued by this route
 *              carries a 'status' where. (The Firestore legs' lack of a
 *              limit — hazard GAP-T2-01 in CONTRACTS.md — was fixed by
 *              the read-bleed hardening: every Firestore leg now carries
 *              limit(200); the pin below was updated with that fix.)
 *   C-TEAM-03  Team item shape (exactly 14 keys): { id, title (default
 *              'Untitled Task'), status (default 'pending'), priority
 *              (default 'medium'), assigneeId, creatorId
 *              (= assignerId || createdBy), deadline, createdAt,
 *              completedAt (ISO strings or null), isOverdue (deadline
 *              in past AND status !== 'completed'), points (default
 *              0), workflowId, assigneeName (default 'Unknown'),
 *              creatorName (default 'System') }.
 *   C-TEAM-04  Unauthenticated -> 401 { error:'Unauthorized' }.
 *   C-RQ-01    Review-queue body: { tasks: QueueItem[] } containing
 *              ONLY status 'submitted-for-review' tasks the caller may
 *              validate; the caller's OWN submissions are excluded
 *              before the canValidateTask check.
 *   C-RQ-02    QueueItem shape: { id, title (default 'Untitled task'),
 *              submitterUid (submittedBy, else primary assignee),
 *              submitterName (users doc displayName || email ||
 *              'Team Member'), submitterRole, workflowId,
 *              sequenceIndex, points, submittedAt, deadline
 *              (individualDeadline ?? deadline) — timestamps as ISO
 *              strings or undefined — via, depth }.
 *   C-RQ-03    Bounded read: primary query is status== + orderBy
 *              submittedAt desc + limit(100); on failure the fallback
 *              is status== + limit(100) with NO orderBy. Both bounded.
 *   C-RQ-04    A task whose canValidateTask THROWS is skipped, not
 *              fatal; a task the check rejects is excluded silently.
 *   C-AR-01    Approval-rate body: { success:true, uid, approved,
 *              decided, rate, hasHistory } from the REAL
 *              src/lib/server/task-approval-rate computation: decided
 *              = last-10 window over completed|approved|rejected|
 *              changes-requested attributed to the uid (submittedBy
 *              wins attribution); rate = approved/decided or null.
 *   C-AR-02    Approval-rate gates: missing uid -> 400 { error:
 *              'Missing required query parameter: uid' }; no
 *              canManageTasks -> 403 { error:"Forbidden:
 *              'canManageTasks' access required" }; unauth -> 401.
 *   C-AR-03    The rate reads THREE unbounded legs (assigneeId ==,
 *              assigneeIds array-contains, submittedBy ==) with the
 *              window applied in memory — pinned; a seam listDocs for
 *              these legs must not invent a smaller limit that changes
 *              the window (GAP-T2-02).
 *   C-ACT-01   Activity GET body: { activities, count,
 *              assigneeSilence } — activity items { id, type, userId,
 *              data (default {}), createdAt (ISO or null), userName }
 *              with the internal createdAtMs STRIPPED; ordered
 *              createdAt desc; read bounded by limit(100).
 *   C-ACT-02   assigneeSilence entries: { userId, userName,
 *              lastActivityAt, daysSinceLastActivity, hasGoneSilent }
 *              over assigneeId UNION assigneeIds; silence = task
 *              incomplete AND (no activity ever -> fall back to task
 *              createdAt; null baseline counts as silent) OR last
 *              activity older than 2 days.
 *   C-ACT-03   Activity guards: unknown task -> 404 { error:'Task not
 *              found' } on GET and POST; POST with a type outside
 *              comment|rejection|feedback -> 400 { error:'Invalid
 *              activity type' }.
 *   C-VAL-01   Validation GET body: { canValidate, via, depth,
 *              isSubmitter } — via is null when not allowed (even if
 *              the check returned one), depth defaults null.
 *   C-VAL-02   A canValidateTask THROW degrades to 200
 *              { canValidate:false, via:null, depth:null,
 *              isSubmitter } — NOT a 500.
 *   C-VAL-03   Validation guards: unknown task -> 404; unauth -> 401.
 */

const CALLER = 'caller-1';
const DOCID = { __docid: true };

const mockForUser = jest.fn();
const mockCanValidate = jest.fn();
let mockAuth: any = null;

/* ---------------------------------------------------- fake store */
function fakeTs(ms: number) {
  return { toMillis: () => ms, toDate: () => new Date(ms), seconds: Math.floor(ms / 1000), nanoseconds: 0 };
}

let usersStore = new Map<string, any>();
let tasksStore = new Map<string, any>();
let relStore: any[] = [];
let activityStore = new Map<string, any[]>();
let orderByFails = false;

type QLog = { coll: string; wheres: Array<[any, string, any]>; hasOrderBy: boolean; orderField: string | null; hasLimit: boolean; limitValue: number | null };
const queryLog: QLog[] = [];

function applyWheres(docs: Array<{ id: string; data: any }>, wheres: Array<[any, string, any]>) {
  return docs.filter(({ id, data }) =>
    wheres.every(([field, op, value]) => {
      const actual = field === DOCID ? id : data?.[field];
      if (op === '==') return actual === value;
      if (op === 'in') return Array.isArray(value) && value.includes(actual);
      if (op === 'array-contains') return Array.isArray(actual) && actual.includes(value);
      return false;
    }),
  );
}

function makeQuery(coll: string, docs: Array<{ id: string; data: any }>, wheres: Array<[any, string, any]> = [], orderField: string | null = null, limitValue: number | null = null): any {
  return {
    where: (f: any, op: string, v: any) => makeQuery(coll, docs, [...wheres, [f, op, v]], orderField, limitValue),
    orderBy: (f: string) => makeQuery(coll, docs, wheres, f, limitValue),
    limit: (n: number) => makeQuery(coll, docs, wheres, orderField, n),
    get: async () => {
      queryLog.push({ coll, wheres, hasOrderBy: !!orderField, orderField, hasLimit: limitValue !== null, limitValue });
      if (orderByFails && orderField) throw new Error('FAILED_PRECONDITION: orderBy index missing');
      let rows = applyWheres(docs, wheres);
      if (orderField) {
        rows = [...rows].sort((a, b) => ((b.data?.[orderField]?.toMillis?.() ?? 0) - (a.data?.[orderField]?.toMillis?.() ?? 0)));
      }
      if (limitValue !== null) rows = rows.slice(0, limitValue);
      return { docs: rows.map((r) => ({ id: r.id, data: () => r.data })) };
    },
  };
}

function taskDocRef(id: string): any {
  return {
    id,
    get: async () => ({ exists: tasksStore.has(id), data: () => tasksStore.get(id) }),
    collection: (sub: string) => {
      if (sub !== 'activity') throw new Error(`unexpected subcollection ${sub}`);
      const docs = (activityStore.get(id) || []).map((a) => ({ id: a.id, data: a.data }));
      return makeQuery(`tasks/${id}/activity`, docs);
    },
  };
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'tasks') {
      const docs = [...tasksStore.entries()].map(([id, data]) => ({ id, data }));
      const q = makeQuery('tasks', docs);
      q.doc = (id: string) => taskDocRef(id);
      return q;
    }
    if (name === 'users') {
      const docs = [...usersStore.entries()].map(([id, data]) => ({ id, data }));
      const q = makeQuery('users', docs);
      q.doc = (uid: string) => ({
        id: uid,
        get: async () => ({ exists: usersStore.has(uid), data: () => usersStore.get(uid) }),
      });
      return q;
    }
    if (name === 'reporting_relationships') {
      return makeQuery('reporting_relationships', relStore.map((r, i) => ({ id: `rel-${i}`, data: r })));
    }
    throw new Error(`unexpected collection: ${name}`);
  },
};

/* -------------------------------------------------------- mocks */
jest.mock('next/server', () => {
  class MockNextResponse {
    status: number; private payload: any;
    constructor(payload: any, init?: { status?: number }) { this.payload = payload; this.status = init?.status ?? 200; }
    static json(payload: any, init?: { status?: number }) { return new MockNextResponse(payload, init); }
    async json() { return this.payload; }
  }
  return { NextRequest: class {}, NextResponse: MockNextResponse };
});

jest.mock('@/lib/server/firebase-admin', () => ({
  admin: { firestore: { FieldPath: { documentId: () => DOCID }, FieldValue: { serverTimestamp: () => ({ __fv: 'serverTimestamp' }) } } },
  getDb: () => mockDb,
  ensureAdminInitialized: () => true,
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => mockAuth,
}));

jest.mock('@/lib/server/hierarchy', () => ({
  canValidateTask: (...a: any[]) => mockCanValidate(...a),
}));

jest.mock('@/lib/server/chapter-scoping', () => ({
  // Identity scope: chapter-scoping semantics are the chapters
  // cluster's contract; here they are isolated so the team shape is
  // what is measured.
  applyChapterScope: async (q: any) => q,
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(false),
  hasServerPermissionForUser: (...args: any[]) => mockForUser(...args),
}));

import { GET as teamGET } from '../team/route';
import { GET as reviewQueueGET } from '../review-queue/route';
import { GET as approvalRateGET } from '../approval-rate/route';
import { GET as activityGET, POST as activityPOST } from '../[id]/activity/route';
import { GET as validationGET } from '../[id]/validation/route';

function authedUser() {
  return {
    authenticated: true,
    user: { user: { uid: CALLER }, userId: CALLER, email: 'caller@example.com', displayName: 'Caller', emailVerified: true, role: 'member' },
  };
}

function makeRequest(url = 'http://localhost/x', body?: any): any {
  const req: any = {
    url,
    json: async () => body ?? {},
    headers: { get: () => null },
    cookies: { get: () => undefined },
  };
  req.clone = () => req;
  return req;
}

const NOW = Date.now();
const DAY = 24 * 3600 * 1000;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  mockAuth = authedUser();
  mockForUser.mockResolvedValue(true);
  mockCanValidate.mockResolvedValue({ allowed: true, via: 'assigner', depth: null });
  usersStore = new Map();
  tasksStore = new Map();
  relStore = [];
  activityStore = new Map();
  queryLog.length = 0;
  orderByFails = false;
});

afterEach(() => { jest.restoreAllMocks(); });

/* ---------------------------------------------------------- TEAM */
describe('C-TEAM: GET /api/tasks/team', () => {
  function seedTeam() {
    usersStore.set(CALLER, { role: 'member', displayName: 'Caller' });
    usersStore.set('sub-1', { displayName: 'Sub One' });
    usersStore.set('legacy-sub', { displayName: 'Legacy Sub', managerId: CALLER });
    usersStore.set('boss-1', { displayName: 'Boss One' });
    relStore = [{ managerId: CALLER, subordinateId: 'sub-1' }];
    tasksStore.set('t-done', { title: 'Done task', status: 'completed', assigneeId: CALLER, assignerId: 'boss-1', deadline: fakeTs(NOW - DAY), createdAt: fakeTs(NOW - 2 * DAY), completedAt: fakeTs(NOW - DAY), points: 7 });
    tasksStore.set('t-pending', { status: 'pending', assigneeId: 'sub-1', deadline: fakeTs(NOW - DAY) }); // no title -> default; overdue
    tasksStore.set('t-co', { title: 'Co task', status: 'submitted-for-review', assigneeIds: ['legacy-sub', 'x-1'], assignerId: 'boss-1' });
    tasksStore.set('t-mine-created', { title: 'Created by caller', status: 'pending', assigneeId: 'outsider-1', assignerId: CALLER });
    tasksStore.set('t-foreign', { title: 'Foreign', status: 'pending', assigneeId: 'outsider-1', assignerId: 'boss-1' });
  }

  it('C-TEAM-01/02/03: union body, teamSize, item shape, terminal statuses excluded (post-1a semantics)', async () => {
    seedTeam();
    const res: any = await teamGET(makeRequest('http://localhost/api/tasks/team'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['tasks', 'teamSize']);
    expect(body.teamSize).toBe(3); // caller + sub-1 (relationships) + legacy-sub (users.managerId)
    const ids = body.tasks.map((t: any) => t.id).sort();
    expect(ids).toEqual(['t-co', 't-mine-created', 't-pending']); // t-foreign excluded; t-done terminal-excluded

    // UPDATED AT STEP 17 (the authors' own instruction was that this pin
    // must fail loudly when fix/tasks-status-semantics lands — it has):
    // terminal statuses ('completed'/'approved') are excluded in-code by
    // the route; submitted-for-review stays. The exclusion is NOT a query
    // filter — the query shape pins below are unchanged.
    const statuses = body.tasks.map((t: any) => t.status).sort();
    expect(statuses).toEqual(['pending', 'pending', 'submitted-for-review']);
    const taskQueries = queryLog.filter((q) => q.coll === 'tasks');
    expect(taskQueries.length).toBeGreaterThan(0);
    expect(taskQueries.every((q) => !q.wheres.some((w) => w[0] === 'status'))).toBe(true);
    // Read-bleed hardening (GAP-T2-01 fixed): every team task query
    // carries the per-leg bound limit(200).
    expect(taskQueries.every((q) => q.hasLimit && q.limitValue === 200)).toBe(true);

    const done = body.tasks.find((t: any) => t.id === 't-co');
    expect(Object.keys(done).sort()).toEqual([
      'assigneeId', 'assigneeName', 'completedAt', 'createdAt', 'creatorId', 'creatorName',
      'deadline', 'id', 'isOverdue', 'points', 'priority', 'status', 'title', 'workflowId',
    ]);
    expect(done).toMatchObject({
      title: 'Co task', status: 'submitted-for-review',
      creatorId: 'boss-1', creatorName: 'Boss One',
    });
    const pending = body.tasks.find((t: any) => t.id === 't-pending');
    expect(pending.title).toBe('Untitled Task');
    expect(pending.isOverdue).toBe(true); // past deadline, not completed
    expect(pending.points).toBe(0);
    expect(pending.deadline).toBe(new Date(NOW - DAY).toISOString());
    const co = body.tasks.find((t: any) => t.id === 't-co');
    expect(co.assigneeId).toBeUndefined(); // array-form only: singular field passes through as stored (absent)
    expect(co.creatorName).toBe('Boss One');
  });

  it('C-TEAM-04: unauthenticated -> 401 exact body', async () => {
    mockAuth = { authenticated: false, user: null };
    const res: any = await teamGET(makeRequest('http://localhost/api/tasks/team'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });
});

/* -------------------------------------------------- REVIEW-QUEUE */
describe('C-RQ: GET /api/tasks/review-queue', () => {
  function seedQueue() {
    usersStore.set('sub-1', { displayName: 'Sub One', role: 'member' });
    usersStore.set('sub-2', { displayName: 'Sub Two', role: 'member' });
    tasksStore.set('q-1', { title: 'Q1', status: 'submitted-for-review', submittedBy: 'sub-1', assigneeId: 'sub-1', points: 5, submittedAt: fakeTs(NOW - DAY), deadline: fakeTs(NOW + DAY), individualDeadline: fakeTs(NOW + 2 * DAY) });
    tasksStore.set('q-own', { title: 'Own', status: 'submitted-for-review', submittedBy: CALLER, assigneeId: CALLER });
    tasksStore.set('q-denied', { title: 'Denied', status: 'submitted-for-review', submittedBy: 'sub-2', assigneeId: 'sub-2' });
    tasksStore.set('q-pending', { title: 'Not submitted', status: 'pending', assigneeId: 'sub-1' });
  }

  it('C-RQ-01/02/03: filtered items, QueueItem shape, bounded limit(100) query', async () => {
    seedQueue();
    mockCanValidate.mockImplementation(async (_uid: string, _role: string, task: any) =>
      task.title === 'Denied' ? { allowed: false, via: null, depth: null } : { allowed: true, via: 'assigner', depth: null });
    const res: any = await reviewQueueGET(makeRequest('http://localhost/api/tasks/review-queue'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['tasks']);
    expect(body.tasks.map((t: any) => t.id)).toEqual(['q-1']); // own excluded, denied excluded, pending not queried
    const item = body.tasks[0];
    expect(item).toMatchObject({
      id: 'q-1', title: 'Q1', submitterUid: 'sub-1', submitterName: 'Sub One',
      submitterRole: 'member', points: 5, via: 'assigner', depth: null,
      submittedAt: new Date(NOW - DAY).toISOString(),
      deadline: new Date(NOW + 2 * DAY).toISOString(), // individualDeadline wins over deadline
    });
    const q = queryLog.find((x) => x.coll === 'tasks');
    expect(q?.wheres).toEqual([['status', '==', 'submitted-for-review']]);
    expect(q?.hasOrderBy).toBe(true);
    expect(q?.limitValue).toBe(100);
  });

  it('C-RQ-03b: orderBy failure falls back to bounded unordered query with the same items', async () => {
    seedQueue();
    mockCanValidate.mockImplementation(async (_uid: string, _role: string, task: any) =>
      task.title === 'Denied' ? { allowed: false, via: null, depth: null } : { allowed: true, via: 'assigner', depth: null });
    orderByFails = true;
    const res: any = await reviewQueueGET(makeRequest('http://localhost/api/tasks/review-queue'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tasks.map((t: any) => t.id)).toEqual(['q-1']);
    expect(queryLog).toHaveLength(2);
    expect(queryLog[1].hasOrderBy).toBe(false);
    expect(queryLog[1].limitValue).toBe(100);
  });

  it('C-RQ-04: canValidateTask throwing for a task skips it, does not fail the queue', async () => {
    seedQueue();
    tasksStore.set('q-boom', { title: 'Boom', status: 'submitted-for-review', submittedBy: 'sub-1', assigneeId: 'sub-1', submittedAt: fakeTs(NOW) });
    mockCanValidate.mockImplementation(async (_u: string, _r: string, task: any) => {
      if (task.title === 'Boom') throw new Error('chain walk exploded');
      if (task.title === 'Denied') return { allowed: false, via: null, depth: null };
      return { allowed: true, via: 'assigner', depth: null };
    });
    const res: any = await reviewQueueGET(makeRequest('http://localhost/api/tasks/review-queue'));
    expect(res.status).toBe(200);
    expect((await res.json()).tasks.map((t: any) => t.id)).toEqual(['q-1']);
  });
});

/* ------------------------------------------------- APPROVAL-RATE */
describe('C-AR: GET /api/tasks/approval-rate (real computation lib)', () => {
  function seedRate() {
    const at = (d: number) => fakeTs(NOW - d * DAY);
    tasksStore.set('r-1', { status: 'completed', assigneeId: 'performer-1', submittedBy: 'performer-1', approvedAt: at(1) });
    tasksStore.set('r-2', { status: 'approved', assigneeId: 'performer-1', submittedBy: 'performer-1', approvedAt: at(2) });
    tasksStore.set('r-3', { status: 'rejected', assigneeId: 'performer-1', submittedBy: 'performer-1', rejectedAt: at(3) });
    tasksStore.set('r-4', { status: 'changes-requested', assigneeId: 'performer-1', submittedBy: 'performer-1', rejectedAt: at(4) });
    tasksStore.set('r-5', { status: 'pending', assigneeId: 'performer-1', submittedBy: 'performer-1' }); // not decided
    tasksStore.set('r-6', { status: 'completed', assigneeIds: ['performer-1', 'x'], submittedBy: 'performer-1', approvedAt: at(5) }); // array-contains leg
    tasksStore.set('r-7', { status: 'completed', assigneeId: 'performer-1', submittedBy: 'someone-else', approvedAt: at(1) }); // attribution drops it
  }

  it('C-AR-01/03: body shape and rate from the three legs', async () => {
    seedRate();
    const res: any = await approvalRateGET(makeRequest('http://localhost/api/tasks/approval-rate?uid=performer-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true, uid: 'performer-1', approved: 3, decided: 5, rate: 0.6, hasHistory: true,
    });
    const legs = queryLog.filter((q) => q.coll === 'tasks');
    expect(legs.map((l) => l.wheres[0][0])).toEqual(['assigneeId', 'assigneeIds', 'submittedBy']);
    expect(legs.every((l) => !l.hasLimit)).toBe(true); // pinned: window is in-memory
  });

  it('C-AR-01b: no decided history -> rate null, hasHistory false', async () => {
    const res: any = await approvalRateGET(makeRequest('http://localhost/api/tasks/approval-rate?uid=ghost-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, uid: 'ghost-1', approved: 0, decided: 0, rate: null, hasHistory: false });
  });

  it('C-AR-02: gates — 400 missing uid, 403 no grant', async () => {
    const noUid: any = await approvalRateGET(makeRequest('http://localhost/api/tasks/approval-rate'));
    expect(noUid.status).toBe(400);
    expect(await noUid.json()).toEqual({ error: 'Missing required query parameter: uid' });
    mockForUser.mockResolvedValue(false);
    const forb: any = await approvalRateGET(makeRequest('http://localhost/api/tasks/approval-rate?uid=performer-1'));
    expect(forb.status).toBe(403);
    expect(await forb.json()).toEqual({ error: "Forbidden: 'canManageTasks' access required" });
  });
});

/* ------------------------------------------------------- ACTIVITY */
describe('C-ACT: /api/tasks/[id]/activity', () => {
  function seedActivity() {
    usersStore.set('sub-1', { displayName: 'Sub One' });
    usersStore.set('sub-2', { displayName: 'Sub Two' });
    usersStore.set(CALLER, { displayName: 'Caller' });
    tasksStore.set('task-1', { status: 'in-progress', assigneeId: 'sub-1', assigneeIds: ['sub-1', 'sub-2'], createdAt: fakeTs(NOW - 5 * DAY) });
    activityStore.set('task-1', [
      { id: 'a-old', data: { type: 'comment', userId: CALLER, data: { text: 'hi' }, createdAt: fakeTs(NOW - 3 * DAY) } },
      { id: 'a-new', data: { type: 'status', userId: 'sub-1', data: { from: 'pending', to: 'in-progress' }, createdAt: fakeTs(NOW - DAY) } },
    ]);
  }

  it('C-ACT-01/02: body shape, createdAtMs stripped, silence signals', async () => {
    seedActivity();
    const res: any = await activityGET(makeRequest('http://localhost/api/tasks/task-1/activity'), { params: Promise.resolve({ id: 'task-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['activities', 'assigneeSilence', 'count']);
    expect(body.count).toBe(2);
    expect(body.activities.map((a: any) => a.id)).toEqual(['a-new', 'a-old']); // createdAt desc
    const first = body.activities[0];
    expect(Object.keys(first).sort()).toEqual(['createdAt', 'data', 'id', 'type', 'userId', 'userName']);
    expect(first.createdAt).toBe(new Date(NOW - DAY).toISOString());
    expect(first.userName).toBe('Sub One');
    expect('createdAtMs' in first).toBe(false);

    const silence = Object.fromEntries(body.assigneeSilence.map((s: any) => [s.userId, s]));
    expect(Object.keys(body.assigneeSilence[0]).sort()).toEqual(['daysSinceLastActivity', 'hasGoneSilent', 'lastActivityAt', 'userId', 'userName']);
    expect(silence['sub-1']).toMatchObject({ userName: 'Sub One', lastActivityAt: new Date(NOW - DAY).toISOString(), daysSinceLastActivity: 1, hasGoneSilent: false });
    // sub-2 never acted: baseline is the task's createdAt (5 days ago) -> silent
    expect(silence['sub-2']).toMatchObject({ userName: 'Sub Two', lastActivityAt: new Date(NOW - 5 * DAY).toISOString(), daysSinceLastActivity: 5, hasGoneSilent: true });

    const q = queryLog.find((x) => x.coll === 'tasks/task-1/activity');
    expect(q?.limitValue).toBe(100);
    expect(q?.orderField).toBe('createdAt');
  });

  it('C-ACT-03: guards — GET 404 unknown task; POST 400 invalid type; POST 404 unknown task', async () => {
    seedActivity();
    const nf: any = await activityGET(makeRequest('http://localhost/api/tasks/ghost/activity'), { params: Promise.resolve({ id: 'ghost' }) });
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ error: 'Task not found' });

    const badType: any = await activityPOST(makeRequest('http://localhost/api/tasks/task-1/activity', { type: 'status', data: {} }), { params: Promise.resolve({ id: 'task-1' }) });
    expect(badType.status).toBe(400);
    expect(await badType.json()).toEqual({ error: 'Invalid activity type' });

    const postNf: any = await activityPOST(makeRequest('http://localhost/api/tasks/ghost/activity', { type: 'comment', data: {} }), { params: Promise.resolve({ id: 'ghost' }) });
    expect(postNf.status).toBe(404);
    expect(await postNf.json()).toEqual({ error: 'Task not found' });
  });
});

/* ----------------------------------------------------- VALIDATION */
describe('C-VAL: GET /api/tasks/[id]/validation', () => {
  it('C-VAL-01: allowed via chain', async () => {
    tasksStore.set('task-1', { status: 'submitted-for-review', submittedBy: 'sub-1', assigneeId: 'sub-1' });
    mockCanValidate.mockResolvedValue({ allowed: true, via: 'chain', depth: 2 });
    const res: any = await validationGET(makeRequest('http://localhost/api/tasks/task-1/validation'), { params: Promise.resolve({ id: 'task-1' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ canValidate: true, via: 'chain', depth: 2, isSubmitter: false });
  });

  it('C-VAL-01b: not allowed -> via null even if the check named one; own submission flagged', async () => {
    tasksStore.set('task-1', { status: 'submitted-for-review', submittedBy: CALLER, assigneeId: CALLER });
    mockCanValidate.mockResolvedValue({ allowed: false, via: 'chain', depth: 1 });
    const res: any = await validationGET(makeRequest('http://localhost/api/tasks/task-1/validation'), { params: Promise.resolve({ id: 'task-1' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ canValidate: false, via: null, depth: 1, isSubmitter: true });
  });

  it('C-VAL-02: check throws -> degraded 200, not 500', async () => {
    tasksStore.set('task-1', { status: 'submitted-for-review', submittedBy: 'sub-1', assigneeId: 'sub-1' });
    mockCanValidate.mockRejectedValue(new Error('chain exploded'));
    const res: any = await validationGET(makeRequest('http://localhost/api/tasks/task-1/validation'), { params: Promise.resolve({ id: 'task-1' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ canValidate: false, via: null, depth: null, isSubmitter: false });
  });

  it('C-VAL-03: unknown task -> 404 exact body', async () => {
    const res: any = await validationGET(makeRequest('http://localhost/api/tasks/ghost/validation'), { params: Promise.resolve({ id: 'ghost' }) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Task not found' });
  });
});
