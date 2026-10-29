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
const mockUserGets: Record<string, number> = {};
let taskSeq = 0;

function userDocRef(uid: string): any {
  return {
    get: async () => {
      mockUserGets[uid] = (mockUserGets[uid] ?? 0) + 1;
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
    auth: () => ({ verifyIdToken: async () => ({ uid: CREATOR, email: 'creator@example.com', name: 'The Creator' }) }),
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

// Contact doorway (contact-gating fix): assignee addresses resolve from
// the gated contact record; the mock serves the fixtures' on-file emails.
jest.mock('@/lib/server/user-contact', () => {
  const actual = jest.requireActual('@/lib/user-contact-shared');
  return {
    ...actual,
    resolveUserEmail: jest.fn(async (_db: any, uid: string) => USERS[uid]?.email ?? null),
    resolveUserEmails: jest.fn(async (_db: any, uids: string[]) => {
      const m = new Map<string, string>();
      for (const uid of uids) if (USERS[uid]?.email) m.set(uid, USERS[uid].email);
      return m;
    }),
    getUserContact: jest.fn(async (_db: any, uid: string) => {
      const c = actual.pickContactFields(USERS[uid] || {});
      return Object.keys(c).length ? c : null;
    }),
    getUserContacts: jest.fn(async (_db: any, uids: string[]) => {
      const m = new Map<string, any>();
      for (const uid of uids) {
        const c = actual.pickContactFields(USERS[uid] || {});
        if (Object.keys(c).length) m.set(uid, c);
      }
      return m;
    }),
    setUserContact: jest.fn(async () => undefined),
    clearUserContact: jest.fn(async () => undefined),
  };
});

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
  for (const k of Object.keys(mockUserGets)) delete mockUserGets[k];
  taskSeq = 0;
});

describe('POST /api/workflows assignment fan-out', () => {
  it('emails each step assignee who has an email on file, with the task_assigned template', async () => {
    const res: any = await POST(makeRequest(WORKFLOW_BODY));
    expect(res.status).toBe(200);
    // Fan-out now runs in the background after persistence (2026-10-28 truncation fix); let it settle before asserting its effects.
    await new Promise((r) => setImmediate(r));
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
    // Fan-out now runs in the background after persistence (2026-10-28 truncation fix); let it settle before asserting its effects.
    await new Promise((r) => setImmediate(r));
    const uids = mockNotifications.map((n) => n.uid).sort();
    expect(uids).toEqual(['user-a', 'user-b']);
    for (const n of mockNotifications) {
      expect(n.data.type).toBe('task_assigned');
      expect(n.data.title).toBe('New Task Assigned');
      expect(n.data.taskId).toBe(mockTaskDocs[0].id);
      expect(n.data.isRead).toBe(false);
    }
  });

  it('never reads the creator users doc for the notification name (read budget: name comes from the token claim)', async () => {
    const res: any = await POST(makeRequest(WORKFLOW_BODY));
    expect(res.status).toBe(200);
    // Fan-out now runs in the background after persistence (2026-10-28 truncation fix); let it settle before asserting its effects.
    await new Promise((r) => setImmediate(r));
    // The fan-out still reads each assignee doc for email/displayName...
    expect(mockUserGets['user-a']).toBeGreaterThan(0);
    expect(mockUserGets['user-b']).toBeGreaterThan(0);
    // ...but the creator's doc is never fetched: this route's caller
    // identity budget is the pinned 2 reads spent by auth+permission
    // (T-A1), so the actor name must come from the verified token.
    expect(mockUserGets[CREATOR] ?? 0).toBe(0);
    expect(mockSendEmail).toHaveBeenCalledWith(
      'alice@example.com',
      'task_assigned',
      expect.objectContaining({ actorName: 'The Creator' })
    );
  });

  it('still creates the workflow when the mailer rejects (notification is non-blocking)', async () => {
    mockSendEmail.mockRejectedValueOnce(new Error('Brevo unreachable'));
    const res: any = await POST(makeRequest(WORKFLOW_BODY));
    expect(res.status).toBe(200);
    // Fan-out now runs in the background after persistence (2026-10-28 truncation fix); let it settle before asserting its effects.
    await new Promise((r) => setImmediate(r));
    expect(mockTaskDocs).toHaveLength(2);
    expect(mockNotifications.map((n) => n.uid).sort()).toEqual(['user-a', 'user-b']);
    // Let the fire-and-forget rejection settle through the route's .catch.
    await new Promise((r) => setImmediate(r));
  });
});
