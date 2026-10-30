/**
 * @jest-environment node
 *
 * PATCH /api/workflows/[id] — workflow-level deadline move.
 *
 * A workflow has no parent doc: POST /api/workflows denormalizes the
 * final deadline onto every step task doc as `deadline` (parent) and
 * `individualDeadline` (per-step). This endpoint must move BOTH fields
 * on EVERY step doc in one operation, mirror each doc through the
 * workflows-surface write mirror, and write a workflow_audits entry.
 * Until this handler existed, a workflow's deadline could not be
 * changed after creation at all (proven live 2026-10-27).
 */
const HOLDER = 'holder-1';
const NON_HOLDER = 'plain-1';

const mockVerifyAuth = jest.fn();
const mockForUser = jest.fn();
const mockMirror = jest.fn().mockResolvedValue(undefined);
const mockAudit = jest.fn().mockResolvedValue(undefined);

// ─── Fake Firestore ───────────────────────────────────────────────────────────
interface FakeDoc {
  id: string;
  ref: any;
  data: () => any;
}

let stepDocs: FakeDoc[] = [];
let batchUpdateCalls: Array<{ ref: any; updates: any }> = [];
let batchCommitCalls = 0;

function makeDoc(id: string, data: any): FakeDoc {
  const ref: any = {
    id,
    get: async () => ({ id, exists: true, data: () => data }),
  };
  return { id, ref, data: () => data };
}

const tasksQuery: any = {
  where: () => tasksQuery,
  // Train 2 bounded the steps query at 500; the fake models it.
  limit: () => tasksQuery,
  get: async () => ({
    empty: stepDocs.length === 0,
    docs: stepDocs,
  }),
};

const mockDb: any = {
  collection: (name: string) => {
    if (name === 'tasks') return tasksQuery;
    throw new Error(`unexpected collection ${name}`);
  },
  batch: () => ({
    update: (ref: any, updates: any) => {
      batchUpdateCalls.push({ ref, updates });
    },
    commit: async () => {
      batchCommitCalls += 1;
    },
  }),
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
jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDb,
  admin: {
    firestore: {
      FieldValue: { serverTimestamp: () => '__SERVER_TS__' },
    },
  },
}));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: (...args: any[]) => mockVerifyAuth(...args),
}));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: (...args: any[]) => mockForUser(...args),
}));
jest.mock('@/lib/server/workflow-cascade', () => ({
  deleteWorkflowCascade: jest.fn().mockResolvedValue({ deletedTasks: 0 }),
}));
jest.mock('@/lib/server/workflow-audit', () => ({
  logWorkflowAudit: (...args: any[]) => mockAudit(...args),
}));
jest.mock('@/lib/server/workflow-write-mirror', () => ({
  mirrorWorkflowTaskDocById: (...args: any[]) => mockMirror(...args),
  // Read-bleed train 2: the route now mirrors from the held payload.
  mirrorWorkflowTaskDocFromData: (...args: any[]) => mockMirror(...args),
}));

import { PATCH } from '../route';

const OLD_DEADLINE_ISO = '2026-10-29T18:59:00.000Z';
const NEW_DEADLINE_ISO = '2030-10-30T18:59:00.000Z';

function makeRequest(body: any): any {
  return {
    url: 'http://localhost/api/workflows/wf-1',
    json: async () => body,
  };
}
const params = { params: Promise.resolve({ id: 'wf-1' }) };

function authedAs(uid: string) {
  mockVerifyAuth.mockResolvedValue({
    authenticated: true,
    user: { userId: uid, email: 'x@example.com' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMirror.mockResolvedValue(undefined);
  mockAudit.mockResolvedValue(undefined);
  stepDocs = [
    makeDoc('task-1', { workflowId: 'wf-1', sequenceIndex: 0, deadline: new Date(OLD_DEADLINE_ISO), individualDeadline: new Date(OLD_DEADLINE_ISO) }),
    makeDoc('task-2', { workflowId: 'wf-1', sequenceIndex: 1, deadline: new Date(OLD_DEADLINE_ISO), individualDeadline: new Date('2026-10-28T03:42:00.000Z') }),
    makeDoc('task-3', { workflowId: 'wf-1', sequenceIndex: 2, deadline: new Date(OLD_DEADLINE_ISO), individualDeadline: new Date('2026-10-29T07:49:00.000Z') }),
  ];
  batchUpdateCalls = [];
  batchCommitCalls = 0;
  authedAs(HOLDER);
  mockForUser.mockResolvedValue(true);
});

describe('PATCH /api/workflows/[id] (deadline move)', () => {
  it('rejects unauthenticated callers with 401 and writes nothing', async () => {
    mockVerifyAuth.mockResolvedValue({ authenticated: false, user: null });
    const res: any = await PATCH(makeRequest({ deadline: NEW_DEADLINE_ISO }), params);
    expect(res.status).toBe(401);
    expect(batchUpdateCalls).toHaveLength(0);
    expect(batchCommitCalls).toBe(0);
    expect(mockMirror).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('rejects authenticated users without canManageTasks with 403', async () => {
    authedAs(NON_HOLDER);
    mockForUser.mockResolvedValue(false);
    const res: any = await PATCH(makeRequest({ deadline: NEW_DEADLINE_ISO }), params);
    expect(res.status).toBe(403);
    expect(mockForUser).toHaveBeenCalledWith(mockDb, NON_HOLDER, 'canManageTasks');
    expect(batchUpdateCalls).toHaveLength(0);
    expect(mockMirror).not.toHaveBeenCalled();
  });

  it('happy path: parent deadline + every step deadline move together, mirror + audit fire', async () => {
    const res: any = await PATCH(
      makeRequest({ deadline: NEW_DEADLINE_ISO, reason: 'Founder moved all crucible pods to Oct 30' }),
      params
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      workflowId: 'wf-1',
      deadline: NEW_DEADLINE_ISO,
      previousDeadline: OLD_DEADLINE_ISO,
      stepsUpdated: 3,
    });

    // Every step doc updated, both deadline fields set to the same value.
    expect(batchCommitCalls).toBe(1);
    expect(batchUpdateCalls).toHaveLength(3);
    expect(batchUpdateCalls.map((c) => c.ref.id).sort()).toEqual(['task-1', 'task-2', 'task-3']);
    for (const call of batchUpdateCalls) {
      expect(call.updates.deadline).toBeInstanceOf(Date);
      expect((call.updates.deadline as Date).toISOString()).toBe(NEW_DEADLINE_ISO);
      expect(call.updates.individualDeadline).toBeInstanceOf(Date);
      expect((call.updates.individualDeadline as Date).toISOString()).toBe(NEW_DEADLINE_ISO);
      expect(call.updates.updatedAt).toBe('__SERVER_TS__');
    }

    // Mirror dispatched once per step doc (workflows surface).
    expect(mockMirror).toHaveBeenCalledTimes(3);
    expect(mockMirror.mock.calls.map((c: any[]) => c[0]).sort()).toEqual(['task-1', 'task-2', 'task-3']);

    // Audit row carries actor, old value, new value, and reason.
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(mockDb, {
      action: 'workflow_deadline_updated',
      workflowId: 'wf-1',
      actorUid: HOLDER,
      details: {
        oldDeadline: OLD_DEADLINE_ISO,
        newDeadline: NEW_DEADLINE_ISO,
        stepsUpdated: 3,
        reason: 'Founder moved all crucible pods to Oct 30',
      },
    });
  });

  it('rejects an unparseable deadline with 400', async () => {
    const res: any = await PATCH(makeRequest({ deadline: 'not-a-date' }), params);
    expect(res.status).toBe(400);
    expect(batchUpdateCalls).toHaveLength(0);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('rejects a missing deadline with 400', async () => {
    const res: any = await PATCH(makeRequest({ reason: 'no date at all' }), params);
    expect(res.status).toBe(400);
    expect(batchUpdateCalls).toHaveLength(0);
  });

  it('rejects a past deadline with 400', async () => {
    const res: any = await PATCH(makeRequest({ deadline: '2020-01-01T00:00:00.000Z' }), params);
    expect(res.status).toBe(400);
    expect(batchUpdateCalls).toHaveLength(0);
    expect(mockMirror).not.toHaveBeenCalled();
  });

  it('returns 404 when no task carries the workflowId', async () => {
    stepDocs = [];
    const res: any = await PATCH(makeRequest({ deadline: NEW_DEADLINE_ISO }), params);
    expect(res.status).toBe(404);
    expect(batchUpdateCalls).toHaveLength(0);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
