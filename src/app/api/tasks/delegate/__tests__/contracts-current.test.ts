/**
 * @jest-environment node
 *
 * BEHAVIOR CONTRACTS — tasks cluster, group 4 surface:
 * POST+PATCH /api/tasks/delegate, recorded from the CURRENT Firestore
 * implementation at feat/integration-wave3 @ 4d5a1e16, ahead of
 * feat/supa-tasks-4 (seam: src/lib/supa/seam-tasks-delegate.ts,
 * useSupa('tasks'), default OFF, Firestore fallback).
 *
 * !!! FD-01 — THE LOUD PIN !!!
 * The delegate route is DEAD in production, and the migration must
 * keep it dead in exactly the same way until the separate defect-fix
 * program (fix/tasks-status-semantics) revives it:
 *   - The route reads the caller id as `(auth.user as any).uid`
 *     (POST route.ts:34, PATCH route.ts:234 at 4d5a1e16).
 *   - verifyAuthentication returns an AuthContext whose user object
 *     carries `userId` (and a nested decoded token at `user.user.uid`)
 *     — there is NO top-level `uid`. callerUid is therefore ALWAYS
 *     undefined.
 *   - POST: undefined never appears in a task's assigneeIds, so every
 *     authenticated POST for an EXISTING task ends at
 *     403 { error: 'Only the task assignee can delegate' }.
 *   - PATCH (TS-P01): nothing anywhere writes a `delegation` field on
 *     task docs, so every PATCH for an existing task ends at
 *     400 { error: 'No pending delegation' } — the delegatedTo check
 *     and the accept/reject writes below it are unreachable twice over.
 * If ANY test in this file starts failing because delegate began
 * SUCCEEDING, either FD-01 was fixed (re-pin deliberately, with the
 * fix branch named) or the Supabase seam changed flag-ON behavior —
 * which is a migration GAP, never a silent improvement.
 *
 * Contract inventory:
 *   C-DLG-01  POST unauthenticated -> 401 { error:'Unauthorized' }.
 *   C-DLG-02  POST without taskId -> 400 { error:'taskId is required' };
 *             without a non-empty workflowSteps array -> 400
 *             { error:'workflowSteps are required for orchestration' }.
 *             Both fire BEFORE any task read.
 *   C-DLG-03  POST unknown task -> 404 { error:'Task not found' }.
 *   C-DLG-04  POST existing task (any assignees, any points) -> 403
 *             { error:'Only the task assignee can delegate' } — FD-01.
 *             Even when the caller IS the assignee by userId. No batch
 *             is committed; no sub-task is written.
 *   C-DLG-05  PATCH unauthenticated -> 401; PATCH with a bad action ->
 *             400 { error:'taskId and action (accept/reject)
 *             required' }; PATCH unknown task -> 404.
 *   C-DLG-06  PATCH existing task with action accept AND reject ->
 *             400 { error:'No pending delegation' } — TS-P01. No
 *             update is written.
 *   C-DLG-07  The ONLY data read either handler performs on its
 *             reachable path is tasks/{taskId} doc get. The seam
 *             contract for feat/supa-tasks-4: exactly that read may be
 *             served by the adapter; identity, ordering and every
 *             response above stay byte-identical under flag ON, flag
 *             OFF, and adapter error (Firestore fallback).
 */

const CALLER = 'caller-1';

let mockAuth: any = null;
let taskData: any = null;
let taskExists = true;
const batchCommits = { n: 0 };
const docUpdates: any[] = [];
const reads: string[] = [];

const mockDb = {
  collection: (name: string) => {
    if (name !== 'tasks') throw new Error(`unexpected collection: ${name}`);
    return {
      doc: (id: string) => ({
        id,
        get: async () => { reads.push(id); return { exists: taskExists, data: () => taskData }; },
        update: async (data: any) => { docUpdates.push(data); },
        collection: () => ({ doc: () => ({}) }),
      }),
    };
  },
  batch: () => ({
    set: () => undefined,
    update: () => undefined,
    commit: async () => { batchCommits.n++; },
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

jest.mock('@/lib/server/firebase-admin', () => ({
  admin: {
    firestore: {
      FieldValue: {
        serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
        increment: (n: number) => ({ __fv: 'increment', n }),
      },
      FieldPath: { documentId: () => ({ __docid: true }) },
    },
  },
  getDb: () => mockDb,
  ensureAdminInitialized: () => true,
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => mockAuth,
}));

jest.mock('@/lib/workflow-utils', () => ({
  calculateWorkflowDeadlines: jest.fn(() => []),
}));

jest.mock('@/lib/mailer', () => ({ sendEmailNotification: jest.fn().mockResolvedValue(undefined) }));

import { POST, PATCH } from '../route';

function authedUser() {
  // The REAL AuthContext shape: userId at top level, uid ONLY nested
  // inside user.user (the decoded token). There is deliberately no
  // top-level `uid` here — adding one would hide FD-01.
  return {
    authenticated: true,
    user: { user: { uid: CALLER }, userId: CALLER, email: 'caller@example.com', displayName: 'Caller', emailVerified: true, role: 'member' },
  };
}

function makeRequest(body?: any): any {
  const req: any = {
    url: 'http://localhost/api/tasks/delegate',
    json: async () => body ?? {},
    headers: { get: () => null },
    cookies: { get: () => undefined },
  };
  req.clone = () => req;
  return req;
}

const validSteps = [{ title: 'Step 1', description: 'd', assigneeId: 'sub-1', points: 10 }];

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  mockAuth = authedUser();
  taskExists = true;
  // The caller IS the assignee by userId — FD-01 must still 403.
  taskData = { title: 'Parent task', assigneeId: CALLER, assigneeIds: [CALLER], points: 10, status: 'pending' };
  batchCommits.n = 0;
  docUpdates.length = 0;
  reads.length = 0;
});

afterEach(() => { jest.restoreAllMocks(); });

describe('C-DLG POST /api/tasks/delegate (FD-01 pinned)', () => {
  it('C-DLG-01: unauthenticated -> 401 exact body, no read', async () => {
    mockAuth = { authenticated: false, user: null };
    const res: any = await POST(makeRequest({ taskId: 'task-1', pointsKept: 0, workflowSteps: validSteps }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(reads).toHaveLength(0);
  });

  it('C-DLG-02: validation 400s fire before any task read', async () => {
    const noTask: any = await POST(makeRequest({ workflowSteps: validSteps }));
    expect(noTask.status).toBe(400);
    expect(await noTask.json()).toEqual({ error: 'taskId is required' });

    const noSteps: any = await POST(makeRequest({ taskId: 'task-1' }));
    expect(noSteps.status).toBe(400);
    expect(await noSteps.json()).toEqual({ error: 'workflowSteps are required for orchestration' });

    const emptySteps: any = await POST(makeRequest({ taskId: 'task-1', workflowSteps: [] }));
    expect(emptySteps.status).toBe(400);
    expect(reads).toHaveLength(0);
  });

  it('C-DLG-03: unknown task -> 404 exact body', async () => {
    taskExists = false;
    const res: any = await POST(makeRequest({ taskId: 'ghost', pointsKept: 0, workflowSteps: validSteps }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Task not found' });
    expect(reads).toEqual(['ghost']);
  });

  it('C-DLG-04 / FD-01: existing task ALWAYS 403s — even for the real assignee — and writes nothing', async () => {
    const res: any = await POST(makeRequest({ taskId: 'task-1', pointsKept: 0, workflowSteps: validSteps }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Only the task assignee can delegate' });
    expect(reads).toEqual(['task-1']); // the single reachable read (C-DLG-07)
    expect(batchCommits.n).toBe(0);
  });

  it('C-DLG-04b / FD-01: 403 precedes the points-mismatch 400 (ordering pin)', async () => {
    // points deliberately mismatched: if the assignee check ever
    // passed, this body would 400 instead. FD-01 keeps it at 403.
    const res: any = await POST(makeRequest({ taskId: 'task-1', pointsKept: 999, workflowSteps: validSteps }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Only the task assignee can delegate' });
  });
});

describe('C-DLG PATCH /api/tasks/delegate (TS-P01 pinned)', () => {
  it('C-DLG-05: unauthenticated -> 401; bad action -> 400; unknown task -> 404', async () => {
    mockAuth = { authenticated: false, user: null };
    const unauth: any = await PATCH(makeRequest({ taskId: 'task-1', action: 'accept' }));
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toEqual({ error: 'Unauthorized' });

    mockAuth = authedUser();
    const badAction: any = await PATCH(makeRequest({ taskId: 'task-1', action: 'maybe' }));
    expect(badAction.status).toBe(400);
    expect(await badAction.json()).toEqual({ error: 'taskId and action (accept/reject) required' });

    taskExists = false;
    const nf: any = await PATCH(makeRequest({ taskId: 'ghost', action: 'accept' }));
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ error: 'Task not found' });
  });

  it('C-DLG-06 / TS-P01: accept AND reject on an existing task -> 400 No pending delegation, no write', async () => {
    for (const action of ['accept', 'reject']) {
      const res: any = await PATCH(makeRequest({ taskId: 'task-1', action }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'No pending delegation' });
    }
    expect(docUpdates).toHaveLength(0);
    expect(reads).toEqual(['task-1', 'task-1']);
  });

  it('C-DLG-06c / FD-01 second facet: a PENDING delegation addressed to the caller still 403s (callerUid is undefined, never equal)', async () => {
    // No production writer creates this doc shape (TS-P01), but if one
    // ever exists, FD-01 alone still blocks the response path: the
    // delegatedTo comparison runs against undefined.
    taskData = { ...taskData, delegation: { status: 'pending', delegatedTo: CALLER } };
    const res: any = await PATCH(makeRequest({ taskId: 'task-1', action: 'accept' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(docUpdates).toHaveLength(0);
  });

  it('C-DLG-06b / TS-P01: even a task WITH a stored delegation field for the caller still 400s when status is not pending', async () => {
    taskData = { ...taskData, delegation: { status: 'accepted', delegatedTo: CALLER } };
    const res: any = await PATCH(makeRequest({ taskId: 'task-1', action: 'accept' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'No pending delegation' });
  });
});
