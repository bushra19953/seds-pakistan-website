/**
 * @jest-environment node
 *
 * Tasks group-2 Supa seam tests: team + review-queue routes.
 * Flag OFF parity (Firestore fake) and flag ON reads (mocked adapter)
 * must produce identical response shapes. The same store contents are
 * rendered per backend: Firestore timestamps as Timestamp-likes, Supa
 * (jsonb) timestamps as ISO strings.
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
} from './supa-group2-fakes';

let mockDb: any;
let mockAuthUser: any = { userId: 'u1', uid: 'u1', role: 'member' };

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

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({ authenticated: true, user: mockAuthUser }),
}));

jest.mock('@/lib/server/hierarchy', () => ({
  canValidateTask: async () => ({ allowed: true, via: 'assigner', depth: null }),
}));

import { GET as teamGET } from '../team/route';
import { GET as reviewGET } from '../review-queue/route';
import { __setSupaLoaderForTests } from '@/lib/supa/seam-tasks-lists';

const PAST = '2020-01-01T00:00:00.000Z';
const RECENT = '2026-10-20T00:00:00.000Z';

function seedTeamStore(ts: (iso: string) => any): Store {
  const store = makeStore();
  put(store, 'users', 'u1', { displayName: 'Boss', role: 'member', chapterId: 'ch-1' });
  put(store, 'users', 'sub-1', { displayName: 'Sub One', role: 'member', chapterId: 'ch-1' });
  put(store, 'reporting_relationships', 'rel-1', { managerId: 'u1', subordinateId: 'sub-1' });
  put(store, 'tasks', 't1', {
    title: 'Done task', status: 'completed', assigneeId: 'sub-1', assignerId: 'u1',
    chapterId: 'ch-1', deadline: ts(PAST), points: 5,
  });
  put(store, 'tasks', 't2', {
    title: 'Open task', status: 'pending', assigneeId: 'u1', chapterId: 'ch-1',
    deadline: ts(RECENT),
  });
  return store;
}

afterEach(() => {
  __setSupaLoaderForTests(null);
  delete process.env.SUPA_SURFACES;
});

describe('team route', () => {
  it('flag OFF: Firestore parity, terminal statuses excluded (post-1a semantics)', async () => {
    mockDb = makeFirestoreDb(seedTeamStore(fsTs));
    __setSupaLoaderForTests(async () => null); // adapter module absent
    const res: any = await teamGET({} as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.teamSize).toBe(2);
    const byId = Object.fromEntries(body.tasks.map((t: any) => [t.id, t]));
    // UPDATED AT STEP 17: fix/tasks-status-semantics landed; the route
    // excludes terminal statuses in-code on BOTH flag paths (t1 is
    // 'completed' and no longer returns).
    expect(Object.keys(byId).sort()).toEqual(['t2']);
    expect(byId.t2.deadline).toBe(RECENT);
  });

  it('flag ON: mocked adapter produces the identical shape', async () => {
    const store = seedTeamStore(supaTs);
    mockDb = makeFirestoreDb(makeStore()); // Firestore empty: any use shows
    __setSupaLoaderForTests(async () => fakeSupaModule(makeFakeAdapter(store), true));
    const res: any = await teamGET({} as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.teamSize).toBe(2);
    const byId = Object.fromEntries(body.tasks.map((t: any) => [t.id, t]));
    expect(Object.keys(byId).sort()).toEqual(['t2']);
    expect(byId.t2.deadline).toBe(RECENT); // ISO string in jsonb, ISO string out
  });

  it('flag ON but loader module has flag off: Firestore serves', async () => {
    const store = seedTeamStore(fsTs);
    mockDb = makeFirestoreDb(store);
    __setSupaLoaderForTests(async () => fakeSupaModule(makeFakeAdapter(makeStore()), false));
    const res: any = await teamGET({} as any);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.tasks).toHaveLength(1);
  });
});

function seedReviewStore(ts: (iso: string) => any): Store {
  const store = makeStore();
  put(store, 'users', 'sub-1', { displayName: 'Sub One', role: 'member' });
  put(store, 'tasks', 't9', {
    title: 'Review me', status: 'submitted-for-review', submittedBy: 'sub-1',
    assigneeId: 'sub-1', submittedAt: ts(RECENT), points: 3,
  });
  put(store, 'tasks', 't10', {
    title: 'Not in queue', status: 'pending', submittedBy: 'sub-1', assigneeId: 'sub-1',
  });
  return store;
}

describe('review-queue route', () => {
  it('flag OFF: Firestore parity', async () => {
    mockDb = makeFirestoreDb(seedReviewStore(fsTs));
    __setSupaLoaderForTests(async () => null);
    const res: any = await reviewGET({} as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]).toMatchObject({
      id: 't9', title: 'Review me', submitterUid: 'sub-1',
      submitterName: 'Sub One', submittedAt: RECENT, via: 'assigner',
    });
  });

  it('flag ON: mocked adapter produces the identical shape', async () => {
    const store = seedReviewStore(supaTs);
    mockDb = makeFirestoreDb(makeStore());
    __setSupaLoaderForTests(async () => fakeSupaModule(makeFakeAdapter(store), true));
    const res: any = await reviewGET({} as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]).toMatchObject({
      id: 't9', title: 'Review me', submitterUid: 'sub-1',
      submitterName: 'Sub One', submittedAt: RECENT, via: 'assigner',
    });
  });
});
