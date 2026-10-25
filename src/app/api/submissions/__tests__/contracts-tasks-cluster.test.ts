/**
 * @jest-environment node
 *
 * BEHAVIOR CONTRACTS — tasks cluster, group 5 surface (submissions):
 * GET /api/submissions as it touches the tasks cluster, recorded from
 * the CURRENT Firestore implementation at feat/integration-wave3 @
 * 4d5a1e16, ahead of feat/supa-tasks-5 (seam-submissions).
 *
 * !!! SCOPE FINDING — THERE IS NO TASK JOIN !!!
 * At 4d5a1e16 the submissions route contains ZERO references to tasks
 * (verified: `grep -n "task" src/app/api/submissions/route.ts` is
 * empty, and the tasks-5 implementer's own join inventory —
 * supa-rebase-notes on feat/supa-tasks-5, commit 1e1ba6c — states
 * "submissions route touches zero task docs"). The cluster's
 * submission<->task coupling lives in the approval-rate computation
 * (pinned in contracts-secondary.test.ts, C-AR) and the review-queue,
 * NOT here. These contracts therefore pin the submissions list
 * surface itself, and pin the ABSENCE of a join: the mock db throws
 * on ANY collection other than 'submissions', so a future seam that
 * starts reading tasks inside this route fails loudly here and must
 * be re-pinned deliberately.
 *
 * Contracts:
 *   C-SUB-01  GET body: { success:true, submissions, count } with
 *             count === submissions.length.
 *   C-SUB-02  Item shape: { id, ...storedData } with EXACTLY three
 *             fields converted — submittedAt, reviewedAt, deadline —
 *             each to an ISO string, or null when absent/unreadable.
 *             Every other stored field passes through RAW (a stored
 *             Timestamp-like in any other field stays an object —
 *             pinned asymmetry; a jsonb seam must reproduce it, not
 *             "fix" it).
 *   C-SUB-03  Visibility: admins (canonical roles superadmin,
 *             founder_patron, chapter_president,
 *             national_vp_operations) see all, optionally filtered by
 *             ?userId=; non-admins are FORCED to userId == caller.
 *             ?status= adds a status == filter unless 'all'.
 *   C-SUB-04  Bounded read: orderBy submittedAt desc + limit, default
 *             50, explicit limit clamped to at most 100.
 *   C-SUB-05  Unauthenticated -> 401 { error:'Unauthorized' }.
 */

const ADMIN_CALLER = 'admin-1';
const MEMBER_CALLER = 'member-1';
let mockAuth: any = null;

function fakeTs(ms: number) {
  return { toMillis: () => ms, toDate: () => new Date(ms), seconds: Math.floor(ms / 1000) };
}

const docsStore: any[] = [];
type QLog = { wheres: Array<[string, string, any]>; orderField: string | null; limitValue: number | null };
const queryLog: QLog[] = [];
const collectionsTouched: string[] = [];

function makeQuery(wheres: Array<[string, string, any]> = [], orderField: string | null = null, limitValue: number | null = null): any {
  return {
    where: (f: string, op: string, v: any) => makeQuery([...wheres, [f, op, v]], orderField, limitValue),
    orderBy: (f: string) => makeQuery(wheres, f, limitValue),
    limit: (n: number) => makeQuery(wheres, orderField, n),
    get: async () => {
      queryLog.push({ wheres, orderField, limitValue });
      let rows = docsStore.filter((d) => wheres.every(([f, op, v]) => op === '==' && d.data[f] === v));
      if (limitValue !== null) rows = rows.slice(0, limitValue);
      return { docs: rows.map((d) => ({ id: d.id, data: () => d.data })) };
    },
  };
}

const mockDb = {
  collection: (name: string) => {
    collectionsTouched.push(name);
    if (name !== 'submissions') throw new Error(`unexpected collection: ${name} — submissions route must not read tasks (no task join at 4d5a1e16)`);
    return makeQuery();
  },
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

jest.mock('firebase-admin', () => ({
  firestore: { FieldValue: { serverTimestamp: () => ({ __fv: 'serverTimestamp' }), increment: (n: number) => ({ __fv: 'increment', n }) } },
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDb,
}));

jest.mock('@/lib/auth-middleware', () => ({ verifyAuthentication: async () => mockAuth }));

import { GET } from '../route';

function req(url: string): any {
  const r: any = { url, headers: { get: () => null }, cookies: { get: () => undefined }, json: async () => ({}) };
  r.clone = () => r;
  return r;
}

const T1 = 1_700_000_000_000;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  docsStore.length = 0; queryLog.length = 0; collectionsTouched.length = 0;
  mockAuth = { authenticated: true, user: { userId: ADMIN_CALLER, role: 'superadmin' } };
  docsStore.push(
    { id: 's-1', data: { userId: MEMBER_CALLER, status: 'approved', title: 'One', submittedAt: fakeTs(T1), reviewedAt: fakeTs(T1 + 1000), deadline: fakeTs(T1 + 2000), createdAt: fakeTs(T1) } },
    { id: 's-2', data: { userId: 'other-1', status: 'pending', title: 'Two', submittedAt: fakeTs(T1 + 5000) } },
  );
});
afterEach(() => { jest.restoreAllMocks(); });

describe('C-SUB: GET /api/submissions', () => {
  it('C-SUB-01/02/04: admin body, three-field ISO conversion, raw passthrough elsewhere, default limit 50', async () => {
    const res: any = await GET(req('http://localhost/api/submissions'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.count).toBe(2);
    const s1 = body.submissions.find((s: any) => s.id === 's-1');
    expect(s1.submittedAt).toBe(new Date(T1).toISOString());
    expect(s1.reviewedAt).toBe(new Date(T1 + 1000).toISOString());
    expect(s1.deadline).toBe(new Date(T1 + 2000).toISOString());
    // PINNED ASYMMETRY: createdAt is NOT one of the converted fields.
    expect(typeof s1.createdAt).toBe('object');
    expect(s1.createdAt.seconds).toBe(Math.floor(T1 / 1000));
    const s2 = body.submissions.find((s: any) => s.id === 's-2');
    expect(s2.reviewedAt).toBeNull(); // absent -> null
    expect(s2.deadline).toBeNull();
    const q = queryLog[0];
    expect(q.orderField).toBe('submittedAt');
    expect(q.limitValue).toBe(50);
    expect(q.wheres).toEqual([]); // admin, no userId param, status 'all'
    expect(collectionsTouched).toEqual(['submissions']); // NO task join
  });

  it('C-SUB-03: non-admin forced to own submissions; status filter applies', async () => {
    mockAuth = { authenticated: true, user: { userId: MEMBER_CALLER, role: 'member' } };
    const res: any = await GET(req('http://localhost/api/submissions?status=approved&userId=other-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    // The ?userId=other-1 param is IGNORED for non-admins: forced self.
    expect(queryLog[0].wheres).toEqual([['userId', '==', MEMBER_CALLER], ['status', '==', 'approved']]);
    expect(body.submissions.map((s: any) => s.id)).toEqual(['s-1']);
  });

  it('C-SUB-04b: explicit limit clamps to 100', async () => {
    await GET(req('http://localhost/api/submissions?limit=999'));
    expect(queryLog[0].limitValue).toBe(100);
  });

  it('C-SUB-05: unauthenticated -> 401 exact body', async () => {
    mockAuth = { authenticated: false, user: null };
    const res: any = await GET(req('http://localhost/api/submissions'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });
});
