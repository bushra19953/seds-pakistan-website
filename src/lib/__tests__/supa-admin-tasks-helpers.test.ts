/**
 * Supa migration (tasks cluster, group 3) — client helper parity tests
 * for src/lib/task-management.ts fetching functions.
 *
 * - Flag OFF parity: the seam endpoints answer 404 (their flag-OFF
 *   behavior) and the helpers return EXACTLY the Firestore results,
 *   including getUserTasks' deduped union of both assignee queries.
 * - Flag ON: the endpoints answer with seam-shaped tasks (ISO-string
 *   timestamps) and the helpers return them without touching Firestore;
 *   ISO timestamps are revived as Dates.
 * - No signed-in user: the API is never attempted; Firestore serves.
 *
 * Only the fetching functions are covered here. updateTask and its
 * status-mapping belong to fix/tasks-profile-board (see
 * supa-rebase-notes/tasks-3.md collision boundary) and are NOT touched.
 */

const mockGetDocs = jest.fn();
const mockGetAuth = jest.fn();

jest.mock('firebase/firestore', () => ({
  collection: (_fs: any, name: string) => ({ __collection: name }),
  doc: (_fs: any, name: string, id: string) => ({ __doc: `${name}/${id}` }),
  getDoc: jest.fn(),
  getDocs: (...args: any[]) => mockGetDocs(...args),
  query: (ref: any, ...constraints: any[]) => ({ __ref: ref, __constraints: constraints }),
  where: (field: string, op: string, value: any) => ({ field, op, value }),
  Timestamp: { now: () => ({ seconds: 0, nanoseconds: 0 }) },
  increment: (n: number) => ({ __increment: n }),
}));

jest.mock('@/lib/client/firestore-wrapper', () => ({
  addDoc: jest.fn(),
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
}));

jest.mock('firebase/auth', () => ({
  getAuth: () => mockGetAuth(),
}));

import { getAllTasks, getUserTasks, getTasksCreatedBy } from '@/lib/task-management';

const firestore: any = { __fake: true };

function fsDoc(id: string, data: Record<string, any>) {
  return { id, data: () => data };
}

function snapshotOf(docs: any[]) {
  return { docs };
}

const mockFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  (global as any).fetch = mockFetch;
  mockGetAuth.mockReturnValue({
    currentUser: { getIdToken: async () => 'test-token' },
  });
});

describe('flag OFF parity (endpoint 404 -> Firestore, unchanged)', () => {
  beforeEach(() => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'Not found' }) });
  });

  it('getAllTasks throws instead of the deleted full-collection fallback (census 04 T17)', async () => {
    mockGetDocs.mockResolvedValue(snapshotOf([
      fsDoc('t1', { title: 'One' }),
      fsDoc('t2', { title: 'Two' }),
    ]));
    await expect(getAllTasks(firestore)).rejects.toThrow(/full-collection fallback was removed/);
    expect(mockGetDocs).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledWith('/api/tasks/all', expect.objectContaining({
      headers: { Authorization: 'Bearer test-token' },
    }));
  });

  it('getUserTasks unions both assignee queries and dedupes by id', async () => {
    mockGetDocs.mockImplementation(async (q: any) => {
      const field = q?.__constraints?.[0]?.field;
      if (field === 'assigneeId') {
        return snapshotOf([fsDoc('t1', { title: 'A' }), fsDoc('t2', { title: 'B' })]);
      }
      if (field === 'assigneeIds') {
        return snapshotOf([fsDoc('t2', { title: 'B' }), fsDoc('t3', { title: 'C' })]);
      }
      throw new Error(`unexpected query field ${field}`);
    });
    const tasks = await getUserTasks(firestore, 'user-1');
    expect(tasks.map((t: any) => t.id)).toEqual(['t1', 't2', 't3']);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/tasks/by-user?userId=user-1&mode=assigned',
      expect.anything(),
    );
  });

  it('getTasksCreatedBy returns the assigner query results', async () => {
    mockGetDocs.mockResolvedValue(snapshotOf([fsDoc('t9', { title: 'Mine' })]));
    const tasks = await getTasksCreatedBy(firestore, 'user-1');
    expect(tasks.map((t: any) => t.id)).toEqual(['t9']);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/tasks/by-user?userId=user-1&mode=created',
      expect.anything(),
    );
  });
});

describe('flag ON (seam endpoint serves; Firestore untouched)', () => {
  it('getAllTasks returns endpoint tasks and revives ISO timestamps as Dates', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        tasks: [
          { id: 's1', title: 'Seam', createdAt: '2026-10-25T05:00:00.000Z', deadline: '2026-11-01T00:00:00.000Z' },
        ],
      }),
    });
    const tasks: any[] = await getAllTasks(firestore);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('s1');
    expect(tasks[0].createdAt).toBeInstanceOf(Date);
    expect((tasks[0].createdAt as Date).toISOString()).toBe('2026-10-25T05:00:00.000Z');
    expect(mockGetDocs).not.toHaveBeenCalled();
  });

  it('getAllTasks forwards a supplied limit to the endpoint', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ tasks: [] }) });
    await getAllTasks(firestore, { limit: 25 });
    expect(mockFetch).toHaveBeenCalledWith('/api/tasks/all?limit=25', expect.anything());
  });

  it('getUserTasks returns endpoint tasks without Firestore reads', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tasks: [{ id: 's2', title: 'ByUser' }] }),
    });
    const tasks = await getUserTasks(firestore, 'user-7');
    expect(tasks.map((t: any) => t.id)).toEqual(['s2']);
    expect(mockGetDocs).not.toHaveBeenCalled();
  });

  it('endpoint failure: getAllTasks throws (fallback deleted, census 04 T17)', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    mockGetDocs.mockResolvedValue(snapshotOf([fsDoc('t1', { title: 'Fallback' })]));
    await expect(getAllTasks(firestore)).rejects.toThrow(/full-collection fallback was removed/);
    expect(mockGetDocs).not.toHaveBeenCalled();
  });
});

describe('no signed-in user', () => {
  it('getAllTasks skips the API and throws (fallback deleted, census 04 T17)', async () => {
    mockGetAuth.mockReturnValue({ currentUser: null });
    mockGetDocs.mockResolvedValue(snapshotOf([fsDoc('t1', { title: 'Anon-safe' })]));
    await expect(getAllTasks(firestore)).rejects.toThrow(/full-collection fallback was removed/);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockGetDocs).not.toHaveBeenCalled();
  });

  it('getUserTasks still falls back to Firestore (its fallback is per-user bounded)', async () => {
    mockGetAuth.mockReturnValue({ currentUser: null });
    mockGetDocs.mockResolvedValue(snapshotOf([fsDoc('t1', { title: 'Anon-safe' })]));
    const tasks = await getUserTasks(firestore, 'user-1');
    expect(tasks.map((t: any) => t.id)).toEqual(['t1']);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
