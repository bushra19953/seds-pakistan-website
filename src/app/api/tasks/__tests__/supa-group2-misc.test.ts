/**
 * @jest-environment node
 *
 * Tasks group-2 Supa seam tests: approval-rate, [id]/validation and
 * [id]/activity routes. Flag OFF parity (Firestore fake) and flag ON
 * reads / write mirrors (mocked adapter) must match in shape.
 */
import {
  makeStore,
  makeFirestoreDb,
  makeFakeAdapter,
  fakeSupaModule,
  put,
  fsTs,
  supaTs,
  type Store,
  type FakeAdapter,
} from './supa-group2-fakes';

let mockDb: any;
let mockAuthUser: any = { userId: 'boss-1', uid: 'boss-1', role: 'member' };
let mockCanValidate: any = { allowed: true, via: 'chain', depth: 2 };

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
      FieldPath: { documentId: () => '__id__' },
      FieldValue: { serverTimestamp: () => 'SERVER_TS' },
    },
  },
}));

jest.mock('firebase-admin', () => ({
  firestore: { FieldValue: { serverTimestamp: () => 'SERVER_TS' } },
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({ authenticated: true, user: mockAuthUser }),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: async () => true,
  hasServerPermission: async () => true,
}));

jest.mock('@/lib/server/hierarchy', () => ({
  canValidateTask: async () => mockCanValidate,
}));

import { GET as approvalGET } from '../approval-rate/route';
import { GET as validationGET } from '../[id]/validation/route';
import { GET as activityGET, POST as activityPOST } from '../[id]/activity/route';
import { __setSupaLoaderForTests } from '@/lib/supa/seam-tasks-lists';

const RECENT = '2026-10-20T00:00:00.000Z';
const params = (id: string) => ({ params: Promise.resolve({ id }) });

afterEach(() => {
  __setSupaLoaderForTests(null);
  delete process.env.SUPA_SURFACES;
});

/* ------------------------------------------------------------ approval-rate */

function seedApprovalStore(): Store {
  const store = makeStore();
  put(store, 'tasks', 'a1', {
    status: 'completed', submittedBy: 'perf-1', assigneeId: 'perf-1',
    approvedAt: fsTs(RECENT), createdAt: fsTs(RECENT),
  });
  put(store, 'tasks', 'a2', {
    status: 'rejected', submittedBy: 'perf-1', assigneeId: 'perf-1',
    rejectedAt: fsTs(RECENT), createdAt: fsTs(RECENT),
  });
  put(store, 'tasks', 'a3', {
    status: 'pending', submittedBy: 'perf-1', assigneeId: 'perf-1',
  });
  return store;
}

describe('approval-rate route', () => {
  const req = () => ({ url: 'http://localhost/api/tasks/approval-rate?uid=perf-1' }) as any;

  it('flag OFF: Firestore parity (1 of 2 decided approved)', async () => {
    mockDb = makeFirestoreDb(seedApprovalStore());
    __setSupaLoaderForTests(async () => null);
    const res: any = await approvalGET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true, uid: 'perf-1', approved: 1, decided: 2, rate: 0.5, hasHistory: true,
    });
  });

  it('flag ON: mocked adapter computes the identical rate', async () => {
    const store = seedApprovalStore();
    // Supa store carries ISO strings, not Timestamp-likes.
    for (const [, docs] of store) {
      for (const [, d] of docs) {
        for (const k of Object.keys(d)) {
          if (d[k] && typeof d[k]?.toDate === 'function') d[k] = d[k].toDate().toISOString();
        }
      }
    }
    mockDb = makeFirestoreDb(makeStore());
    __setSupaLoaderForTests(async () => fakeSupaModule(makeFakeAdapter(store), true));
    const res: any = await approvalGET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true, uid: 'perf-1', approved: 1, decided: 2, rate: 0.5, hasHistory: true,
    });
  });
});

/* --------------------------------------------------------------- validation */

describe('validation route', () => {
  it('flag OFF: Firestore parity', async () => {
    const store = makeStore();
    put(store, 'tasks', 't1', { title: 'X', submittedBy: 'sub-1', status: 'submitted-for-review' });
    mockDb = makeFirestoreDb(store);
    __setSupaLoaderForTests(async () => null);
    const res: any = await validationGET({} as any, params('t1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      canValidate: true, via: 'chain', depth: 2, isSubmitter: false,
    });
  });

  it('flag ON: mocked adapter read, identical body', async () => {
    const store = makeStore();
    put(store, 'tasks', 't1', { title: 'X', submittedBy: 'sub-1', status: 'submitted-for-review' });
    mockDb = makeFirestoreDb(makeStore());
    __setSupaLoaderForTests(async () => fakeSupaModule(makeFakeAdapter(store), true));
    const res: any = await validationGET({} as any, params('t1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      canValidate: true, via: 'chain', depth: 2, isSubmitter: false,
    });
  });

  it('flag ON: missing task is a 404 from the adapter, not a fallback', async () => {
    mockDb = makeFirestoreDb(makeStore());
    __setSupaLoaderForTests(async () => fakeSupaModule(makeFakeAdapter(makeStore()), true));
    const res: any = await validationGET({} as any, params('nope'));
    expect(res.status).toBe(404);
  });
});

/* ----------------------------------------------------------------- activity */

function seedActivityStore(ts: (iso: string) => any): Store {
  const store = makeStore();
  put(store, 'tasks', 't1', {
    title: 'Task One', status: 'in-progress', assigneeId: 'sub-1', createdAt: ts(RECENT),
  });
  put(store, 'users', 'sub-1', { displayName: 'Sub One' });
  put(store, 'tasks/t1/activity', 'act-1', {
    type: 'comment', userId: 'sub-1', data: { text: 'hi' }, createdAt: ts(RECENT),
  });
  return store;
}

describe('activity route GET', () => {
  it('flag OFF: Firestore parity', async () => {
    mockDb = makeFirestoreDb(seedActivityStore(fsTs));
    __setSupaLoaderForTests(async () => null);
    const res: any = await activityGET({} as any, params('t1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.activities[0]).toMatchObject({
      id: 'act-1', type: 'comment', userName: 'Sub One', createdAt: RECENT,
    });
    expect(body.assigneeSilence[0]).toMatchObject({ userId: 'sub-1', userName: 'Sub One' });
  });

  it('flag ON: mocked adapter read, identical shape', async () => {
    const store = seedActivityStore(supaTs);
    mockDb = makeFirestoreDb(makeStore());
    __setSupaLoaderForTests(async () => fakeSupaModule(makeFakeAdapter(store), true));
    const res: any = await activityGET({} as any, params('t1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.activities[0]).toMatchObject({
      id: 'act-1', type: 'comment', userName: 'Sub One', createdAt: RECENT,
    });
    expect(body.assigneeSilence[0]).toMatchObject({ userId: 'sub-1', userName: 'Sub One' });
  });
});

describe('activity route POST mirror', () => {
  it('flag ON: Firestore write happens and the seam mirrors it with the same id', async () => {
    const fsStore = seedActivityStore(fsTs);
    mockDb = makeFirestoreDb(fsStore);
    // Task must be visible to the seam read in POST: seed the adapter too.
    const supaStore = seedActivityStore(supaTs);
    const adapter2 = makeFakeAdapter(supaStore);
    __setSupaLoaderForTests(async () => fakeSupaModule(adapter2, true));

    const req: any = {
      json: async () => ({ type: 'comment', data: { text: 'hello' } }),
    };
    const res: any = await activityPOST(req, params('t1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.activityId).toBe('string');

    // Firestore write landed in the activity subcollection.
    const fsActs = Array.from((fsStore.get('tasks/t1/activity') ?? new Map()).values());
    expect(fsActs.some((a: any) => a.type === 'comment' && a.data?.text === 'hello')).toBe(true);

    // Mirror carried the same id and an ISO createdAt (no sentinel).
    const mirror = adapter2.setDocCalls.find((c) => c.path === 'tasks/t1/activity');
    expect(mirror).toBeDefined();
    expect(mirror!.id).toBe(body.activityId);
    expect(mirror!.data.type).toBe('comment');
    expect(typeof mirror!.data.createdAt).toBe('string');
  });

  it('flag OFF: Firestore write happens, no mirror attempted', async () => {
    const fsStore = seedActivityStore(fsTs);
    mockDb = makeFirestoreDb(fsStore);
    __setSupaLoaderForTests(async () => null);
    const req: any = { json: async () => ({ type: 'feedback', data: { text: 'ok' } }) };
    const res: any = await activityPOST(req, params('t1'));
    expect(res.status).toBe(200);
    const fsActs = Array.from((fsStore.get('tasks/t1/activity') ?? new Map()).values());
    expect(fsActs.some((a: any) => a.type === 'feedback')).toBe(true);
  });
});
