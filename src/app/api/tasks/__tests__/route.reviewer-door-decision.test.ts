/**
 * @jest-environment node
 *
 * PATCH /api/tasks — named-reviewer decision pass-through
 * (reviewer-door fix, founder Option B 2026-10-28).
 *
 * The gap (REVIEWER_DOOR_GAP_CHECK.md, fixture-proven live): a basic
 * member who is a task's named reviewer of record passes the decision
 * gate (canValidateTask, reviewer arm) and is then denied by the
 * field-level gate with 403 "you are not assigned to this task",
 * because that gate only recognizes assignees. The queue shows them
 * the submission; the door behind it was locked.
 *
 * Under test here:
 *  (a) basic-member named reviewer CAN approve via the dialog's exact
 *      endpoint/body (200, completion path runs, stamps land);
 *  (b) CAN reject with a new deadline (200, deadline stored) — for a
 *      plain task (deadline field) and a workflow step
 *      (individualDeadline field);
 *  (c) CANNOT smuggle other fields: a pure title edit 403s, and a
 *      decision carrying an extra field (points) 403s;
 *  (d) a basic member who is NOT a reviewer of record gets 403 on a
 *      decision attempt (denied at the decision gate);
 *  (e) pre-existing flows are unchanged: the assigner approves, the
 *      assignee edits work-product fields, the assignee is still
 *      blocked from manager fields, a manager still edits anything.
 *
 * The canValidateTask mock mirrors the real gate's relevant arms
 * (self-approval deny, named-reviewer via the REAL
 * resolveTaskReviewerUids, assigner) so the test proves the route
 * composes the two gates instead of bypassing either.
 */

const mockBatchOps: Array<{ op: string; path: string; data?: any; opts?: any }> = [];
const mockDocs: Record<string, any> = {};
const mockCaller: { current: any } = { current: null };
const mockTx = jest.fn();

function makeDocRef(path: string, id: string): any {
  return {
    id,
    path,
    get: async () => {
      const data = mockDocs[path];
      return { exists: data !== undefined, data: () => data };
    },
    collection: (sub: string) => ({
      doc: (subId?: string) => makeDocRef(`${path}/${sub}/${subId ?? 'generated-sub'}`, subId ?? 'generated-sub'),
    }),
    set: async () => undefined,
    update: async () => undefined,
  };
}

const mockDb = {
  collection: (name: string) => ({
    doc: (id?: string) => makeDocRef(`${name}/${id ?? 'generated-id'}`, id ?? 'generated-id'),
    where: () => ({ get: async () => ({ docs: [] }) }),
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
        Timestamp: { now: () => ({ __ts: 'now' }) },
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
    verifyIdTokenString: async () => mockCaller.current,
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
  executeGamificationTransaction: (...args: any[]) => mockTx(...args),
}));

jest.mock('@/lib/server/hierarchy-utils', () => ({
  isManagerAbove: jest.fn().mockResolvedValue(false),
  getDirectSubordinates: jest.fn().mockResolvedValue([]),
}));

jest.mock('@/lib/server/hierarchy', () => {
  const { resolveTaskReviewerUids } = jest.requireActual('@/lib/server/task-reviewer');
  return {
    canValidateTask: jest.fn(async (uid: string, _role: string, task: any) => {
      if (!uid) return { allowed: false, reason: 'missing caller identity' };
      const submittedBy =
        typeof task?.submittedBy === 'string' && task.submittedBy ? task.submittedBy : undefined;
      if (submittedBy && uid === submittedBy) {
        return { allowed: false, reason: 'cannot validate own submission' };
      }
      if (resolveTaskReviewerUids(task || {}).includes(uid)) {
        return {
          allowed: true,
          reason: 'caller is the named reviewer for this task',
          via: 'reviewer',
          depth: null,
        };
      }
      if (task?.assignerId && uid === String(task.assignerId)) {
        return { allowed: true, reason: 'caller is the assigner', via: 'assigner', depth: null };
      }
      return {
        allowed: false,
        reason: 'caller is not above the submitter, the assigner, a named reviewer, or a task manager',
      };
    }),
    getValidatorChainUids: jest.fn().mockResolvedValue([]),
    resolveDisplayName: jest.fn().mockResolvedValue('Test User'),
  };
});

jest.mock('@/lib/server/validation-notifications', () => ({
  notifyValidatorsOnSubmission: jest.fn(),
  notifyOnDecision: jest.fn(),
  notifyAcceptanceRequest: jest.fn(),
  notifyChainOnDecline: jest.fn(),
  resolveValidatorSubmissionAlerts: jest.fn(),
}));

jest.mock('@/lib/server/validation-audit', () => ({
  logValidationDecision: jest.fn(),
  logDeniedValidationAttempt: jest.fn(),
}));

jest.mock('@/lib/server/discipline/suspension', () => ({
  suspensionBlock: jest.fn().mockResolvedValue(null),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(false),
  hasServerPermissionForUser: jest.fn().mockResolvedValue(false),
  resolveUserRole: jest.fn().mockResolvedValue('member_basic'),
  assertChapterAccess: jest.fn().mockResolvedValue({ allowed: true }),
}));

import { PATCH } from '../route';

const FOUNDER = 'founder-uid';
const DOER = 'doer-uid';
const REVIEWER = 'reviewer-uid';
const STRANGER = 'stranger-uid';

function makeRequest(body: any): any {
  const req: any = { json: async () => body };
  req.clone = () => req;
  return req;
}

function asBasicMember(uid: string) {
  mockCaller.current = { uid };
}

function masterWrite(taskId: string) {
  const writes = mockBatchOps.filter(
    (o) => (o.op === 'update' || o.op === 'set') && o.path === `tasks/${taskId}`,
  );
  expect(writes.length).toBeGreaterThan(0);
  return writes[writes.length - 1].data;
}

function seedSubmittedTask(taskId: string, extra: Record<string, any> = {}) {
  mockDocs[`tasks/${taskId}`] = {
    title: 'Fixture submission',
    status: 'submitted-for-review',
    assigneeId: DOER,
    assigneeIds: [DOER],
    assignerId: FOUNDER,
    submittedBy: DOER,
    submittedAt: '2026-10-29T10:00:00.000Z',
    report: 'Both graphics are completed and ready for review',
    points: 10,
    reviewerId: REVIEWER,
    reviewerIds: [REVIEWER],
    deadline: '2026-11-05T00:00:00.000Z',
    ...extra,
  };
}

describe('PATCH /api/tasks named-reviewer decision pass-through', () => {
  beforeEach(() => {
    mockBatchOps.length = 0;
    mockTx.mockReset();
    mockTx.mockResolvedValue({ pointsAwardedTotal: 10 });
    for (const k of Object.keys(mockDocs)) delete mockDocs[k];
    for (const uid of [FOUNDER, DOER, REVIEWER, STRANGER]) {
      mockDocs[`roles/${uid}`] = { role: 'member_basic' };
    }
    seedSubmittedTask('task-1');
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('(a) basic-member named reviewer CAN approve via the dialog body', async () => {
    asBasicMember(REVIEWER);
    const res: any = await PATCH(
      makeRequest({ taskId: 'task-1', updates: { status: 'completed' } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transitionedToCompleted).toBe(true);
    // The gamification transaction owns the completion write; it must
    // have been handed the decision payload with the reviewer stamps.
    expect(mockTx).toHaveBeenCalledTimes(1);
    const [, updatesToApply] = mockTx.mock.calls[0];
    expect(updatesToApply.status).toBe('completed');
    expect(updatesToApply.approvedBy).toBe(REVIEWER);
    expect(updatesToApply.validatedVia).toBe('reviewer');
  });

  test('(b) basic-member named reviewer CAN reject with a new deadline (plain task)', async () => {
    asBasicMember(REVIEWER);
    const newDeadline = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    const res: any = await PATCH(
      makeRequest({
        taskId: 'task-1',
        updates: {
          status: 'changes-requested',
          feedback_text: 'Fixture rejection feedback.',
          reviewDeadline: newDeadline,
        },
      }),
    );
    expect(res.status).toBe(200);
    const data = masterWrite('task-1');
    expect(data.status).toBe('changes-requested');
    expect(data.rejectedBy).toBe(REVIEWER);
    expect(data.validatedVia).toBe('reviewer');
    // Plain task: the new deadline lands on the deadline field.
    expect(data.deadline).toBeInstanceOf(Date);
    expect((data.deadline as Date).toISOString()).toBe(newDeadline);
    // Feedback was consumed into the history arrayUnion, flat field gone.
    expect(data.feedback_text).toBeUndefined();
    expect(data.feedback_history?.__fv).toBe('arrayUnion');
    expect(data.feedback_history.vals[0].text).toBe('Fixture rejection feedback.');
    expect(data.feedback_history.vals[0].new_deadline).toBe(newDeadline);
  });

  test('(b2) rejection on a workflow step writes individualDeadline, not deadline', async () => {
    seedSubmittedTask('task-2', {
      workflowId: 'wf-1',
      individualDeadline: '2026-10-30T00:00:00.000Z',
    });
    asBasicMember(REVIEWER);
    const newDeadline = new Date(Date.now() + 4 * 24 * 3600 * 1000).toISOString();
    const res: any = await PATCH(
      makeRequest({
        taskId: 'task-2',
        updates: {
          status: 'changes-requested',
          feedback_text: 'Step needs another pass.',
          reviewDeadline: newDeadline,
        },
      }),
    );
    expect(res.status).toBe(200);
    const data = masterWrite('task-2');
    expect(data.status).toBe('changes-requested');
    expect(data.individualDeadline).toBeInstanceOf(Date);
    expect((data.individualDeadline as Date).toISOString()).toBe(newDeadline);
    expect(data.deadline).toBeUndefined();
  });

  test('(c) the same reviewer CANNOT edit other fields (title change 403s)', async () => {
    asBasicMember(REVIEWER);
    const res: any = await PATCH(
      makeRequest({ taskId: 'task-1', updates: { title: 'Hijacked title' } }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden: you are not assigned to this task');
    expect(mockBatchOps.filter((o) => o.path === 'tasks/task-1')).toHaveLength(0);
    expect(mockTx).not.toHaveBeenCalled();
  });

  test('(c2) a decision carrying a smuggled field (points) 403s at the field gate', async () => {
    asBasicMember(REVIEWER);
    const res: any = await PATCH(
      makeRequest({ taskId: 'task-1', updates: { status: 'completed', points: 9999 } }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden: you are not assigned to this task');
    expect(mockTx).not.toHaveBeenCalled();
  });

  test('(d) a basic member who is NOT a reviewer of record gets 403 on a decision', async () => {
    asBasicMember(STRANGER);
    const res: any = await PATCH(
      makeRequest({ taskId: 'task-1', updates: { status: 'completed' } }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe(
      'Forbidden: only someone above the submitter, the assigner, or a task manager can validate',
    );
    expect(mockTx).not.toHaveBeenCalled();
  });

  test('(e1) the assigner still approves exactly as before', async () => {
    asBasicMember(FOUNDER);
    const res: any = await PATCH(
      makeRequest({ taskId: 'task-1', updates: { status: 'completed' } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transitionedToCompleted).toBe(true);
    const [, updatesToApply] = mockTx.mock.calls[0];
    expect(updatesToApply.approvedBy).toBe(FOUNDER);
    expect(updatesToApply.validatedVia).toBe('assigner');
  });

  test('(e2) the assignee still edits work-product fields', async () => {
    asBasicMember(DOER);
    const res: any = await PATCH(
      makeRequest({ taskId: 'task-1', updates: { hoursWorked: 2.5, report: 'Updated report' } }),
    );
    expect(res.status).toBe(200);
    const data = masterWrite('task-1');
    expect(data.hoursWorked).toBe(2.5);
    expect(data.report).toBe('Updated report');
  });

  test('(e3) the assignee is still blocked from manager fields', async () => {
    asBasicMember(DOER);
    const res: any = await PATCH(
      makeRequest({ taskId: 'task-1', updates: { title: 'Assignee rename attempt' } }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden: only task managers may edit these fields');
    expect(body.fields).toEqual(['title']);
  });

  test('(e4) a task manager still edits any field', async () => {
    mockCaller.current = { uid: 'admin-uid', role: 'admin', permissions: { manageTasks: true } };
    mockDocs['roles/admin-uid'] = { role: 'admin' };
    const res: any = await PATCH(
      makeRequest({ taskId: 'task-1', updates: { title: 'Manager retitle', points: 25 } }),
    );
    expect(res.status).toBe(200);
    const data = masterWrite('task-1');
    expect(data.title).toBe('Manager retitle');
    expect(data.points).toBe(25);
  });
});
