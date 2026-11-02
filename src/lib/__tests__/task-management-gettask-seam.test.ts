/**
 * MSG22 fix #2: getTask is seam-first.
 *
 * The 3 Oct 25 proof tasks exist only in the Supabase mirror while the
 * admin task LIST is seam-served, so they list fine. getTask used to be
 * a bare Firestore getDoc: it returned null for them, and the admin
 * Edit dialog silently degraded to a blank CREATE form. getTask now
 * tries the seam-backed GET /api/tasks/by-id endpoint first (the same
 * pattern as its sibling helpers) and falls back to the exact
 * Firestore read whenever the endpoint does not serve.
 *
 * Cases:
 *  (a) seam-only doc (Firestore missing, seam holds it) is returned
 *      with its own data, timestamps revived to Dates like the
 *      sibling helpers' API results.
 *  (b) endpoint inert (flag OFF 404): Firestore fallback decides,
 *      existing doc returned, missing doc returns null (the null the
 *      page handler now turns into a loud error + closed dialog).
 *  (c) no signed-in user: no fetch is attempted, Firestore decides.
 */

let getDocImpl: (ref: any) => Promise<any> = async () => ({
  exists: () => false,
  id: 'x',
  data: () => undefined,
});
let currentUser: any = { getIdToken: async () => 'test-token' };
const fetchMock = jest.fn();

jest.mock('firebase/firestore', () => ({
  collection: (fs: any, name: string) => ({ __kind: 'collection', name }),
  doc: (fs: any, name: string, id: string) => ({ __kind: 'doc', name, id }),
  query: (ref: any, ...constraints: any[]) => ({ __kind: 'query', ref, constraints }),
  where: (field: string, op: string, value: any) => ({ field, op, value }),
  getDocs: jest.fn(async () => ({ docs: [] })),
  getDoc: async (ref: any) => getDocImpl(ref),
  Timestamp: { now: () => ({ __ts: 'now' }) },
  increment: (n: number) => ({ __inc: n }),
}));

jest.mock('@/lib/client/firestore-wrapper', () => ({
  addDoc: jest.fn(async () => ({ id: 'created-1' })),
  updateDoc: jest.fn(async () => undefined),
  deleteDoc: jest.fn(async () => undefined),
}));

jest.mock('firebase/auth', () => ({
  getAuth: () => ({ currentUser }),
}));

import { getTask } from '../task-management';

const fakeFs: any = { __fs: true };

const SEAM_TASK = {
  id: 'lTJyJck1YWebBTTzh9qn',
  title: 'Email Premium Proof — Oct 25 (post-reset)',
  description: 'Proof that premium email delivery works',
  status: 'pending',
  assigneeId: 'Yv63B6AM52PyLNOKXjE2JhApMkw1',
  assigneeIds: ['Yv63B6AM52PyLNOKXjE2JhApMkw1'],
  deadline: '2026-10-26T12:00:00.000Z',
  createdAt: '2026-10-25T10:00:00.000Z',
  updatedAt: '2026-10-25T10:00:00.000Z',
  resources: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  currentUser = { getIdToken: async () => 'test-token' };
  getDocImpl = async () => ({ exists: () => false, id: 'x', data: () => undefined });
  fetchMock.mockReset();
  (global as any).fetch = fetchMock;
});

describe('getTask seam-first (MSG22 fix #2)', () => {
  it('(a) returns a seam-only doc with its own data, timestamps revived', async () => {
    // Firestore does NOT hold the doc (the proven ghost state).
    getDocImpl = async () => ({ exists: () => false, id: 'lTJyJck1YWebBTTzh9qn', data: () => undefined });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ task: SEAM_TASK }),
    });

    const task: any = await getTask(fakeFs, 'lTJyJck1YWebBTTzh9qn');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/by-id?taskId=lTJyJck1YWebBTTzh9qn',
      expect.objectContaining({ headers: { Authorization: 'Bearer test-token' } })
    );
    expect(task).not.toBeNull();
    expect(task.id).toBe('lTJyJck1YWebBTTzh9qn');
    expect(task.title).toBe('Email Premium Proof — Oct 25 (post-reset)');
    expect(task.status).toBe('pending');
    expect(task.deadline).toBeInstanceOf(Date);
    expect((task.deadline as Date).toISOString()).toBe('2026-10-26T12:00:00.000Z');
  });

  it('(a2) seam-authoritative miss returns null without consulting Firestore data', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ task: null }) });
    await expect(getTask(fakeFs, 'missing-id')).resolves.toBeNull();
  });

  it('(b) endpoint inert (404) falls back to Firestore: existing doc returned', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'Not found' }) });
    getDocImpl = async () => ({
      exists: () => true,
      id: 'real-id',
      data: () => ({ title: 'Firestore task', status: 'pending' }),
    });
    await expect(getTask(fakeFs, 'real-id')).resolves.toEqual({
      id: 'real-id',
      title: 'Firestore task',
      status: 'pending',
    });
  });

  it('(b2) endpoint inert (404) and Firestore missing returns null', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'Not found' }) });
    await expect(getTask(fakeFs, 'ghost-id')).resolves.toBeNull();
  });

  it('(c) no signed-in user: no fetch attempted, Firestore decides', async () => {
    currentUser = null;
    getDocImpl = async () => ({
      exists: () => true,
      id: 'real-id',
      data: () => ({ title: 'Firestore task', status: 'pending' }),
    });
    await expect(getTask(fakeFs, 'real-id')).resolves.toEqual({
      id: 'real-id',
      title: 'Firestore task',
      status: 'pending',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
