/**
 * @jest-environment node
 *
 * POST /api/workflows named reviewer: the workflow-level reviewerId is
 * stamped onto every step doc (per-step override wins), together with
 * its array form reviewerIds ([reviewerId], or [] when unnamed), and
 * the reviewer receives exactly ONE task_reviewer_assigned
 * designation email per creation, naming the workflow and the mission
 * link. A reviewer with no email on file is skipped silently;
 * creations without a reviewer stamp null / [] and send nothing extra.
 */
const CREATOR = 'creator-1';
const REVIEWER = 'reviewer-1';
const STEP_REVIEWER = 'reviewer-2';

const mockSendEmail = jest.fn().mockResolvedValue({ success: true });

const USERS: Record<string, any> = {
  'creator-1': { displayName: 'The Creator', email: 'creator@example.com' },
  'user-a': { displayName: 'Alice A', email: 'alice@example.com' },
  'reviewer-1': { displayName: 'Rita Reviewer', email: 'rita@example.com' },
  'reviewer-2': { displayName: 'No Mail Ned' }, // reviewer without an email on file
};

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
      doc: () => ({ set: async () => {} }),
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

import { POST } from '../route';

function makeRequest(body?: any): any {
  return {
    json: async () => body ?? {},
    url: 'http://localhost/api/workflows',
    headers: { get: () => 'Bearer <redacted>' },
    cookies: { get: () => undefined },
  };
}

const BASE_BODY = {
  workflowId: 'wf-reviewer-1',
  workflowTitle: 'Review Me Workflow',
  finalDeadline: '2027-06-01T00:00:00.000Z',
  steps: [
    { title: 'Step One', description: 'first', assigneeId: 'user-a' },
    { title: 'Step Two', description: 'second', assigneeId: 'user-a' },
  ],
};

function reviewerEmails() {
  return mockSendEmail.mock.calls.filter((c: any[]) => c[1] === 'task_reviewer_assigned');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTaskDocs.length = 0;
  taskSeq = 0;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('POST /api/workflows named reviewer', () => {
  it('stamps the workflow reviewer on every step and emails them exactly once', async () => {
    const res: any = await POST(makeRequest({ ...BASE_BODY, reviewerId: REVIEWER }));
    expect(res.status).toBe(200);
    // Fan-out now runs in the background after persistence (2026-10-28 truncation fix); let it settle before asserting its effects.
    await new Promise((r) => setImmediate(r));
    expect(mockTaskDocs).toHaveLength(2);
    for (const doc of mockTaskDocs) {
      expect(doc.data.reviewerId).toBe(REVIEWER);
      expect(doc.data.reviewerIds).toEqual([REVIEWER]);
    }
    const emails = reviewerEmails();
    expect(emails).toHaveLength(1);
    expect(emails[0][0]).toBe('rita@example.com');
    expect(emails[0][2]).toMatchObject({
      recipientName: 'Rita Reviewer',
      taskTitle: 'Review Me Workflow',
      taskLink: '/missions/wf-reviewer-1',
      actorName: 'The Creator',
    });
  });

  it('per-step reviewer override wins on that step only; the single email still goes to the workflow reviewer', async () => {
    const body = {
      ...BASE_BODY,
      reviewerId: REVIEWER,
      steps: [
        { title: 'Step One', description: 'first', assigneeId: 'user-a', reviewerId: STEP_REVIEWER },
        { title: 'Step Two', description: 'second', assigneeId: 'user-a' },
      ],
    };
    const res: any = await POST(makeRequest(body));
    expect(res.status).toBe(200);
    // Fan-out now runs in the background after persistence (2026-10-28 truncation fix); let it settle before asserting its effects.
    await new Promise((r) => setImmediate(r));
    expect(mockTaskDocs[0].data.reviewerId).toBe(STEP_REVIEWER);
    expect(mockTaskDocs[0].data.reviewerIds).toEqual([STEP_REVIEWER]);
    expect(mockTaskDocs[1].data.reviewerId).toBe(REVIEWER);
    expect(mockTaskDocs[1].data.reviewerIds).toEqual([REVIEWER]);
    expect(reviewerEmails()).toHaveLength(1);
    expect(reviewerEmails()[0][0]).toBe('rita@example.com');
  });

  it('no reviewer named: steps stamp null and no designation email is sent', async () => {
    const res: any = await POST(makeRequest(BASE_BODY));
    expect(res.status).toBe(200);
    // Fan-out now runs in the background after persistence (2026-10-28 truncation fix); let it settle before asserting its effects.
    await new Promise((r) => setImmediate(r));

    for (const doc of mockTaskDocs) {
      expect(doc.data.reviewerId).toBeNull();
      expect(doc.data.reviewerIds).toEqual([]);
    }
    expect(reviewerEmails()).toHaveLength(0);
  });

  it('reviewer with a blank profile email: creation succeeds, no email attempted', async () => {
    const res: any = await POST(makeRequest({ ...BASE_BODY, reviewerId: STEP_REVIEWER }));
    expect(res.status).toBe(200);
    // Fan-out now runs in the background after persistence (2026-10-28 truncation fix); let it settle before asserting its effects.
    await new Promise((r) => setImmediate(r));
    expect(mockTaskDocs).toHaveLength(2);
    for (const doc of mockTaskDocs) {
      expect(doc.data.reviewerIds).toEqual([STEP_REVIEWER]);
    }
    expect(reviewerEmails()).toHaveLength(0);
  });
});
