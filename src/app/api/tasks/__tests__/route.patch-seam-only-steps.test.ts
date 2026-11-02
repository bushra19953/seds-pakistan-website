/**
 * MSG22 fix #3: PATCH /api/tasks for a seam-only WORKFLOW STEP task.
 *
 * "Proof step" loads in the editor after fix #2 but its save always
 * carries the Workflow Plan steps payload, which the fix #2 classifier
 * refused wholesale. Fix #3 allows exactly one steps shape through:
 * steps=[this task's own step] where every encoded change is a
 * deadline-class change on that step. Everything else stays a loud
 * 409 with zero writes; both-stores docs keep the legacy path.
 */

const mockBatchOps: Array<{ op: string; path: string; data?: any; opts?: any }> = [];
const mockDocSets: Array<{ path: string; data: any; opts?: any }> = [];
const mockDocs: Record<string, any> = {};
const mockSeamStore: Record<string, any> = {};
const mockAdapterSetDoc = jest.fn(async (col: string, id: string, data: any) => {
  mockSeamStore[id] = { id, ...data };
});
const mockAdapter: any = {
  getDoc: jest.fn(async (_col: string, id: string) => mockSeamStore[id] ?? null),
  listDocs: jest.fn(async () => []),
  countDocs: jest.fn(async () => 0),
  setDoc: mockAdapterSetDoc,
  updateDoc: jest.fn(async () => undefined),
  deleteDoc: jest.fn(async () => undefined),
};

const mockDb = {
  collection: (name: string) => ({
    doc: (id?: string) => {
      const docId = id ?? 'generated-id';
      const path = `${name}/${docId}`;
      return {
        id: docId,
        path,
        get: async () => {
          const data = mockDocs[path];
          return { exists: data !== undefined, data: () => data };
        },
        set: async (data: any, opts?: any) => {
          mockDocSets.push({ path, data, opts });
          mockDocs[path] = { ...(mockDocs[path] || {}), ...data };
        },
      };
    },
    where: (field: string, _op: string, value: any) => ({
      limit: (_n: number) => ({
        get: async () => ({
          docs: Object.entries(mockDocs)
            .filter(([path, data]) => path.startsWith('tasks/') && data && data[field] === value)
            .map(([path, data]) => ({ id: path.split('/')[1], data: () => data })),
        }),
      }),
      get: async () => ({ docs: [] }),
    }),
  }),
  batch: () => ({
    update: (ref: any, data: any) => {
      mockBatchOps.push({ op: 'update', path: ref.path, data });
    },
    set: (ref: any, data: any, opts?: any) => {
      mockBatchOps.push({ op: 'set', path: ref.path, data, opts });
    },
    delete: (ref: any) => {
      mockBatchOps.push({ op: 'delete', path: ref.path });
    },
    commit: async () => undefined,
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
          now: () => ({ __ts: 'now', toDate: () => new Date() }),
          fromDate: (d: Date) => ({ __ts: 'fromDate', ms: d.getTime(), toDate: () => d }),
          fromMillis: (ms: number) => ({ __ts: 'fromMillis', ms, toDate: () => new Date(ms) }),
        },
        FieldValue,
      },
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
    verifyIdTokenString: async () => ({
      uid: 'admin-uid',
      role: 'admin',
      permissions: { manageTasks: true },
    }),
    SessionError: MockSessionError,
  };
});

jest.mock('@/lib/mailer', () => ({
  sendEmailNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/server/user-status', () => ({
  validateUserStatus: jest.fn().mockResolvedValue({ isValid: true }),
}));

jest.mock('@/lib/server/gamification-transaction', () => ({
  executeGamificationTransaction: jest.fn(),
}));

jest.mock('@/lib/server/hierarchy-utils', () => ({
  isManagerAbove: jest.fn().mockResolvedValue(false),
}));

jest.mock('@/lib/server/hierarchy', () => ({
  canValidateTask: jest.fn().mockResolvedValue({ allowed: true, reason: 'role', via: 'role', depth: 0 }),
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

jest.mock('@/lib/server/validation-audit', () => ({
  logValidationDecision: jest.fn().mockResolvedValue(undefined),
  logDeniedValidationAttempt: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(true),
  hasServerPermissionForUser: jest.fn().mockResolvedValue(true),
  resolveUserRole: jest.fn().mockResolvedValue('admin'),
  assertChapterAccess: jest.fn().mockResolvedValue({ allowed: true }),
}));

jest.mock('@/lib/server/discipline/suspension', () => ({
  suspensionBlock: jest.fn().mockResolvedValue(null),
}));

jest.mock('@/lib/supa/seam-tasks-route', () => {
  const actual = jest.requireActual('@/lib/supa/seam-tasks-route');
  return {
    ...actual,
    getTaskDocViaSeam: jest.fn(async (id: string) => {
      const data = mockSeamStore[id];
      return data ? { exists: true, data: { ...data } } : { exists: false, data: null };
    }),
    resolveTasksSupaAdapter: jest.fn(async () => mockAdapter),
    tasksPrimaryActive: jest.fn(async () => true),
  };
});


import { PATCH } from '../route';
import { __setTasksSupaAdapterForTests } from '@/lib/supa/seam-tasks-route';

// The remaining MSG22 ghost: "Proof step", a workflow step doc that is
// itself the only step of its workflow (wf_1792898150639_dsz835).
const STEP_ID = '0PlwdSbGfnaJIXfnWTFg';
const WF_ID = 'wf_1792898150639_dsz835';
const OLD_DL = '2026-10-26T12:00:00.000Z';
const NEW_DL = '2026-11-03T08:30:00.000Z';
const STEP = {
  title: 'Proof step',
  description: 'Proof that a plain workflow step works',
  status: 'pending',
  assigneeId: 'member-uid',
  assigneeIds: ['member-uid'],
  assignerId: 'admin-uid',
  workflowId: WF_ID,
  workflowTitle: 'Mailer Proof — Workflow (Oct 25)',
  sequenceIndex: 0,
  deadline: OLD_DL,
  individualDeadline: OLD_DL,
  createdAt: '2026-10-25T10:00:00.000Z',
  updatedAt: '2026-10-25T10:00:00.000Z',
  points: 10,
  stepSpecificBadgeId: null,
  resources: [],
};

// The exact payload shape page.tsx handleUpdateWorkflowSteps assembles
// when an admin edits a workflow-step task and changes only the
// deadline: task-level fields (deadline written to individualDeadline,
// the field this task's dialog reads), plus steps=[the step itself]
// carrying the new step override deadline.
function dialogPayload(stepOverrides: Record<string, any> = {}, taskOverrides: Record<string, any> = {}) {
  return {
    taskId: STEP_ID,
    updates: {
      title: STEP.title,
      description: STEP.description,
      assigneeId: 'member-uid',
      assigneeIds: ['member-uid'],
      points: 10,
      resources: [],
      individualDeadline: NEW_DL,
      status: 'pending',
      steps: [
        {
          id: STEP_ID,
          title: STEP.title,
          description: STEP.description,
          assigneeId: 'member-uid',
          assigneeIds: ['member-uid'],
          individualDeadline: NEW_DL,
          resources: [],
          ...stepOverrides,
        },
      ],
      ...taskOverrides,
    },
  };
}

function makeRequest(body: any): any {
  const req: any = { json: async () => body };
  req.clone = () => req;
  return req;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBatchOps.length = 0;
  mockDocSets.length = 0;
  for (const k of Object.keys(mockDocs)) delete mockDocs[k];
  for (const k of Object.keys(mockSeamStore)) delete mockSeamStore[k];
  mockSeamStore[STEP_ID] = { ...STEP };
  process.env.SUPA_SURFACES = 'tasks';
  (__setTasksSupaAdapterForTests as any)(mockAdapter);
});

afterEach(() => {
  delete process.env.SUPA_SURFACES;
});

describe('PATCH /api/tasks seam-only step task, deadline-only own-step edit (MSG22 fix #3)', () => {
  it('(a) dialog payload (steps=[itself], deadline + step override changed) commits through the primary store', async () => {
    const res: any = await PATCH(makeRequest(dialogPayload()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.seamOnly).toBe(true);
    // Both deadline fields on this doc's image hold the new value; the
    // workflow-level deadline field itself is untouched by the step fold.
    expect(mockSeamStore[STEP_ID].individualDeadline).toBe(NEW_DL);
    expect(mockSeamStore[STEP_ID].deadline).toBe(OLD_DL);
    expect(mockSeamStore[STEP_ID].title).toBe(STEP.title);
    expect(mockSeamStore[STEP_ID].status).toBe('pending');
    expect('steps' in mockSeamStore[STEP_ID]).toBe(false);
    // No Firestore batch write on the missing doc; mirror merge-set only.
    expect(mockBatchOps.filter((o) => o.path === `tasks/${STEP_ID}`)).toHaveLength(0);
    const mirror = mockDocSets.find((s) => s.path === `tasks/${STEP_ID}`);
    expect(mirror).toBeDefined();
    expect((mirror!.data.individualDeadline as any).__ts).toBe('fromDate');
  });

  it('(a2) the real live shape: task-level deadline NEW, persisted step override unchanged (OLD) -> task-level value lands', async () => {
    // Persisted steps are exempt from the form's deadline re-split, so
    // when the admin changes only the dialog's main deadline field the
    // step entry still carries its stored override. Legacy batch order
    // (master update queued last) resolves this for the task-level
    // value; the seam-only image must hold the NEW deadline.
    const res: any = await PATCH(
      makeRequest(dialogPayload({ individualDeadline: OLD_DL }))
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.seamOnly).toBe(true);
    expect(mockSeamStore[STEP_ID].individualDeadline).toBe(NEW_DL);
  });

  it('(b) a different step deadline change is refused loudly, zero writes', async () => {
    const payload = dialogPayload();
    (payload.updates.steps as any[]).push({
      id: 'another-step-id',
      title: 'Other step',
      description: '',
      assigneeId: 'member-uid',
      assigneeIds: ['member-uid'],
      individualDeadline: NEW_DL,
      resources: [],
    });
    const res: any = await PATCH(makeRequest(payload));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error_code).toBe('task_seam_only_complex_edit');
    expect(mockSeamStore[STEP_ID].individualDeadline).toBe(OLD_DL);
    expect(mockAdapterSetDoc).not.toHaveBeenCalled();
    expect(mockBatchOps).toHaveLength(0);
    expect(mockDocSets).toHaveLength(0);
  });

  it('(c) a non-deadline change on its own step (title) is refused loudly, zero writes', async () => {
    const res: any = await PATCH(makeRequest(dialogPayload({ title: 'Renamed step' })));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error_code).toBe('task_seam_only_complex_edit');
    expect(mockSeamStore[STEP_ID].individualDeadline).toBe(OLD_DL);
    expect(mockAdapterSetDoc).not.toHaveBeenCalled();
    expect(mockBatchOps).toHaveLength(0);
    expect(mockDocSets).toHaveLength(0);
  });

  it('(c2) a non-deadline change on its own step (assignee) is refused loudly, zero writes', async () => {
    const res: any = await PATCH(
      makeRequest(dialogPayload({ assigneeId: 'other-uid', assigneeIds: ['other-uid'] }))
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error_code).toBe('task_seam_only_complex_edit');
    expect(mockAdapterSetDoc).not.toHaveBeenCalled();
    expect(mockBatchOps).toHaveLength(0);
    expect(mockDocSets).toHaveLength(0);
  });

  it('(d) both-stores step task with the same payload keeps the legacy Firestore path', async () => {
    mockDocs[`tasks/${STEP_ID}`] = { ...STEP };
    const res: any = await PATCH(makeRequest(dialogPayload()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.seamOnly).toBeUndefined();
    const writes = mockBatchOps.filter(
      (o) => (o.op === 'update' || o.op === 'set') && o.path === `tasks/${STEP_ID}`
    );
    expect(writes.length).toBeGreaterThan(0);
    // (The adapter may still receive the post-commit mirror image on
    // the legacy path; the seam-only branch is identified by the
    // seamOnly flag and the ABSENCE of Firestore batch writes, both
    // asserted above and in (a).)
  });
});
