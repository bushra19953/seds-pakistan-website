/**
 * @jest-environment node
 *
 * GAP-N1 closure — POST /api/tasks/delegate batch notification writes.
 *
 * The delegate route queued users/{uid}/notifications writes in its
 * batch with no mirror. They are now mirrored after batch.commit()
 * succeeds, via the notifications seam (flag-gated, non-throwing).
 *
 * Reachability note: in production this fan-out sits behind the FD-01
 * 403 (the route reads auth.user.uid, which the real AuthContext does
 * not carry — pinned in route.test.ts). These tests supply a uid-bearing
 * auth context to exercise the fan-out itself and prove the mirror
 * wiring that takes effect when FD-01 is fixed by its owning program.
 */

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(),
}));

jest.mock('@/lib/mailer', () => ({
  sendEmailNotification: jest.fn().mockResolvedValue(undefined),
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  admin: {
    firestore: {
      FieldPath: { documentId: () => '__documentId__' },
      FieldValue: {
        serverTimestamp: () => 'SERVER_TS',
        increment: (n: number) => `INC(${n})`,
      },
    },
  },
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
}));

jest.mock('@/lib/supa/seam-tasks-delegate', () => ({
  getTaskDocViaSeam: jest.fn(),
  getUserDocViaSeam: jest.fn(),
  listUsersByIdsViaSeam: jest.fn(),
  updateTaskDocViaSeam: jest.fn().mockResolvedValue(false),
}));

jest.mock('@/lib/server/discipline/suspension', () => ({
  suspensionBlock: jest.fn(async () => null),
  findBannedDelegateTarget: jest.fn(async () => null),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/tasks/delegate/route';
import { verifyAuthentication } from '@/lib/auth-middleware';
import {
  getTaskDocViaSeam,
  getUserDocViaSeam,
  listUsersByIdsViaSeam,
} from '@/lib/supa/seam-tasks-delegate';
import {
  setNotificationsSupaAdapterForTests,
  type NotificationsSupaAdapter,
} from '@/lib/server/notifications-supa-seam';

const mockAuth = verifyAuthentication as jest.Mock;
const CALLER = 'caller-1';
const OTHER = 'other-uid';

const batchSets: Array<{ ref: any; data: any; opts?: any }> = [];
let batchCommits = 0;
let genCounter = 0;

function makeDb() {
  return {
    collection: (name: string) => {
      if (name === 'tasks') {
        return {
          doc: (id?: string) => ({
            id: id ?? `task-gen-${++genCounter}`,
            get: async () => ({ exists: false, data: () => undefined }),
            collection: () => ({ doc: () => ({ id: 'activity-1' }) }),
          }),
        };
      }
      if (name === 'users') {
        return {
          doc: (uid: string) => ({
            id: uid,
            get: async () => ({ exists: true, data: () => ({ displayName: 'Caller One' }) }),
            collection: () => ({
              doc: () => ({ id: `notif-for-${uid}` }),
            }),
          }),
          where: jest.fn(),
        };
      }
      if (name === 'workflow_members') {
        return { doc: (mid: string) => ({ id: mid }) };
      }
      throw new Error(`unexpected collection ${name}`);
    },
    batch: () => ({
      set: (ref: any, data: any, opts?: any) => { batchSets.push({ ref, data, opts }); },
      update: (ref: any, data: any) => { batchSets.push({ ref, data }); },
      commit: async () => { batchCommits++; },
    }),
  };
}

function makeAdapter(fail = false) {
  const calls = { setDoc: [] as any[], updateDoc: [] as any[], deleteDoc: [] as any[] };
  const adapter: NotificationsSupaAdapter = {
    setDoc: async (...args: any[]) => {
      calls.setDoc.push(args);
      if (fail) throw new Error('supa down');
    },
    updateDoc: async (...args: any[]) => { calls.updateDoc.push(args); },
    deleteDoc: async (...args: any[]) => { calls.deleteDoc.push(args); },
    listDocs: async () => [],
  };
  return { adapter, calls };
}

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/tasks/delegate', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const BODY = {
  taskId: 'task-1',
  pointsKept: 40,
  workflowSteps: [{ title: 'Step 1', description: 'Do it', points: 60, assigneeId: OTHER }],
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  batchSets.length = 0;
  batchCommits = 0;
  genCounter = 0;
  mockDbHolder.db = makeDb();
  mockAuth.mockResolvedValue({
    authenticated: true,
    user: { uid: CALLER, userId: CALLER, email: 'caller@example.com', displayName: 'Caller One' },
  });
  (getTaskDocViaSeam as jest.Mock).mockResolvedValue({
    exists: true,
    id: 'task-1',
    data: () => ({
      title: 'Parent mission',
      assigneeId: CALLER,
      assigneeIds: [CALLER],
      points: 100,
      status: 'pending',
      deadline: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    }),
  });
  (getUserDocViaSeam as jest.Mock).mockResolvedValue({
    data: () => ({ displayName: 'Caller One', email: 'caller@example.com' }),
  });
  (listUsersByIdsViaSeam as jest.Mock).mockResolvedValue([
    { id: OTHER, data: { displayName: 'Other User', email: 'other@example.com' } },
  ]);
  delete process.env.SUPA_SURFACES;
  setNotificationsSupaAdapterForTests(null);
});

afterEach(() => {
  delete process.env.SUPA_SURFACES;
  setNotificationsSupaAdapterForTests(null);
  jest.restoreAllMocks();
});

describe('GAP-N1: POST /api/tasks/delegate notification mirror', () => {
  it('flag ON: committed batch notification is mirrored with the user path', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    process.env.SUPA_SURFACES = 'notifications';
    const res = await POST(postRequest(BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });
    expect(batchCommits).toBe(1);
    expect(calls.setDoc).toHaveLength(1);
    expect(calls.setDoc[0][0]).toBe(`users/${OTHER}/notifications`);
    expect(calls.setDoc[0][1]).toBe(`notif-for-${OTHER}`);
    expect(calls.setDoc[0][2]).toMatchObject({ type: 'task_delegation', title: 'New Mission Assignment' });
  });

  it('flag OFF: batch commits, zero mirror calls', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    const res = await POST(postRequest(BODY));
    expect(res.status).toBe(200);
    expect(batchCommits).toBe(1);
    expect(calls.setDoc).toHaveLength(0);
  });

  it('mirror failure: response unchanged', async () => {
    const { adapter } = makeAdapter(true);
    setNotificationsSupaAdapterForTests(adapter);
    process.env.SUPA_SURFACES = 'notifications';
    const res = await POST(postRequest(BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });
  });
});
