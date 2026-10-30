/**
 * @jest-environment node
 *
 * Pins for GET /api/public/mission-board (read-bleed fix train 2,
 * rbt2-projects). Injected fake seam adapter + mocked auth — zero
 * live reads.
 *
 * Contract (route header):
 *  - tasks surface OFF / adapter absent -> 404 (the client keeps its
 *    exact Firestore listener/query; flag OFF is byte-identical).
 *  - Board mode (no params, public per firestore.rules): one seam
 *    list leg where workflowId != null with the stated 5000 limit,
 *    projected to the board's field whitelist, sorted into the
 *    Firestore '!=' result order (workflowId asc, then id asc).
 *  - Project mode (?projectId=): 401 unauthenticated, 403 without
 *    canManageTasks (the only viewers who can run the equivalent
 *    Firestore list query), else one bounded leg where
 *    projectId == id, projected to { id, status }.
 *  - Seam read failure -> 500 (client falls back; never an empty
 *    board served as if complete).
 */

const mockVerifyAuthentication = jest.fn();
const mockHasPermission = jest.fn(async (..._args: any[]) => false);

// The seam's static adapter import chain reaches @supabase/supabase-js,
// which this tree's tests never install; the injected fake adapter
// bypasses it, so the module only needs to resolve (the same stub the
// other seam suites use).
jest.mock('@/lib/supa/adapter', () => ({
  getSupaAdapter: () => null,
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => ({}),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: (...args: any[]) => mockVerifyAuthentication(...args),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: (...args: any[]) => mockHasPermission(...args),
}));

import { GET } from '@/app/api/public/mission-board/route';
import {
  __setTasksSupaAdapterForTests,
  __resetTasksSupaAdapterForTests,
} from '@/lib/supa/seam-tasks-route';

function req(url: string): any {
  return { url, headers: new Headers() };
}

function makeAdapter(rows: any[], overrides: Record<string, any> = {}): any {
  return {
    getDoc: jest.fn(async () => null),
    listDocs: jest.fn(async () => rows),
    countDocs: jest.fn(async () => rows.length),
    setDoc: jest.fn(async () => ({})),
    updateDoc: jest.fn(async () => undefined),
    deleteDoc: jest.fn(async () => undefined),
    ...overrides,
  };
}

const savedSurfaces = process.env.SUPA_SURFACES;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  process.env.SUPA_SURFACES = 'tasks';
  mockHasPermission.mockResolvedValue(false);
  mockVerifyAuthentication.mockResolvedValue({ authenticated: false, error: 'Unauthorized' });
});

afterAll(() => {
  __resetTasksSupaAdapterForTests();
  if (savedSurfaces === undefined) delete process.env.SUPA_SURFACES;
  else process.env.SUPA_SURFACES = savedSurfaces;
});

describe('gating', () => {
  it('404s when the tasks surface flag is OFF, even with an adapter injected', async () => {
    delete process.env.SUPA_SURFACES;
    __setTasksSupaAdapterForTests(makeAdapter([]));
    const res = await GET(req('http://localhost/api/public/mission-board'));
    expect(res.status).toBe(404);
  });

  it('404s when the adapter is absent', async () => {
    __setTasksSupaAdapterForTests(null);
    const res = await GET(req('http://localhost/api/public/mission-board'));
    expect(res.status).toBe(404);
  });
});

describe('board mode', () => {
  it('serves projected workflow tasks in Firestore != order from one bounded leg', async () => {
    const adapter = makeAdapter([
      { id: 't2', workflowId: 'wf-b', workflowTitle: 'Beta', chapterName: 'IST', chapterId: 'ist', status: 'pending', assigneeId: 'u2', assigneeName: 'Bilal', assigneePhoto: null, title: 'B1', updatedAt: '2023-11-14T22:13:20.000Z', internalNote: 'never leaves the server', assigneeEmail: 'x@example.com' },
      { id: 't1', workflowId: 'wf-a', workflowTitle: 'Alpha', chapterName: 'IST', chapterId: 'ist', status: 'completed', assigneeId: 'u1', assigneeName: 'Amina', assigneePhoto: 'a.png', title: 'A1', updatedAt: '2023-11-14T22:13:20.000Z' },
      { id: 't3', workflowId: 'wf-a', workflowTitle: 'Alpha', chapterName: 'IST', chapterId: 'ist', status: 'in-progress', assigneeId: 'u1', assigneeName: 'Amina', assigneePhoto: 'a.png', title: 'A2', updatedAt: '2023-11-14T22:13:20.000Z' },
    ]);
    __setTasksSupaAdapterForTests(adapter);

    const res = await GET(req('http://localhost/api/public/mission-board'));
    expect(res.status).toBe(200);
    const body = await res.json();

    // One leg, the exact predicate and the stated bound.
    expect(adapter.listDocs).toHaveBeenCalledTimes(1);
    const [collection, options] = adapter.listDocs.mock.calls[0];
    expect(collection).toBe('tasks');
    expect(options.where).toEqual([['workflowId', '!=', null]]);
    expect(options.limit).toBe(5000);
    expect(body.limit).toBe(5000);

    // Firestore '!=' order: workflowId asc, then id asc.
    expect(body.tasks.map((t: any) => t.id)).toEqual(['t1', 't3', 't2']);

    // Whitelist projection: internal fields are gone.
    const first = body.tasks[0];
    expect(first.workflowTitle).toBe('Alpha');
    expect(first).not.toHaveProperty('internalNote');
    const beta = body.tasks.find((t: any) => t.id === 't2');
    expect(beta).not.toHaveProperty('assigneeEmail');

    // updatedAt crosses the wire as the seam timestamp shape the
    // client revives ({ seconds, nanoseconds }).
    expect(first.updatedAt.seconds).toBe(1700000000);
  });

  it('500s on seam failure so the client falls back instead of rendering empty', async () => {
    __setTasksSupaAdapterForTests(
      makeAdapter([], { listDocs: jest.fn(async () => { throw new Error('supa down'); }) }),
    );
    const res = await GET(req('http://localhost/api/public/mission-board'));
    expect(res.status).toBe(500);
  });
});

describe('project mode', () => {
  const url = 'http://localhost/api/public/mission-board?projectId=p1';

  it('401s when unauthenticated and never reads', async () => {
    const adapter = makeAdapter([]);
    __setTasksSupaAdapterForTests(adapter);
    const res = await GET(req(url));
    expect(res.status).toBe(401);
    expect(adapter.listDocs).not.toHaveBeenCalled();
  });

  it('403s for an authenticated non-manager and never reads', async () => {
    const adapter = makeAdapter([]);
    __setTasksSupaAdapterForTests(adapter);
    mockVerifyAuthentication.mockResolvedValue({
      authenticated: true,
      user: { user: { uid: 'u9', permissions: {} } },
    });
    mockHasPermission.mockResolvedValue(false);
    const res = await GET(req(url));
    expect(res.status).toBe(403);
    expect(adapter.listDocs).not.toHaveBeenCalled();
    expect(mockHasPermission).toHaveBeenCalledWith({}, 'u9', 'canManageTasks');
  });

  it('serves { id, status } projections to a canManageTasks holder from one bounded leg', async () => {
    const adapter = makeAdapter([
      { id: 't9', projectId: 'p1', status: 'pending', title: 'Secret title', assigneeId: 'u1' },
      { id: 't7', projectId: 'p1', status: 'completed', title: 'Other', assigneeId: 'u2' },
    ]);
    __setTasksSupaAdapterForTests(adapter);
    mockVerifyAuthentication.mockResolvedValue({
      authenticated: true,
      user: { user: { uid: 'boss', canManageTasks: true } },
    });
    const res = await GET(req(url));
    expect(res.status).toBe(200);
    const body = await res.json();
    const [collection, options] = adapter.listDocs.mock.calls[0];
    expect(collection).toBe('tasks');
    expect(options.where).toEqual([['projectId', '==', 'p1']]);
    expect(options.limit).toBe(2000);
    // Sorted by id; only id + status cross the wire.
    expect(body.tasks).toEqual([
      { id: 't7', status: 'completed' },
      { id: 't9', status: 'pending' },
    ]);
  });

  it('honors the server permission check when claims do not carry the grant', async () => {
    const adapter = makeAdapter([{ id: 't1', projectId: 'p1', status: 'pending' }]);
    __setTasksSupaAdapterForTests(adapter);
    mockVerifyAuthentication.mockResolvedValue({
      authenticated: true,
      user: { user: { uid: 'u7', permissions: {} } },
    });
    mockHasPermission.mockResolvedValue(true);
    const res = await GET(req(url));
    expect(res.status).toBe(200);
  });
});
