/**
 * @jest-environment node
 *
 * MIGRATION-SIDE CONTRACTS — tasks cluster. These are the acceptance
 * rules every feat/supa-tasks-* seam (src/lib/supa/seam-*.ts,
 * useSupa('tasks'), default OFF, Firestore fallback) must satisfy.
 * They run against a REFERENCE seam double built to the documented
 * adapter API of feat/supa-adapter (src/lib/supa/adapter.ts @
 * 85e657f: getDoc/listDocs/countDocs over fs_<collection> jsonb
 * tables, Firestore-shaped { id, ...data } results; flags.ts:
 * SUPA_SURFACES env, case-insensitive, '*' = all, unset = all OFF),
 * because at recording time the implementer branches were still
 * landing. Per-branch verdicts from running the CURRENT-tree suites
 * inside each implementer's worktree are in
 * ~/workspace/supabase-migration/tasks-cluster/CONTRACTS.md.
 *
 * In the landing tables, a Firestore Timestamp serializes into jsonb
 * either as an ISO string (when the writer stringified it) or as the
 * raw JSON shape of a Timestamp instance: { seconds, nanoseconds }
 * (or { _seconds, _nanoseconds }). Both representations are
 * exercised below.
 *
 * Contract inventory:
 *   M-BOUND-01  No unbounded listDocs under the seam: every list read
 *               for a tasks surface carries an explicit numeric
 *               limit. The reference seam throws SeamBoundError when
 *               a list call omits the limit — the invariant an
 *               implementer's seam is graded against (its own tests
 *               must be able to observe the limit argument reaching
 *               the adapter; see CONTRACTS.md per-branch notes).
 *   M-BOUND-02  The limits are the CURRENT routes' limits, not new
 *               ones: tasks list = clamped request limit [1,500]
 *               (default 100); review-queue = 100; activity = 100;
 *               dedupe probe = 5. Surfaces whose Firestore legs are
 *               unbounded TODAY (team legs, approval-rate legs, the
 *               assignee union legs, getAllTasks) are enumerated in
 *               CONTRACTS.md as GAP hazards: a seam must either keep
 *               the result set identical with a stated bound >= the
 *               possible result size, or be flagged — never silently
 *               truncate.
 *   M-TS-01     Timestamp representation equivalence: Timestamp-like
 *               { toDate() }, ISO string, { seconds, nanoseconds },
 *               { _seconds, _nanoseconds } and epoch-millis forms of
 *               the same instant normalize to the IDENTICAL ISO
 *               string; null/undefined normalize to null.
 *   M-TS-02     POISON SHAPE: after seam normalization, none of the
 *               seven serialized task fields (deadline,
 *               individualDeadline, createdAt, updatedAt,
 *               completedAt, releasedAt, submittedAt) may still hold
 *               a { seconds }/{ _seconds } object, a number, or a
 *               Timestamp-like — each is an ISO string or null,
 *               exactly as the Firestore path emits.
 *   M-SHP-01    Fixture equivalence: the same logical task served
 *               from Firestore representation (Timestamp-likes
 *               through the current route serializer semantics) and
 *               from jsonb representation (ISO strings AND poison
 *               objects, through seam normalization) produces
 *               deep-equal response items.
 *   M-FLAG-01   Flag semantics (flags.ts of feat/supa-adapter):
 *               unset/empty -> OFF for every surface; 'tasks' -> ON
 *               for 'tasks' only; case-insensitive with whitespace
 *               trimmed; '*' -> ON for everything.
 *   M-FALL-01   Adapter error -> Firestore fallback: when the adapter
 *               call throws, the seam serves the Firestore result and
 *               the fallback is observable; when the adapter
 *               succeeds, Firestore is never called.
 *   M-DLG-01    Delegate flag invariance (FD-01): with
 *               SUPA_SURFACES unset, '=tasks' and '=*', POST
 *               /api/tasks/delegate for an existing task returns the
 *               identical 403 body and PATCH returns the identical
 *               400 body. On the base tree the route ignores the flag
 *               (no seam exists yet) so this passes trivially; on
 *               feat/supa-tasks-4 it is the real flag-ON gate,
 *               including the adapter-configured and adapter-error
 *               paths (no SUPABASE_URL in test env -> a correct seam
 *               falls back to Firestore before any read).
 */

/* ------------------------------------------------ reference seam */
class SeamBoundError extends Error {
  constructor(surface: string) { super(`seam list for ${surface} called without a limit`); this.name = 'SeamBoundError'; }
}

function normalizeTs(v: any): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v?.toDate === 'function') return v.toDate().toISOString();
  const seconds = typeof v?.seconds === 'number' ? v.seconds : (typeof v?._seconds === 'number' ? v._seconds : null);
  if (seconds !== null) {
    const nanos = typeof v?.nanoseconds === 'number' ? v.nanoseconds : (typeof v?._nanoseconds === 'number' ? v._nanoseconds : 0);
    return new Date(seconds * 1000 + Math.floor(nanos / 1e6)).toISOString();
  }
  return null;
}

const SERIALIZED_TS_FIELDS = ['deadline', 'individualDeadline', 'createdAt', 'updatedAt', 'completedAt', 'releasedAt', 'submittedAt'] as const;

function seamNormalizeTaskDoc(doc: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...doc };
  for (const f of SERIALIZED_TS_FIELDS) out[f] = normalizeTs(doc[f]);
  return out;
}

/** The current route serializer's semantics, replicated exactly
 *  (route.ts GET: toDate -> ISO; { seconds } -> ISO; else passthrough;
 *  falsy -> null). */
function firestoreSerializeTs(ts: any) {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
  if (ts.seconds) return new Date(ts.seconds * 1000).toISOString();
  return ts;
}
function firestoreSerializeTaskDoc(doc: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...doc };
  for (const f of SERIALIZED_TS_FIELDS) out[f] = firestoreSerializeTs(doc[f]);
  return out;
}

type ListCall = { collection: string; options?: { limit?: number } };
function makeReferenceSeam(rows: Record<string, any[]>) {
  const calls: ListCall[] = [];
  return {
    calls,
    adapter: {
      listDocs: async (collection: string, options?: { limit?: number }) => {
        calls.push({ collection, options });
        return (rows[collection] || []).slice(0, options?.limit);
      },
      getDoc: async (collection: string, id: string) => (rows[collection] || []).find((r) => r.id === id) ?? null,
    },
    async listSurface(surface: string, collection: string, limit?: number) {
      if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) throw new SeamBoundError(surface);
      const docs = await this.adapter.listDocs(collection, { limit });
      return docs.map((d: any) => seamNormalizeTaskDoc(d));
    },
    async readWithFallback<T>(adapterCall: () => Promise<T>, firestoreCall: () => Promise<T>) {
      try {
        return { value: await adapterCall(), fellBack: false };
      } catch {
        return { value: await firestoreCall(), fellBack: true };
      }
    },
  };
}

function parseSupaSurfaces(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}
function useSupaDouble(surface: string, raw: string | undefined): boolean {
  const surfaces = parseSupaSurfaces(raw);
  if (surfaces.size === 0) return false;
  if (surfaces.has('*')) return true;
  return surfaces.has(surface.trim().toLowerCase());
}

/* --------------------------------------------------- fixtures */
const MS = 1_700_000_100_000;
const ISO = new Date(MS).toISOString();
function fakeTs(ms: number) {
  return { toMillis: () => ms, toDate: () => new Date(ms), seconds: Math.floor(ms / 1000), nanoseconds: 0 };
}

/* ------------------------------------------------------ suites */
describe('M-BOUND: bounded seam lists', () => {
  it('M-BOUND-01: a list call without a limit is a hard seam error', async () => {
    const seam = makeReferenceSeam({ tasks: [] });
    await expect(seam.listSurface('tasks', 'tasks', undefined)).rejects.toBeInstanceOf(SeamBoundError);
    await expect(seam.listSurface('tasks', 'tasks', 0)).rejects.toBeInstanceOf(SeamBoundError);
    expect(seam.calls).toHaveLength(0); // adapter never touched unbounded
  });

  it('M-BOUND-02: the current routes\u2019 limits reach the adapter verbatim', async () => {
    const rows = { tasks: Array.from({ length: 600 }, (_, i) => ({ id: `t-${i}`, title: 'x', createdAt: ISO })) };
    const seam = makeReferenceSeam(rows);
    const page = await seam.listSurface('tasks', 'tasks', 500); // clamped max of GET /api/tasks
    expect(page).toHaveLength(500);
    expect(seam.calls[0].options?.limit).toBe(500);
    await seam.listSurface('tasks', 'tasks', 100); // review-queue / activity / default list bound
    expect(seam.calls[1].options?.limit).toBe(100);
    await seam.listSurface('tasks', 'tasks', 5); // dedupe probe bound
    expect(seam.calls[2].options?.limit).toBe(5);
  });
});

describe('M-TS: timestamp representation equivalence', () => {
  it('M-TS-01: every representation of the same instant normalizes identically', () => {
    const forms: any[] = [
      fakeTs(MS),
      ISO,
      MS,
      { seconds: Math.floor(MS / 1000), nanoseconds: 0 },
      { _seconds: Math.floor(MS / 1000), _nanoseconds: 0 },
    ];
    for (const form of forms) expect(normalizeTs(form)).toBe(ISO);
    expect(normalizeTs(null)).toBeNull();
    expect(normalizeTs(undefined)).toBeNull();
  });

  it('M-TS-02: poison shapes never survive seam normalization in the serialized fields', () => {
    const poisoned: Record<string, any> = { id: 't-1', title: 'T' };
    for (const f of SERIALIZED_TS_FIELDS) poisoned[f] = { seconds: Math.floor(MS / 1000), nanoseconds: 0 };
    const out = seamNormalizeTaskDoc(poisoned);
    for (const f of SERIALIZED_TS_FIELDS) {
      expect(typeof out[f]).toBe('string');
      expect(out[f]).toBe(ISO);
    }
  });
});

describe('M-SHP: fixture equivalence across stores', () => {
  it('M-SHP-01: Firestore-shaped and jsonb-shaped fixtures serialize deep-equal', () => {
    const firestoreDoc: Record<string, any> = {
      id: 't-1', title: 'Task', status: 'pending', points: 5, assigneeId: 'u-1',
      createdAt: fakeTs(MS), deadline: fakeTs(MS + 1000), updatedAt: fakeTs(MS + 2000),
    };
    const jsonbIsoDoc: Record<string, any> = {
      id: 't-1', title: 'Task', status: 'pending', points: 5, assigneeId: 'u-1',
      createdAt: ISO, deadline: new Date(MS + 1000).toISOString(), updatedAt: new Date(MS + 2000).toISOString(),
    };
    const jsonbPoisonDoc: Record<string, any> = {
      id: 't-1', title: 'Task', status: 'pending', points: 5, assigneeId: 'u-1',
      createdAt: { seconds: Math.floor(MS / 1000), nanoseconds: 0 },
      deadline: { _seconds: Math.floor((MS + 1000) / 1000), _nanoseconds: 0 },
      updatedAt: { seconds: Math.floor((MS + 2000) / 1000), nanoseconds: 0 },
    };
    const expected = firestoreSerializeTaskDoc(firestoreDoc);
    expect(seamNormalizeTaskDoc(jsonbIsoDoc)).toEqual(expected);
    expect(seamNormalizeTaskDoc(jsonbPoisonDoc)).toEqual(expected);
    // Absent fields serialize to null on BOTH paths.
    expect(expected.completedAt).toBeNull();
    expect(seamNormalizeTaskDoc(jsonbIsoDoc).completedAt).toBeNull();
  });
});

describe('M-FLAG / M-FALL: flag semantics and adapter-error fallback', () => {
  it('M-FLAG-01: SUPA_SURFACES parsing matches flags.ts semantics', () => {
    expect(useSupaDouble('tasks', undefined)).toBe(false);
    expect(useSupaDouble('tasks', '')).toBe(false);
    expect(useSupaDouble('tasks', 'tasks')).toBe(true);
    expect(useSupaDouble('users', 'tasks')).toBe(false);
    expect(useSupaDouble('tasks', ' TASKS ')).toBe(true);
    expect(useSupaDouble('tasks', 'announcements,tasks')).toBe(true);
    expect(useSupaDouble('anything', '*')).toBe(true);
  });

  it('M-FALL-01: adapter throw -> Firestore value served, fallback observable; adapter success -> Firestore untouched', async () => {
    const seam = makeReferenceSeam({});
    let firestoreCalls = 0;
    const firestoreCall = async () => { firestoreCalls++; return 'from-firestore'; };
    const ok = await seam.readWithFallback(async () => 'from-supa', firestoreCall);
    expect(ok).toEqual({ value: 'from-supa', fellBack: false });
    expect(firestoreCalls).toBe(0);
    const bad = await seam.readWithFallback(async () => { throw new Error('supa down'); }, firestoreCall);
    expect(bad).toEqual({ value: 'from-firestore', fellBack: true });
    expect(firestoreCalls).toBe(1);
  });
});

/* ------------------------------------------- M-DLG: real route */
const CALLER = 'caller-1';
let mockAuth: any = null;
const delegateTaskData = { title: 'Parent', assigneeId: CALLER, assigneeIds: [CALLER], points: 10, status: 'pending' };
const delegateDb = {
  collection: (name: string) => {
    if (name !== 'tasks') throw new Error(`unexpected collection: ${name}`);
    return { doc: (id: string) => ({ id, get: async () => ({ exists: true, data: () => delegateTaskData }), update: async () => undefined, collection: () => ({ doc: () => ({}) }) }) };
  },
  batch: () => ({ set: () => undefined, update: () => undefined, commit: async () => undefined }),
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
jest.mock('@/lib/server/firebase-admin', () => ({
  admin: { firestore: { FieldValue: { serverTimestamp: () => ({ __fv: 'serverTimestamp' }), increment: (n: number) => ({ __fv: 'increment', n }) }, FieldPath: { documentId: () => ({ __docid: true }) } } },
  getDb: () => delegateDb,
  ensureAdminInitialized: () => true,
}));
jest.mock('@/lib/auth-middleware', () => ({ verifyAuthentication: async () => mockAuth }));
jest.mock('@/lib/workflow-utils', () => ({ calculateWorkflowDeadlines: jest.fn(() => []) }));
jest.mock('@/lib/mailer', () => ({ sendEmailNotification: jest.fn().mockResolvedValue(undefined) }));

import { POST as delegatePOST, PATCH as delegatePATCH } from '../delegate/route';

function delegateReq(body: any): any {
  const r: any = { url: 'http://localhost/api/tasks/delegate', json: async () => body, headers: { get: () => null }, cookies: { get: () => undefined } };
  r.clone = () => r;
  return r;
}

describe('M-DLG-01: delegate FD-01 invariance across flag states', () => {
  const savedEnv = process.env.SUPA_SURFACES;
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockAuth = { authenticated: true, user: { user: { uid: CALLER }, userId: CALLER, email: 'c@example.com', displayName: 'Caller', emailVerified: true, role: 'member' } };
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (savedEnv === undefined) delete process.env.SUPA_SURFACES; else process.env.SUPA_SURFACES = savedEnv;
  });

  it.each([[undefined], ['tasks'], ['*']])('SUPA_SURFACES=%s: POST still 403 FD-01 body, PATCH still 400 TS-P01 body', async (flagValue) => {
    if (flagValue === undefined) delete process.env.SUPA_SURFACES; else process.env.SUPA_SURFACES = flagValue;
    const post: any = await delegatePOST(delegateReq({ taskId: 'task-1', pointsKept: 0, workflowSteps: [{ title: 'S', assigneeId: 'sub-1', points: 10 }] }));
    expect(post.status).toBe(403);
    expect(await post.json()).toEqual({ error: 'Only the task assignee can delegate' });
    const patch: any = await delegatePATCH(delegateReq({ taskId: 'task-1', action: 'accept' }));
    expect(patch.status).toBe(400);
    expect(await patch.json()).toEqual({ error: 'No pending delegation' });
  });
});
