/**
 * @jest-environment node
 *
 * POST /api/workflows assignment fan-out (fix/mailer-activation):
 * creating a workflow must notify every step assignee, mirroring
 * POST /api/tasks and /api/tasks/delegate: an in-app notification for
 * each assignee and a task_assigned email for each assignee with an
 * email on file. Regression coverage for the gap where workflow
 * creation wrote task docs and counters only, so no assignment email
 * was ever attempted on the standard workflow-plan delegation path.
 */
const CREATOR = 'creator-1';

const mockSendEmail = jest.fn().mockResolvedValue({ success: true });

const USERS: Record<string, any> = {
  'creator-1': { displayName: 'The Creator', email: 'creator@example.com' },
  'user-a': { displayName: 'Alice A', email: 'alice@example.com' },
  'user-b': { displayName: 'Bob B' }, // no email on file
};

const mockNotifications: Array<{ uid: string; data: any }> = [];
const mockTaskDocs: Array<{ id: string; data: any }> = [];
let taskSeq = 0;

function userDocRef(uid: string): any {
  return {
    get: async () => {
      const data = USERS[uid];
      return { exists: !!data, data: () => data };
    },
    set: async () => {},
    collection: (_sub: string) => ({
      doc: () => ({
        set: async (data: any) => { mockNotifications.push({ uid, data }); },
      }),
    }),
  };
}

const mockDb: any = {
  collection: (name: string) => {
    if (name === 'users') return { doc: (uid: string) => userDocRef(uid) };
    if (name === 'tasks') return {
      doc: () => {
        const id = `task-${++taskSeq}`;
        return { id, set: async (data: any) => { mockTaskDocs.push({ id, data }); } };
      },
    };
    if (name === 'workflow_members') return { doc: (id: string) => ({ id }) };
    throw new Error(`unexpected collection ${name}`);
  },
  batch: () => ({ set: () => {}, commit: async () => {} }),
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
  getDb: () => mockDb,
  ensureAdminInitialized: () => true,
  admin: {
    auth: () => ({ verifyIdToken: async () => ({ uid: CREATOR, email: 'creator@example.com' }) }),
    firestore: { FieldValue: { serverTimestamp: () => ({ __fv: 'ts' }), increment: (n: number) => ({ __inc: n }) } },
  },
}));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn().mockResolvedValue(true),
}));
jest.mock('@/lib/workflow-utils', () => ({
  calculateWorkflowDeadlines: (_final: any, steps: any[]) => steps.map(() => new Date('2027-01-15T12:00:00.000Z')),
}));
jest.mock('@/lib/workflow-progress', () => ({ isStepWorkDone: () => false, computeWorkflowProgress: jest.fn() }));
jest.mock('@/lib/server/user-status', () => ({ validateUserStatus: jest.fn().mockResolvedValue({ isValid: true }) }));
jest.mock('@/lib/mailer', () => ({
  sendEmailNotification: (...args: any[]) => mockSendEmail(...args),
}));

import { POST } from '../route';

function makeRequest(body?: any): any {
  return {
    json: async () => body ?? {},
    url: 'http://localhost/api/workflows',
    headers: { get: () => 'Bearer test-token' },
    cookies: { get: () => undefined },
  };
}

const WORKFLOW_BODY = {
  workflowId: 'wf-test-1',
  workflowTitle: 'Test Workflow',
  finalDeadline: '2027-06-01T00:00:00.000Z',
  steps: [
    { title: 'Step One', description: 'first', assigneeId: 'user-a', assigneeIds: ['user-a', 'user-b'] },
    { title: 'Step Two', description: 'second', assigneeId: CREATOR },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockNotifications.length = 0;
  mockTaskDocs.length = 0;
  taskSeq = 0;
});

describe('POST /api/workflows assignment fan-out', () => {
  it('emails each step assignee who has an email on file, with the task_assigned template', async () => {
    const res: any = await POST(makeRequest(WORKFLOW_BODY));
    expect(res.status).toBe(200);
    // user-a has an email; user-b does not; the creator-assigned step is skipped.
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith(
      'alice@example.com',
      'task_assigned',
      expect.objectContaining({
        recipientName: 'Alice A',
        taskTitle: 'Step One',
        actorName: 'The Creator',
        dueDate: 'Jan 15, 2027',
        taskLink: expect.stringContaining('/profile/unified?uid=user-a&task=task-'),
      })
    );
  });

  it('writes an in-app notification for every non-creator assignee and none for the creator', async () => {
    const res: any = await POST(makeRequest(WORKFLOW_BODY));
    expect(res.status).toBe(200);
    const uids = mockNotifications.map((n) => n.uid).sort();
    expect(uids).toEqual(['user-a', 'user-b']);
    for (const n of mockNotifications) {
      expect(n.data.type).toBe('task_assigned');
      expect(n.data.title).toBe('New Task Assigned');
      expect(n.data.taskId).toBe(mockTaskDocs[0].id);
      expect(n.data.isRead).toBe(false);
    }
  });

  it('still creates the workflow when the mailer rejects (notification is non-blocking)', async () => {
    mockSendEmail.mockRejectedValueOnce(new Error('Brevo unreachable'));
    const res: any = await POST(makeRequest(WORKFLOW_BODY));
    expect(res.status).toBe(200);
    expect(mockTaskDocs).toHaveLength(2);
    expect(mockNotifications.map((n) => n.uid).sort()).toEqual(['user-a', 'user-b']);
    // Let the fire-and-forget rejection settle through the route's .catch.
    await new Promise((r) => setImmediate(r));
  });
});
