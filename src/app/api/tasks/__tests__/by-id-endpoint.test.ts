/**
 * @jest-environment node
 *
 * MSG22 fix #2: GET /api/tasks/by-id, the seam-backed single-doc
 * endpoint behind getTask in src/lib/task-management.ts. Pattern
 * follows supa-admin-tasks-endpoints.test.ts (mocked adapter via the
 * seam's test injection points, fake admin db, zero live reads).
 *
 * Contract:
 *  - flag OFF / adapter absent: 404 (inert; the client keeps its
 *    exact Firestore behavior).
 *  - flag ON, doc held by the seam: 200 { task } with timestamps
 *    normalized by the seam (the seam-only proof-task case).
 *  - flag ON, genuine seam miss: 200 { task: null } (authoritative;
 *    the client must not fall back to the superseded store).
 *  - missing taskId: 400. Unauthenticated: 401.
 */

const mockVerifyAuthentication = jest.fn();
const mockHasPermission = jest.fn(async (..._args: any[]) => true);

let mockFirestoreDoc: { exists: boolean; data?: any } = { exists: false };
const mockDb: any = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      id,
      path: `${name}/${id}`,
      get: async () => ({
        exists: mockFirestoreDoc.exists,
        id,
        data: () => mockFirestoreDoc.data,
      }),
    }),
  }),
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDb,
  admin: { firestore: { FieldValue: { increment: (n: number) => ({ __increment: n }) } } },
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: (...args: any[]) => mockVerifyAuthentication(...args),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: (...args: any[]) => mockHasPermission(...args),
}));

import { GET as byIdGET } from '@/app/api/tasks/by-id/route';
import {
  __setAdminTasksSupaAdapterForTests,
  __resetAdminTasksSupaAdapterForTests,
  type AdminTasksSupaAdapter,
} from '@/lib/supa/seam-admin-tasks';

function req(url: string): any {
  return { url, headers: new Headers() };
}

function makeAdapter(overrides: Partial<AdminTasksSupaAdapter> = {}): AdminTasksSupaAdapter {
  return {
    getDoc: jest.fn(async () => null),
    listDocs: jest.fn(async () => []),
    countDocs: jest.fn(async () => 0),
    setDoc: jest.fn(async () => ({})),
    updateDoc: jest.fn(async () => ({})),
    deleteDoc: jest.fn(async () => undefined),
    ...overrides,
  } as AdminTasksSupaAdapter;
}

const GHOST = {
  id: 'lTJyJck1YWebBTTzh9qn',
  title: 'Email Premium Proof — Oct 25 (post-reset)',
  status: 'pending',
  assigneeId: 'Yv63B6AM52PyLNOKXjE2JhApMkw1',
  deadline: '2026-10-26T12:00:00.000Z',
  resources: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFirestoreDoc = { exists: false };
  mockVerifyAuthentication.mockResolvedValue({
    authenticated: true,
    user: { user: { uid: 'admin-1', permissions: { manageTasks: true } } },
  });
});

afterEach(() => {
  __resetAdminTasksSupaAdapterForTests();
});

describe('GET /api/tasks/by-id (MSG22 fix #2)', () => {
  it('flag OFF (adapter null) answers 404', async () => {
    __setAdminTasksSupaAdapterForTests(null);
    const res = await byIdGET(req('http://x/api/tasks/by-id?taskId=lTJyJck1YWebBTTzh9qn'));
    expect(res.status).toBe(404);
  });

  it('seam-only doc is served with its own data', async () => {
    const adapter = makeAdapter({
      getDoc: jest.fn(async (col: string, id: string) =>
        col === 'tasks' && id === GHOST.id ? { ...GHOST } : null
      ),
    });
    __setAdminTasksSupaAdapterForTests(adapter);
    const res = await byIdGET(req('http://x/api/tasks/by-id?taskId=lTJyJck1YWebBTTzh9qn'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task.id).toBe(GHOST.id);
    expect(body.task.title).toBe(GHOST.title);
    expect(body.task.status).toBe('pending');
    // The seam Timestamp shape serializes to its ISO string in JSON,
    // which is what the client's reviveApiTask turns back into a Date.
    expect(body.task.deadline).toBe('2026-10-26T12:00:00.000Z');
  });

  it('genuine seam miss answers 200 { task: null }', async () => {
    __setAdminTasksSupaAdapterForTests(makeAdapter());
    const res = await byIdGET(req('http://x/api/tasks/by-id?taskId=nope'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task).toBeNull();
  });

  it('missing taskId answers 400', async () => {
    __setAdminTasksSupaAdapterForTests(makeAdapter());
    const res = await byIdGET(req('http://x/api/tasks/by-id'));
    expect(res.status).toBe(400);
  });

  it('unauthenticated answers 401', async () => {
    __setAdminTasksSupaAdapterForTests(makeAdapter());
    mockVerifyAuthentication.mockResolvedValue({ authenticated: false, error: 'Unauthorized' });
    const res = await byIdGET(req('http://x/api/tasks/by-id?taskId=x'));
    expect(res.status).toBe(401);
  });

  it('seam error falls back to the single Firestore doc', async () => {
    const adapter = makeAdapter({
      getDoc: jest.fn(async () => {
        throw new Error('seam down');
      }),
    });
    __setAdminTasksSupaAdapterForTests(adapter);
    mockFirestoreDoc = { exists: true, data: { title: 'Firestore task', status: 'pending' } };
    const res = await byIdGET(req('http://x/api/tasks/by-id?taskId=real-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task).toEqual({ id: 'real-1', title: 'Firestore task', status: 'pending' });
  });
});
