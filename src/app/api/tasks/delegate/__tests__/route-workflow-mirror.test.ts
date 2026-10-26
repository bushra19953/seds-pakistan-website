/**
 * @jest-environment node
 *
 * F2 (2026-10-26 workflow-invisibility fix): POST /api/tasks/delegate
 * is a second workflow CREATE path. Its step tasks + workflow_members
 * docs must land in the Supabase mirror under the 'workflows' gate,
 * exactly as POST /api/workflows mirrors its own creates — otherwise
 * the day delegation is repaired (FD-01), delegated missions would
 * be invisible on the detail/public/PDF surfaces the same way.
 *
 * The auth mock returns a context WITH a top-level uid — the shape
 * the route reads — i.e. this suite simulates the post-FD-01-fix
 * world on purpose. The mirror module is REAL; a fake adapter is
 * injected through its loader hook under the LIVE flag set
 * (workflows ON, tasks OFF). Firestore is an in-memory fake whose
 * batch commit applies writes to the store.
 */

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => ({
    authenticated: true,
    user: { uid: 'caller-1', email: 'caller@example.com', displayName: 'Caller One' },
  })),
}));

jest.mock('@/lib/mailer', () => ({
  sendEmailNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/workflow-utils', () => ({
  calculateWorkflowDeadlines: (_final: Date, steps: any[]) =>
    steps.map(() => new Date(Date.now() + 24 * 60 * 60 * 1000)),
}));

jest.mock('@/lib/server/discipline/suspension', () => ({
  suspensionBlock: jest.fn(async () => null),
  findBannedDelegateTarget: jest.fn(async () => null),
}));

jest.mock('@/lib/supa/seam-tasks-delegate', () => ({
  getTaskDocViaSeam: jest.fn().mockResolvedValue(null),
  getUserDocViaSeam: jest.fn().mockResolvedValue(null),
  listUsersByIdsViaSeam: jest.fn().mockResolvedValue(null),
  updateTaskDocViaSeam: jest.fn().mockResolvedValue(false),
}));

jest.mock('@/lib/server/notifications-supa-seam', () => ({
  mirrorNotificationCreate: jest.fn().mockResolvedValue(undefined),
  userNotificationsPath: (uid: string) => `users/${uid}/notifications`,
}));

// ---------- in-memory Firestore fake ----------
type DocData = Record<string, any>;

const fsStore = new Map<string, DocData>(); // key: "collection/id"
let genCounter = 0;

function refFor(path: string) {
  const [collection, id] = path.split('/');
  return { _path: path, _col: collection, _id: id, id, path };
}

function docRef(collection: string, id?: string) {
  const docId = id ?? `gen-${++genCounter}`;
  const ref: any = refFor(`${collection}/${docId}`);
  ref.get = async () => {
    const data = fsStore.get(`${collection}/${docId}`);
    return { id: docId, ref, exists: data !== undefined, data: () => data };
  };
  ref.collection = (sub: string) => ({
    doc: (subId?: string) => docRef(`${collection}/${docId}/${sub}`, subId),
  });
  return ref;
}

const fakeDb: any = {
  collection: (name: string) => ({
    doc: (id?: string) => docRef(name, id),
    where: () => ({
      get: async () => ({ docs: [], size: 0, empty: true }),
    }),
  }),
  batch: () => {
    const writes: Array<{ path: string; data: DocData }> = [];
    return {
      set: (ref: any, data: DocData) => {
        writes.push({ path: ref._path, data });
      },
      update: (ref: any, data: DocData) => {
        writes.push({ path: ref._path, data });
      },
      commit: async () => {
        for (const w of writes) {
          const existing = fsStore.get(w.path) ?? {};
          fsStore.set(w.path, { ...existing, ...w.data });
        }
      },
    };
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  admin: {
    firestore: {
      FieldPath: { documentId: () => '__documentId__' },
      FieldValue: {
        serverTimestamp: () => 'SERVER_TS',
        increment: (n: number) => ({ __increment: n }),
      },
    },
  },
  getDb: () => fakeDb,
  ensureAdminInitialized: () => true,
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/tasks/delegate/route';
import {
  __setWorkflowWriteMirrorLoaderForTests,
} from '@/lib/server/workflow-write-mirror';

// ---------- fake Supabase adapter (mirror target) ----------
const mirrorStore = new Map<string, Map<string, DocData>>();

function mirrorCol(name: string): Map<string, DocData> {
  if (!mirrorStore.has(name)) mirrorStore.set(name, new Map());
  return mirrorStore.get(name)!;
}

function injectFakeSupa() {
  __setWorkflowWriteMirrorLoaderForTests(async () => ({
    useSupa: (surface: string) => ['announcements', 'workflows'].includes(surface), // LIVE: workflows ON, tasks OFF
    getSupaClient: () => ({ fake: true }),
    getSupaAdapter: () => ({
      getDoc: async (collection: string, id: string) => {
        const doc = mirrorCol(collection).get(id);
        return doc ? { id, ...doc } : null;
      },
      listDocs: async () => [],
      countDocs: async () => 0,
      setDoc: async (collection: string, id: string, data: DocData) => {
        mirrorCol(collection).set(id, { ...data });
        return { id, ...data };
      },
      updateDoc: async () => ({ id: '' }),
      deleteDoc: async (collection: string, id: string) => {
        mirrorCol(collection).delete(id);
      },
    }),
  }));
}

beforeEach(() => {
  fsStore.clear();
  mirrorStore.clear();
  genCounter = 0;
  injectFakeSupa();
  fsStore.set('tasks/parent-1', {
    title: 'Parent Mission',
    assigneeId: 'caller-1',
    assigneeIds: ['caller-1'],
    points: 30,
    deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
  fsStore.set('users/caller-1', { displayName: 'Caller One', email: 'caller@example.com' });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  __setWorkflowWriteMirrorLoaderForTests(null);
  jest.restoreAllMocks();
});

describe('delegate create path mirrors steps + members (workflows gate)', () => {
  it('a delegated workflow lands in the mirror under the LIVE flag set', async () => {
    const req = new NextRequest('http://localhost/api/tasks/delegate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId: 'parent-1',
        pointsKept: 10,
        workflowSteps: [
          { title: 'Step One', description: 'first', points: 20, assigneeIds: ['sub-1'] },
        ],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    const wfId = body.workflowId as string;
    expect(wfId).toMatch(/^orch_/);

    // Step task landed, carrying the linkage the readers query by.
    const mirroredTasks = Array.from(mirrorCol('tasks').values());
    expect(mirroredTasks).toHaveLength(1);
    expect(mirroredTasks[0].workflowId).toBe(wfId);
    expect(mirroredTasks[0].title).toBe('Step One');
    expect(mirroredTasks[0].assigneeId).toBe('sub-1');

    // Members landed under the composite ids: owner + participant.
    expect(mirrorCol('workflow_members').get(`${wfId}_caller-1`)?.role).toBe('owner');
    expect(mirrorCol('workflow_members').get(`${wfId}_sub-1`)?.role).toBe('member');
  });
});
