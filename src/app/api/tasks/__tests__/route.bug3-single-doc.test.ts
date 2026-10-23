/**
 * Regression tests for Bug 3 (dual-assignee duplication):
 * POST /api/tasks must create ONE shared task doc for N assignees.
 *
 * - Single-doc creation: one tasks.add() carrying assigneeId = primary
 *   (first sorted) assignee and assigneeIds = full sorted team; the
 *   acceptanceBy map is seeded per assignee; per-assignee fan-out
 *   (notifications, user counters) still runs per person; aggregates
 *   (project taskCount, workflow_members batch, activity log) run once.
 * - Idempotency guard: a retried POST with the same assignerId + trimmed
 *   title + deadline + assignee set within 60s returns the existing doc
 *   with deduped: true and writes nothing.
 */

const addedTaskDocs: Array<{ id: string; data: any }> = [];
const userSets: Array<{ uid: string; data: any }> = [];
const projectSets: Array<{ path: string; data: any }> = [];
const notifSets: Array<{ uid: string; data: any }> = [];
const activityAdds: Array<{ taskId: string; data: any }> = [];
const batchSets: Array<{ path: string; data: any }> = [];
let tasksWhereDocs: Array<{ id: string; data: () => any }> = [];

const mockDb = {
  collection: (name: string) => {
    if (name === 'tasks') {
      return {
        add: async (data: any) => {
          const id = `task-${addedTaskDocs.length + 1}`;
          addedTaskDocs.push({ id, data });
          return { id };
        },
        where: (field: string, op: string, val: any) => {
          // Faithful single-field equality filtering: the idempotency
          // guard queries where('dedupeKey', '==', key).
          const filtered = op === '=='
            ? tasksWhereDocs.filter((d) => (d.data() as any)?.[field] === val)
            : tasksWhereDocs;
          return {
            limit: () => ({ get: async () => ({ docs: filtered }) }),
            get: async () => ({ docs: filtered }),
          };
        },
        doc: (id: string) => ({
          id,
          collection: (sub: string) => {
            if (sub === 'activity') {
              return { add: async (data: any) => { activityAdds.push({ taskId: id, data }); return { id: 'act-1' }; } };
            }
            return { doc: () => ({ set: async (data: any) => { notifSets.push({ uid: id, data }); } }) };
          },
          get: async () => ({ exists: false, data: () => undefined }),
        }),
      };
    }
    if (name === 'users') {
      return {
        doc: (uid: string) => ({
          get: async () => ({
            exists: true,
            data: () => ({ displayName: `User ${uid}`, email: `${uid}@example.com` }),
          }),
          set: async (data: any) => { userSets.push({ uid, data }); },
          collection: () => ({
            doc: () => ({ set: async (data: any) => { notifSets.push({ uid, data }); } }),
          }),
        }),
      };
    }
    if (name === 'projects') {
      return {
        doc: (pid: string) => ({
          set: async (data: any) => { projectSets.push({ path: `projects/${pid}`, data }); },
        }),
      };
    }
    if (name === 'workflow_members') {
      return { doc: (mid: string) => ({ path: `workflow_members/${mid}` }) };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
  batch: () => ({
    set: (ref: any, data: any) => { batchSets.push({ path: ref.path, data }); },
    update: () => undefined,
    delete: () => undefined,
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
          now: () => ({ __ts: 'now' }),
          fromDate: (d: Date) => ({ __ts: 'fromDate', ms: d.getTime() }),
          fromMillis: (ms: number) => ({ __ts: 'fromMillis', ms }),
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
    verifyIdTokenString: async () => ({
      uid: 'assigner-1',
      email: 'assigner@example.com',
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
  canValidateTask: jest.fn(),
  getValidatorChainUids: jest.fn().mockResolvedValue([]),
  resolveDisplayName: jest.fn().mockResolvedValue('Test User'),
}));

const mockNotifyAcceptanceRequest = jest.fn();
jest.mock('@/lib/server/validation-notifications', () => ({
  notifyValidatorsOnSubmission: jest.fn(),
  notifyOnDecision: jest.fn(),
  notifyAcceptanceRequest: (...args: any[]) => mockNotifyAcceptanceRequest(...args),
  notifyChainOnDecline: jest.fn(),
}));

jest.mock('@/lib/server/validation-audit', () => ({
  logValidationDecision: jest.fn(),
  logDeniedValidationAttempt: jest.fn(),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(true),
  hasServerPermissionForUser: jest.fn().mockResolvedValue(true),
  resolveUserRole: jest.fn().mockResolvedValue('admin'),
  assertChapterAccess: jest.fn().mockResolvedValue({ allowed: true }),
}));

import { POST } from '../route';

function makeRequest(body: any): any {
  const req: any = { json: async () => body };
  req.clone = () => req;
  return req;
}

const FUTURE_ISO = new Date(Date.now() + 7 * 86400000).toISOString();

function makeBody(overrides: any = {}) {
  return {
    title: 'Team task',
    description: 'Do the thing together',
    assigneeIds: ['user-b', 'user-a'],
    deadline: FUTURE_ISO,
    status: 'pending',
    points: 10,
    projectId: 'proj-1',
    workflowId: 'wf-1',
    ...overrides,
  };
}

describe('POST /api/tasks Bug 3 single-doc creation', () => {
  beforeEach(() => {
    addedTaskDocs.length = 0;
    userSets.length = 0;
    projectSets.length = 0;
    notifSets.length = 0;
    activityAdds.length = 0;
    batchSets.length = 0;
    tasksWhereDocs = [];
    mockNotifyAcceptanceRequest.mockClear();
  });

  test('creates exactly ONE doc with normalized assignee fields', async () => {
    const res: any = await POST(makeRequest(makeBody()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // Exactly one task doc, returned as a single-element array.
    expect(addedTaskDocs).toHaveLength(1);
    expect(body.created).toHaveLength(1);
    expect(body.created[0].id).toBe('task-1');

    const doc = addedTaskDocs[0].data;
    // Normalize: dedupe + sort; assigneeId mirrors the primary (first).
    expect(doc.assigneeIds).toEqual(['user-a', 'user-b']);
    expect(doc.assigneeId).toBe('user-a');
    expect(body.created[0].assigneeId).toBe('user-a');

    // Acceptance map seeded for every assignee.
    expect(Object.keys(doc.acceptanceBy).sort()).toEqual(['user-a', 'user-b']);
    expect(doc.acceptanceBy['user-a'].status).toBe('pending-acceptance');
    expect(doc.acceptanceBy['user-b'].status).toBe('pending-acceptance');

    // Legacy singular fields mirror the primary assignee.
    expect(doc.acceptanceStatus).toBe('pending-acceptance');

    // Deterministic idempotency key is written on the doc.
    expect(doc.dedupeKey).toBe(
      JSON.stringify(['assigner-1', 'Team task', new Date(FUTURE_ISO).getTime(), ['user-a', 'user-b']])
    );

    // All assignees land in workflowParticipantIds.
    expect(doc.workflowParticipantIds).toEqual(
      expect.arrayContaining(['user-a', 'user-b', 'assigner-1'])
    );
  });

  test('per-assignee fan-out runs per person; aggregates run once', async () => {
    await POST(makeRequest(makeBody()));

    // User counters increment for BOTH assignees.
    const counterUids = userSets.map((s) => s.uid).sort();
    expect(counterUids).toEqual(['user-a', 'user-b']);
    for (const s of userSets) {
      expect(s.data.tasksAssignedCount).toEqual({ __fv: 'increment', n: 1 });
    }

    // In-app notifications go to both assignees (assigner is not one).
    const notifUids = notifSets.map((s) => s.uid).sort();
    expect(notifUids).toEqual(['user-a', 'user-b']);

    // Acceptance nudge fires ONCE for the whole team.
    expect(mockNotifyAcceptanceRequest).toHaveBeenCalledTimes(1);
    expect(mockNotifyAcceptanceRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        assigneeUids: ['user-a', 'user-b'],
        excludeUid: 'assigner-1',
      })
    );

    // Project taskCount increments exactly once (was double-counted per doc).
    expect(projectSets).toHaveLength(1);
    expect(projectSets[0].path).toBe('projects/proj-1');
    expect(projectSets[0].data.taskCount).toEqual({ __fv: 'increment', n: 1 });

    // Workflow members batch covers the whole team, committed once.
    const memberPaths = batchSets.map((b) => b.path).sort();
    expect(memberPaths).toEqual(['workflow_members/wf-1_assigner-1', 'workflow_members/wf-1_user-a', 'workflow_members/wf-1_user-b']);

    // Activity log written once.
    expect(activityAdds).toHaveLength(1);
    expect(activityAdds[0].taskId).toBe('task-1');
    expect(activityAdds[0].data.type).toBe('create');
  });

  test('idempotency guard dedupes a retried POST within 60s', async () => {
    const deadlineMs = new Date(FUTURE_ISO).getTime();
    const nowMs = Date.now();
    tasksWhereDocs = [
      {
        id: 'existing-1',
        data: () => ({
          assignerId: 'assigner-1',
          title: 'Team task',
          deadline: { toMillis: () => deadlineMs },
          assigneeIds: ['user-b', 'user-a'],
          dedupeKey: JSON.stringify(['assigner-1', 'Team task', deadlineMs, ['user-a', 'user-b']]),
          createdAt: { toMillis: () => nowMs },
        }),
      },
    ];

    const res: any = await POST(makeRequest(makeBody()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.deduped).toBe(true);
    expect(body.created).toEqual([{ id: 'existing-1', assigneeId: 'user-a' }]);

    // No new doc, no counters, no notifications, no nudge.
    expect(addedTaskDocs).toHaveLength(0);
    expect(userSets).toHaveLength(0);
    expect(notifSets).toHaveLength(0);
    expect(mockNotifyAcceptanceRequest).not.toHaveBeenCalled();
    expect(projectSets).toHaveLength(0);
  });

  test('idempotency guard ignores stale docs outside the 60s window', async () => {
    const deadlineMs = new Date(FUTURE_ISO).getTime();
    tasksWhereDocs = [
      {
        id: 'stale-1',
        data: () => ({
          assignerId: 'assigner-1',
          title: 'Team task',
          deadline: { toMillis: () => deadlineMs },
          assigneeIds: ['user-a', 'user-b'],
          dedupeKey: JSON.stringify(['assigner-1', 'Team task', deadlineMs, ['user-a', 'user-b']]),
          createdAt: { toMillis: () => Date.now() - 120_000 },
        }),
      },
    ];

    const res: any = await POST(makeRequest(makeBody()));
    const body = await res.json();
    expect(body.deduped).toBeUndefined();
    expect(addedTaskDocs).toHaveLength(1);
  });

  test('idempotency guard requires the same assignee set', async () => {
    const deadlineMs = new Date(FUTURE_ISO).getTime();
    tasksWhereDocs = [
      {
        id: 'other-team-1',
        data: () => ({
          assignerId: 'assigner-1',
          title: 'Team task',
          deadline: { toMillis: () => deadlineMs },
          assigneeIds: ['user-a'],
          // Different assignee set => different dedupeKey => no match.
          dedupeKey: JSON.stringify(['assigner-1', 'Team task', deadlineMs, ['user-a']]),
          createdAt: { toMillis: () => Date.now() },
        }),
      },
    ];

    const res: any = await POST(makeRequest(makeBody()));
    const body = await res.json();
    expect(body.deduped).toBeUndefined();
    expect(addedTaskDocs).toHaveLength(1);
  });
});
