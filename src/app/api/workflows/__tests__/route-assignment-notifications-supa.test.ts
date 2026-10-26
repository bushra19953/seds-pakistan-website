/**
 * @jest-environment node
 *
 * POST /api/workflows — notifications residual #2 conversion
 * (DEPLOY_READY_REPORT §Notifications): the assignment fan-out's
 * in-app notification was the one notification writer still inline in
 * this route (L290, `.doc().set(...)` with a discarded auto-id). It now
 * goes through the notifications seam, owning surface 'notifications':
 *
 * - OFF (default): byte-identical — Firestore set only, adapter never
 *   consulted, same payload, email still follows the write.
 * - Dual-write (SUPA_SURFACES=notifications, no SUPA_PRIMARY):
 *   Firestore set FIRST, seam mirror second, same doc id; a mirror
 *   failure is swallowed (email still sent, creation still succeeds).
 * - Primacy (SUPA_PRIMARY also names notifications): adapter FIRST,
 *   Firestore set as the post-commit mirror; an adapter failure lands
 *   in the fan-out catch exactly as a Firestore set failure does today
 *   (no Firestore notification, no email, creation still succeeds).
 *
 * Mock adapter + mock Firestore — no live reads or writes.
 */
const CREATOR = 'creator-1';

const mockSendEmail = jest.fn().mockResolvedValue({ success: true });

const USERS: Record<string, any> = {
  'creator-1': { displayName: 'The Creator', email: 'creator@example.com' },
  'user-a': { displayName: 'Alice A', email: 'alice@example.com' },
  'user-b': { displayName: 'Bob B' }, // no email on file
};

// The route's serverTimestamp() value: a non-plain class instance, so
// the seam serializer resolves it to an ISO string exactly as it does
// for the real FieldValue sentinel.
class FakeFieldValue {
  readonly _methodName = 'serverTimestamp';
}
const fakeSentinel = new FakeFieldValue();

const order: string[] = [];
const mockNotifications: Array<{ uid: string; id: string; data: any }> = [];
const supaCalls: Array<{ path: string; id: string; data: any }> = [];
let supaShouldThrow = false;
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
        id: `notif-${uid}`,
        set: async (data: any) => {
          order.push(`firestore:${uid}`);
          mockNotifications.push({ uid, id: `notif-${uid}`, data });
        },
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
        return { id, set: async () => {} };
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
    firestore: { FieldValue: { serverTimestamp: () => fakeSentinel, increment: (n: number) => ({ __inc: n }) } },
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
import { setNotificationsSupaAdapterForTests } from '@/lib/server/notifications-supa-seam';

const fakeAdapter: any = {
  setDoc: async (path: string, id: string, data: any) => {
    if (supaShouldThrow) throw new Error('supa down');
    order.push(`supa:${path.split('/')[1]}`);
    supaCalls.push({ path, id, data });
  },
  updateDoc: async () => undefined,
  deleteDoc: async () => undefined,
  listDocs: async () => [],
};

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
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  order.length = 0;
  mockNotifications.length = 0;
  supaCalls.length = 0;
  supaShouldThrow = false;
  taskSeq = 0;
  delete process.env.SUPA_SURFACES;
  delete process.env.SUPA_PRIMARY;
  setNotificationsSupaAdapterForTests(fakeAdapter);
});

afterEach(() => {
  delete process.env.SUPA_SURFACES;
  delete process.env.SUPA_PRIMARY;
  setNotificationsSupaAdapterForTests(null);
  (console.log as jest.Mock).mockRestore?.();
  (console.warn as jest.Mock).mockRestore?.();
});

describe('POST /api/workflows assignment notification — seam conversion', () => {
  it('OFF: Firestore only, adapter never called, payload and email unchanged', async () => {
    const res: any = await POST(makeRequest(WORKFLOW_BODY));
    expect(res.status).toBe(200);
    expect(supaCalls).toHaveLength(0);
    expect(mockNotifications.map((n) => n.uid).sort()).toEqual(['user-a', 'user-b']);
    for (const n of mockNotifications) {
      expect(n.data.type).toBe('task_assigned');
      expect(n.data.title).toBe('New Task Assigned');
      expect(n.data.isRead).toBe(false);
      expect(n.data.timestamp).toBe(fakeSentinel); // Firestore payload keeps the sentinel
    }
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('dual-write: Firestore set first, mirror second, same id and serialized payload', async () => {
    process.env.SUPA_SURFACES = 'notifications';
    const res: any = await POST(makeRequest(WORKFLOW_BODY));
    expect(res.status).toBe(200);
    expect(order).toEqual([
      'firestore:user-a', 'supa:user-a',
      'firestore:user-b', 'supa:user-b',
    ]);
    expect(supaCalls.map((c) => [c.path, c.id])).toEqual([
      ['users/user-a/notifications', 'notif-user-a'],
      ['users/user-b/notifications', 'notif-user-b'],
    ]);
    const first = supaCalls[0].data;
    expect(first).toMatchObject({
      type: 'task_assigned',
      title: 'New Task Assigned',
      body: 'You have been assigned: "Step One"',
      taskId: 'task-1',
      isRead: false,
    });
    expect(first.link).toBe('/profile/unified?uid=user-a&task=task-1');
    expect(typeof first.timestamp).toBe('string'); // sentinel serialized for jsonb
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('dual-write: a throwing mirror never fails creation and the email still goes out', async () => {
    process.env.SUPA_SURFACES = 'notifications';
    supaShouldThrow = true;
    const res: any = await POST(makeRequest(WORKFLOW_BODY));
    expect(res.status).toBe(200);
    expect(mockNotifications.map((n) => n.uid).sort()).toEqual(['user-a', 'user-b']);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('primacy: adapter first, Firestore set as the post-commit mirror, same id', async () => {
    process.env.SUPA_SURFACES = 'notifications';
    process.env.SUPA_PRIMARY = 'notifications';
    const res: any = await POST(makeRequest(WORKFLOW_BODY));
    expect(res.status).toBe(200);
    expect(order).toEqual([
      'supa:user-a', 'firestore:user-a',
      'supa:user-b', 'firestore:user-b',
    ]);
    expect(supaCalls.map((c) => c.id)).toEqual(['notif-user-a', 'notif-user-b']);
    expect(mockNotifications.map((n) => n.id)).toEqual(['notif-user-a', 'notif-user-b']);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('primacy: an adapter failure behaves like a Firestore write failure today — no notification, no email, creation still succeeds', async () => {
    process.env.SUPA_SURFACES = 'notifications';
    process.env.SUPA_PRIMARY = 'notifications';
    supaShouldThrow = true;
    const res: any = await POST(makeRequest(WORKFLOW_BODY));
    expect(res.status).toBe(200);
    expect(mockNotifications).toHaveLength(0);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});
