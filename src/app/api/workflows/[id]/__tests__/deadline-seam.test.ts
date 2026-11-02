/**
 * @jest-environment node
 *
 * PATCH /api/workflows/[id] — seam-first deadline move (MSG26 Job 1).
 *
 * Root cause: the handler resolved the workflow ONLY through
 * Firestore (`tasks` where workflowId == id). A workflow whose steps
 * live only in the Supabase mirror (the MSG22 store split) therefore
 * 404'd 'Workflow not found' here, while the mission itself reads
 * fine through the seam (missions detail route serves steps via
 * listMissionStepsViaSupa). The fix consults the seam first, the
 * same way MSG22 fix #2 fixed getTask: seam-served steps move
 * through the adapter as the primary write, with a best-effort
 * Firestore full-image merge-set mirror; seam-unavailable (null)
 * or seam-empty falls back to exactly today's Firestore path, so
 * every workflow that edits fine today keeps editing fine.
 */
const HOLDER = 'holder-1';

const mockVerifyAuth = jest.fn();
const mockForUser = jest.fn();
const mockMirror = jest.fn().mockResolvedValue(undefined);
const mockAudit = jest.fn().mockResolvedValue(undefined);
const mockListSeam = jest.fn();
const mockGetSeamAdapter = jest.fn();
const mockSupaUpdate = jest.fn().mockResolvedValue({});

// ─── Fake Firestore ───────────────────────────────────────────────────────────
interface FakeDoc {
  id: string;
  ref: any;
  data: () => any;
}

let stepDocs: FakeDoc[] = [];
let batchUpdateCalls: Array<{ ref: any; updates: any }> = [];
let batchCommitCalls = 0;
let fsSetCalls: Array<{ id: string; image: any; options: any }> = [];

function makeDoc(id: string, data: any): FakeDoc {
  const ref: any = {
    id,
    get: async () => ({ id, exists: true, data: () => data }),
  };
  return { id, ref, data: () => data };
}

const tasksQuery: any = {
  where: () => tasksQuery,
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

// Firestore doc() handle is only reached by the seam path's
// best-effort mirror; attach it to the tasks collection handle.
(tasksQuery as any).doc = (id: string) => ({
  set: async (image: any, options: any) => {
    fsSetCalls.push({ id, image, options });
  },
});
mockDb.collection = (name: string) => {
  if (name === 'tasks') {
    return {
      ...tasksQuery,
      doc: (tasksQuery as any).doc,
    };
  }
  throw new Error(`unexpected collection ${name}`);
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
      Timestamp: { fromDate: (d: Date) => ({ __timestamp: d.toISOString() }) },
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
  mirrorWorkflowTaskDocFromData: (...args: any[]) => mockMirror(...args),
}));
jest.mock('@/lib/server/mission-reads-supa', () => ({
  listMissionStepsViaSupa: (...args: any[]) => mockListSeam(...args),
  getMissionReadsSupaAdapter: (...args: any[]) => mockGetSeamAdapter(...args),
  TASKS_COLLECTION: 'tasks',
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

// Seam fixture: deliberately out of sequenceIndex order, so the test
// pins that previousDeadline comes from the lowest-sequence step.
function seamSteps() {
  return [
    { id: 'task-2', data: { workflowId: 'wf-1', sequenceIndex: 1, deadline: OLD_DEADLINE_ISO, individualDeadline: '2026-10-28T03:42:00.000Z' } },
    { id: 'task-3', data: { workflowId: 'wf-1', sequenceIndex: 2, deadline: OLD_DEADLINE_ISO, individualDeadline: '2026-10-29T07:49:00.000Z' } },
    { id: 'task-1', data: { workflowId: 'wf-1', sequenceIndex: 0, deadline: OLD_DEADLINE_ISO, individualDeadline: OLD_DEADLINE_ISO } },
  ];
}

function firestoreSteps() {
  return [
    makeDoc('task-1', { workflowId: 'wf-1', sequenceIndex: 0, deadline: new Date(OLD_DEADLINE_ISO), individualDeadline: new Date(OLD_DEADLINE_ISO) }),
    makeDoc('task-2', { workflowId: 'wf-1', sequenceIndex: 1, deadline: new Date(OLD_DEADLINE_ISO), individualDeadline: new Date('2026-10-28T03:42:00.000Z') }),
    makeDoc('task-3', { workflowId: 'wf-1', sequenceIndex: 2, deadline: new Date(OLD_DEADLINE_ISO), individualDeadline: new Date('2026-10-29T07:49:00.000Z') }),
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMirror.mockResolvedValue(undefined);
  mockAudit.mockResolvedValue(undefined);
  mockSupaUpdate.mockResolvedValue({});
  mockGetSeamAdapter.mockResolvedValue({ updateDoc: mockSupaUpdate });
  stepDocs = [];
  batchUpdateCalls = [];
  batchCommitCalls = 0;
  fsSetCalls = [];
  authedAs(HOLDER);
  mockForUser.mockResolvedValue(true);
});+describe('PATCH /api/workflows/[id] seam-first (MSG26 Job 1)', () => {
  it('mirror-only workflow: seam steps move, Firestore batch untouched, audit + response match legacy shape', async () => {
    // Firestore has NOTHING for wf-1; the seam has all three steps.
    mockListSeam.mockResolvedValue(seamSteps());
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

    // Primary write: one Supa updateDoc per step, both deadline
    // fields to the same new value, ISO shape for the mirror.
    expect(mockSupaUpdate).toHaveBeenCalledTimes(3);
    expect(mockSupaUpdate.mock.calls.map((c: any[]) => c[1]).sort()).toEqual(['task-1', 'task-2', 'task-3']);
    for (const call of mockSupaUpdate.mock.calls) {
      expect(call[0]).toBe('tasks');
      expect(call[2].deadline).toBe(NEW_DEADLINE_ISO);
      expect(call[2].individualDeadline).toBe(NEW_DEADLINE_ISO);
      expect(typeof call[2].updatedAt).toBe('string');
    }

    // Legacy Firestore batch never runs for seam-served steps.
    expect(batchUpdateCalls).toHaveLength(0);
    expect(batchCommitCalls).toBe(0);

    // Best-effort Firestore mirror: full image per step, merge-set.
    expect(fsSetCalls).toHaveLength(3);
    expect(fsSetCalls.map((c) => c.id).sort()).toEqual(['task-1', 'task-2', 'task-3']);
    for (const call of fsSetCalls) {
      expect(call.options).toEqual({ merge: true });
      expect(call.image.deadline).toEqual({ __timestamp: NEW_DEADLINE_ISO });
      expect(call.image.individualDeadline).toEqual({ __timestamp: NEW_DEADLINE_ISO });
    }

    // Audit identical to the legacy path.
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

  it('seam serves steps AND Firestore has steps: seam path wins, batch untouched', async () => {
    stepDocs = firestoreSteps();
    mockListSeam.mockResolvedValue(seamSteps());
    const res: any = await PATCH(makeRequest({ deadline: NEW_DEADLINE_ISO }), params);
    expect(res.status).toBe(200);
    expect(mockSupaUpdate).toHaveBeenCalledTimes(3);
    expect(batchUpdateCalls).toHaveLength(0);
    expect(mockMirror).not.toHaveBeenCalled();
  });

  it('seam empty falls back to the Firestore path exactly as today', async () => {
    stepDocs = firestoreSteps();
    mockListSeam.mockResolvedValue([]);
    const res: any = await PATCH(makeRequest({ deadline: NEW_DEADLINE_ISO }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stepsUpdated).toBe(3);
    expect(batchCommitCalls).toBe(1);
    expect(batchUpdateCalls).toHaveLength(3);
    expect(mockSupaUpdate).not.toHaveBeenCalled();
    expect(mockMirror).toHaveBeenCalledTimes(3);
  });

  it('seam unavailable (flag OFF) falls back to the Firestore path exactly as today', async () => {
    stepDocs = firestoreSteps();
    mockListSeam.mockResolvedValue(null);
    const res: any = await PATCH(makeRequest({ deadline: NEW_DEADLINE_ISO }), params);
    expect(res.status).toBe(200);
    expect(batchCommitCalls).toBe(1);
    expect(mockSupaUpdate).not.toHaveBeenCalled();
    expect(mockMirror).toHaveBeenCalledTimes(3);
  });

  it('seam empty + Firestore empty still 404s and writes nothing', async () => {
    mockListSeam.mockResolvedValue([]);
    const res: any = await PATCH(makeRequest({ deadline: NEW_DEADLINE_ISO }), params);
    expect(res.status).toBe(404);
    expect(mockSupaUpdate).not.toHaveBeenCalled();
    expect(batchUpdateCalls).toHaveLength(0);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('validation runs before any store consult: bad deadline writes nothing anywhere', async () => {
    mockListSeam.mockResolvedValue(seamSteps());
    const res: any = await PATCH(makeRequest({ deadline: 'not-a-date' }), params);
    expect(res.status).toBe(400);
    expect(mockListSeam).not.toHaveBeenCalled();
    expect(mockSupaUpdate).not.toHaveBeenCalled();
    expect(batchUpdateCalls).toHaveLength(0);
  });

  it('unauthenticated callers never reach the seam', async () => {
    mockVerifyAuth.mockResolvedValue({ authenticated: false, user: null });
    const res: any = await PATCH(makeRequest({ deadline: NEW_DEADLINE_ISO }), params);
    expect(res.status).toBe(401);
    expect(mockListSeam).not.toHaveBeenCalled();
    expect(mockSupaUpdate).not.toHaveBeenCalled();
  });
});
