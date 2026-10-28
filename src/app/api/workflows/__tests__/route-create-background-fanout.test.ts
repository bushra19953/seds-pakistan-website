/**
 * @jest-environment node
 *
 * POST /api/workflows background fan-out (2026-10-28 truncation fix):
 * step persistence and the member batch must complete BEFORE any
 * assignment fan-out starts, and the fan-out runs in the background
 * (fire-and-forget with a catch), so a slow or failing notification /
 * email layer can never again truncate a workflow mid-loop the way it
 * truncated wf_1793206249841_2uw71r at step 4 of 15 behind Cloudflare's
 * request lifetime. The response reports the server-side counts
 * (createdCount / stepsRequested) so the client can verify them.
 */
const CREATOR = 'creator-1';

const mockSendEmail = jest.fn().mockResolvedValue({ success: true });

const USERS: Record<string, any> = {
  'creator-1': { displayName: 'The Creator', email: 'creator@example.com' },
  'user-a': { displayName: 'Alice A', email: 'alice@example.com' },
  'user-b': { displayName: 'Bob B', email: 'bob@example.com' },
};

const mockNotifications: Array<{ uid: string; data: any }> = [];
const mockTaskDocs: Array<{ id: string; data: any }> = [];
let taskSeq = 0;
let mockNotifSeq = 0;

// Gate / failure controls for the fan-out layer, set per test. The
// deferred is created by a test and released only when that test says
// so; afterEach always resolves and clears it so no pending promise
// leaks across tests in this file.
interface MockDeferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e?: any) => void;
}
function createMockDeferred(): MockDeferred {
  let resolve!: () => void;
  let reject!: (e?: any) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
let mockGate: MockDeferred | null = null;
let mockResolveEmailShouldReject = false;
let mockNotifyFailForUid: string | null = null;

function userDocRef(uid: string): any {
  return {
    get: async () => {
      const data = USERS[uid];
      return { exists: !!data, data: () => data };
    },
    set: async () => {},
    collection: (_sub: string) => ({
      doc: () => {
        const id = `notif-${uid}-${++mockNotifSeq}`;
        return {
          id,
          set: async (data: any) => {
            if (mockGate) await mockGate.promise;
            if (mockNotifyFailForUid === uid) throw new Error(`notification set failed for ${uid}`);
            mockNotifications.push({ uid, data });
          },
        };
      },
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
    resolveUserEmail: jest.fn(async (_db: any, uid: string) => {
      if (mockGate) await mockGate.promise;
      if (mockResolveEmailShouldReject) throw new Error('resolveUserEmail failed');
      return USERS[uid]?.email ?? null;
    }),
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

function makeSteps(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    title: `Step ${i + 1}`,
    description: `step ${i + 1}`,
    assigneeId: i % 2 === 0 ? 'user-a' : 'user-b',
  }));
}

function makeBody(count: number, workflowId: string) {
  return {
    workflowId,
    workflowTitle: 'Background Fan-Out Workflow',
    finalDeadline: '2027-06-01T00:00:00.000Z',
    steps: makeSteps(count),
  };
}

async function flushBackground(times = 10) {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSendEmail.mockResolvedValue({ success: true });
  mockNotifications.length = 0;
  mockTaskDocs.length = 0;
  taskSeq = 0;
  mockNotifSeq = 0;
  mockGate = null;
  mockResolveEmailShouldReject = false;
  mockNotifyFailForUid = null;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  // Clean up deferreds so no pending promise leaks across tests:
  // release any gate a test left closed, clear the failure controls,
  // and let any released background fan-out settle before the next test.
  if (mockGate) mockGate.resolve();
  mockGate = null;
  mockResolveEmailShouldReject = false;
  mockNotifyFailForUid = null;
  await flushBackground(3);
});

describe('POST /api/workflows background fan-out (truncation fix)', () => {
  it('Test A: a slow notification/email layer cannot truncate creation (15 steps)', async () => {
    // On the pre-fix code this test hangs (fan-out awaited inside the loop) and fails by timeout:
    // the first step's fan-out awaits the unreleased gate, so POST never returns and steps 2-15
    // are never persisted.
    mockGate = createMockDeferred();

    const res: any = await POST(makeRequest(makeBody(15, 'wf-bg-15')));
    expect(res.status).toBe(200);
    expect(mockTaskDocs).toHaveLength(15);
    const payload = await res.json();
    expect(payload.createdCount).toBe(15);
    expect(payload.stepsRequested).toBe(15);
    // The fan-out is still gated in the background: nothing written yet.
    expect(mockNotifications).toHaveLength(0);
    expect(mockSendEmail).not.toHaveBeenCalled();

    mockGate.resolve();
    await flushBackground();

    expect(mockNotifications).toHaveLength(15);
    expect(mockNotifications.filter((n) => n.uid === 'user-a')).toHaveLength(8);
    expect(mockNotifications.filter((n) => n.uid === 'user-b')).toHaveLength(7);
    // One email per (step, assignee-with-email) job: 15 jobs, both assignees have emails.
    expect(mockSendEmail).toHaveBeenCalledTimes(15);
    for (const call of mockSendEmail.mock.calls) {
      expect(call[1]).toBe('task_assigned');
    }
  });

  it('Test B: a failing notification/email layer cannot truncate creation (23 steps)', async () => {
    mockSendEmail.mockRejectedValue(new Error('Brevo unreachable'));
    mockResolveEmailShouldReject = true;
    mockNotifyFailForUid = 'user-b';

    const res: any = await POST(makeRequest(makeBody(23, 'wf-bg-23')));
    expect(res.status).toBe(200);
    expect(mockTaskDocs).toHaveLength(23);
    const payload = await res.json();
    expect(payload.createdCount).toBe(23);
    expect(payload.stepsRequested).toBe(23);

    // Let the background chain settle: per-job failures are caught per
    // assignee, so this flush completes without an unhandled rejection.
    await flushBackground();

    // Jobs for user-a pass the notification write (12 steps), then hit
    // the rejecting email resolution; jobs for user-b fail at the
    // notification write itself (11 steps). Neither failure stops the
    // other jobs or the already-returned creation.
    expect(mockNotifications).toHaveLength(12);
    expect(mockNotifications.every((n) => n.uid === 'user-a')).toBe(true);
  });

  it('Test C: response counts match the persisted steps (3 steps)', async () => {
    const res: any = await POST(makeRequest(makeBody(3, 'wf-bg-3')));
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.createdCount).toBe(3);
    expect(payload.created).toHaveLength(3);
    expect(payload.created.length).toBe(3);
    expect(mockTaskDocs).toHaveLength(3);
  });
});
