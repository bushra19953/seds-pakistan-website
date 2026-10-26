/**
 * @jest-environment node
 *
 * Cutover primacy pins (feat/supa-cut-tasks), mocked stores only:
 *
 * - DELETE /api/tasks/batch primacy: with SUPA_PRIMARY=tasks, the
 *   adapter deletes commit BEFORE the Firestore batch; an adapter
 *   failure returns 500 and the Firestore batch never commits. With
 *   SUPA_PRIMARY unset, the pre-cutover order holds (Firestore batch
 *   commit first, mirror after — also pinned in
 *   supa-admin-tasks-endpoints.test.ts).
 * - GET /api/tasks/team terminal exclusion on the primary path: with
 *   the surface flipped AND primary (the flip configuration), tasks
 *   served from the adapter still exclude BOTH terminal spellings —
 *   canonical 'completed' (step-17 writers stamp it) and legacy
 *   'approved' (step-17 readers honor it).
 */

import {
  makeStore,
  makeFirestoreDb,
  makeFakeAdapter,
  fakeSupaModule,
  put,
  supaTs,
  type Store,
} from './supa-group2-fakes';

let mockDb: any;
let batchOrder: string[] = [];
let batchSnapshots: any[] = [];

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

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDb,
  admin: {
    firestore: {
      FieldPath: { documentId: () => '__name__' },
      FieldValue: {
        serverTimestamp: () => 'SERVER_TS',
        increment: (n: number) => ({ __increment: n }),
      },
    },
  },
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({
    authenticated: true,
    user: {
      userId: 'u1',
      uid: 'u1',
      user: { uid: 'admin-1', permissions: { manageTasks: true } },
    },
  }),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: async () => true,
  hasServerPermission: async () => true,
}));

jest.mock('@/lib/server/hierarchy', () => ({
  canValidateTask: async () => ({ allowed: true, via: 'assigner', depth: null }),
}));

import { DELETE as batchDELETE } from '@/app/api/tasks/batch/route';
import { GET as teamGET } from '@/app/api/tasks/team/route';
import {
  __setAdminTasksSupaAdapterForTests,
  __resetAdminTasksSupaAdapterForTests,
  type AdminTasksSupaAdapter,
} from '@/lib/supa/seam-admin-tasks';
import { __setSupaLoaderForTests } from '@/lib/supa/seam-tasks-lists';

function makeBatchDb(): any {
  return {
    collection: (name: string) => ({
      doc: (id: string) => ({ id, path: `${name}/${id}` }),
    }),
    getAll: async (...refs: any[]) => batchSnapshots,
    batch: () => ({
      delete: () => undefined,
      set: () => undefined,
      commit: async () => {
        batchOrder.push('firestore-commit');
      },
    }),
  };
}

function makeAdminAdapter(overrides: Partial<AdminTasksSupaAdapter> = {}): AdminTasksSupaAdapter {
  return {
    getDoc: jest.fn(async () => null),
    listDocs: jest.fn(async () => []),
    countDocs: jest.fn(async () => 0),
    setDoc: jest.fn(async () => ({})),
    updateDoc: jest.fn(async () => ({})),
    deleteDoc: jest.fn(async () => {
      batchOrder.push('supa-delete');
    }),
    ...overrides,
  } as AdminTasksSupaAdapter;
}

function batchReq(): any {
  return {
    url: 'http://x/api/tasks/batch',
    json: async () => ({ taskIds: ['t1', 't2'] }),
    headers: new Headers(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  batchOrder = [];
  batchSnapshots = [
    { exists: true, id: 't1', ref: { id: 't1' }, data: () => ({ assigneeId: 'u1', status: 'completed' }) },
    { exists: true, id: 't2', ref: { id: 't2' }, data: () => ({ assigneeId: 'u1', status: 'pending' }) },
  ];
  delete process.env.SUPA_SURFACES;
  delete process.env.SUPA_PRIMARY;
});

afterEach(() => {
  __resetAdminTasksSupaAdapterForTests();
  __setSupaLoaderForTests(null);
  delete process.env.SUPA_SURFACES;
  delete process.env.SUPA_PRIMARY;
  jest.restoreAllMocks();
});

describe('DELETE /api/tasks/batch write primacy', () => {
  it('primary: adapter deletes commit BEFORE the Firestore batch', async () => {
    process.env.SUPA_SURFACES = 'tasks';
    process.env.SUPA_PRIMARY = 'tasks';
    mockDb = makeBatchDb();
    const adapter = makeAdminAdapter();
    __setAdminTasksSupaAdapterForTests(adapter);

    const res = await batchDELETE(batchReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, deletedCount: 2 });
    expect(adapter.deleteDoc).toHaveBeenCalledTimes(2);
    expect(batchOrder).toEqual(['supa-delete', 'supa-delete', 'firestore-commit']);
  });

  it('primary: an adapter delete failure -> 500 and the Firestore batch never commits', async () => {
    process.env.SUPA_SURFACES = 'tasks';
    process.env.SUPA_PRIMARY = 'tasks';
    mockDb = makeBatchDb();
    const adapter = makeAdminAdapter({
      deleteDoc: jest.fn(async () => {
        throw new Error('supa down');
      }),
    });
    __setAdminTasksSupaAdapterForTests(adapter);

    const res = await batchDELETE(batchReq());
    expect(res.status).toBe(500);
    expect(batchOrder).toEqual([]);
  });

  it('dual-write (SUPA_PRIMARY unset): Firestore batch commits first, mirror after', async () => {
    process.env.SUPA_SURFACES = 'tasks';
    mockDb = makeBatchDb();
    const adapter = makeAdminAdapter();
    __setAdminTasksSupaAdapterForTests(adapter);

    const res = await batchDELETE(batchReq());
    expect(res.status).toBe(200);
    expect(batchOrder).toEqual(['firestore-commit', 'supa-delete', 'supa-delete']);
  });
});

describe('GET /api/tasks/team terminal exclusion on the primary path', () => {
  it('flipped + primary: adapter-served tasks exclude completed AND legacy approved', async () => {
    process.env.SUPA_SURFACES = 'tasks';
    process.env.SUPA_PRIMARY = 'tasks';
    const RECENT = '2026-10-20T00:00:00.000Z';
    const store: Store = makeStore();
    put(store, 'users', 'u1', { displayName: 'Boss', role: 'member', chapterId: 'ch-1' });
    put(store, 'users', 'sub-1', { displayName: 'Sub One', role: 'member', chapterId: 'ch-1' });
    put(store, 'reporting_relationships', 'rel-1', { managerId: 'u1', subordinateId: 'sub-1' });
    put(store, 'tasks', 't-done', {
      title: 'Done', status: 'completed', assigneeId: 'sub-1', assignerId: 'u1',
      chapterId: 'ch-1', deadline: supaTs(RECENT), points: 5,
    });
    put(store, 'tasks', 't-legacy', {
      title: 'Legacy approved', status: 'approved', assigneeId: 'sub-1', assignerId: 'u1',
      chapterId: 'ch-1', deadline: supaTs(RECENT), points: 5,
    });
    put(store, 'tasks', 't-open', {
      title: 'Open', status: 'pending', assigneeId: 'u1', chapterId: 'ch-1', deadline: supaTs(RECENT),
    });
    mockDb = makeFirestoreDb(makeStore()); // Firestore empty: any Firestore use shows
    __setSupaLoaderForTests(async () => fakeSupaModule(makeFakeAdapter(store), true));

    const res: any = await teamGET({} as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tasks.map((t: any) => t.id)).toEqual(['t-open']);
  });
});
