/**
 * @jest-environment node
 *
 * BEHAVIOR CONTRACTS — tasks cluster, group 3 surface (client lib):
 * src/lib/task-management.ts fetch/write helpers over the CLIENT
 * Firestore SDK, recorded at feat/integration-wave3 @ 4d5a1e16 ahead
 * of feat/supa-tasks-3. (That branch routes the fetch helpers through
 * seam-backed endpoints with Firestore fallback and leaves updateTask
 * untouched — these contracts are the acceptance gate.)
 *
 * Contracts:
 *   C-TM-01  getTask: { id, ...data } for an existing doc (document id
 *            wins over a stored rogue id field); null when missing.
 *   C-TM-02  getAllTasks: returns every doc as { id, ...data }.
 *            !!! UNBOUNDED PIN: it calls getDocs with the BARE
 *            collection reference — no query, no limit. A seam-backed
 *            replacement must not reproduce an unbounded listDocs;
 *            equally it must not silently truncate the result set.
 *            Flagged as GAP-T3-01 in CONTRACTS.md.
 *   C-TM-03  getUserTasks: union of assigneeId == and assigneeIds
 *            array-contains queries, deduped by doc id, { id,
 *            ...data } shape.
 *   C-TM-04  getTasksCreatedBy: single where('assignerId','==',uid)
 *            query, { id, ...data } shape.
 *   C-TM-05  createTask: addDoc payload = taskData + createdAt /
 *            updatedAt stamped with Timestamp.now(); returns the new
 *            document id.
 *   C-TM-06  updateTask: status normalization — lowercased; allowed
 *            set pending|in-progress|submitted-for-review|completed
 *            passes through; EVERYTHING else (incl. the legacy
 *            display status 'overdue' and unknown strings) maps to
 *            'in-progress'. updatedAt is stamped Timestamp.now().
 *            Non-status updates leave status absent (no invention).
 */

const getDocsCalls: any[] = [];
let getDocsImpl: (q: any) => Promise<any> = async () => ({ docs: [] });
let getDocImpl: (ref: any) => Promise<any> = async () => ({ exists: () => false, id: 'x', data: () => undefined });
const addDocMock = jest.fn(async (_ref: any, _data: any) => ({ id: 'created-1' }));
const updateDocMock = jest.fn(async () => undefined);
const deleteDocMock = jest.fn(async () => undefined);
const NOW_SENTINEL = { __ts: 'now' };

jest.mock('firebase/firestore', () => ({
  collection: (fs: any, name: string) => ({ __kind: 'collection', name }),
  doc: (fs: any, name: string, id: string) => ({ __kind: 'doc', name, id }),
  query: (ref: any, ...constraints: any[]) => ({ __kind: 'query', ref, constraints }),
  where: (field: string, op: string, value: any) => ({ field, op, value }),
  getDocs: async (q: any) => { getDocsCalls.push(q); return getDocsImpl(q); },
  getDoc: async (ref: any) => getDocImpl(ref),
  Timestamp: { now: () => NOW_SENTINEL },
  increment: (n: number) => ({ __inc: n }),
}));

jest.mock('@/lib/client/firestore-wrapper', () => ({
  addDoc: (...a: any[]) => (addDocMock as any)(...a),
  updateDoc: (...a: any[]) => (updateDocMock as any)(...a),
  deleteDoc: (...a: any[]) => (deleteDocMock as any)(...a),
}));

import { getTask, getAllTasks, getUserTasks, getTasksCreatedBy, createTask, updateTask } from '../task-management';

const fakeFs: any = { __fs: true };

function snap(id: string, data: any) {
  return { id, data: () => data };
}

beforeEach(() => {
  jest.clearAllMocks();
  getDocsCalls.length = 0;
  getDocsImpl = async () => ({ docs: [] });
  getDocImpl = async () => ({ exists: () => false, id: 'x', data: () => undefined });
});

describe('C-TM: task-management helpers', () => {
  it('C-TM-01: getTask shape and null-on-missing', async () => {
    getDocImpl = async () => ({ exists: () => true, id: 'real-id', data: () => ({ id: 'rogue', title: 'T', status: 'pending' }) });
    // NOTE: spread order here is { id: snap.id, ...data } — the STORED
    // rogue id actually WINS in this helper (opposite of the API
    // list serializer). Pinned as-is; drift either way must be loud.
    await expect(getTask(fakeFs, 'real-id')).resolves.toEqual({ id: 'rogue', title: 'T', status: 'pending' });
    getDocImpl = async () => ({ exists: () => false, id: 'x', data: () => undefined });
    await expect(getTask(fakeFs, 'x')).resolves.toBeNull();
  });

  it('C-TM-02: getAllTasks is UNBOUNDED — getDocs receives the bare collection ref', async () => {
    getDocsImpl = async () => ({ docs: [snap('a', { title: 'A' }), snap('b', { title: 'B' })] });
    const out = await getAllTasks(fakeFs);
    expect(out.map((t: any) => t.id)).toEqual(['a', 'b']);
    expect(getDocsCalls).toHaveLength(1);
    expect(getDocsCalls[0]).toEqual({ __kind: 'collection', name: 'tasks' }); // no query wrapper, no limit
  });

  it('C-TM-03: getUserTasks unions both assignment forms and dedupes', async () => {
    getDocsImpl = async (q: any) => {
      const w = q.constraints[0];
      if (w.field === 'assigneeId') return { docs: [snap('t-1', { title: 'One' }), snap('t-2', { title: 'Two' })] };
      return { docs: [snap('t-2', { title: 'Two' }), snap('t-3', { title: 'Three' })] };
    };
    const out = await getUserTasks(fakeFs, 'user-1');
    expect(out.map((t: any) => t.id)).toEqual(['t-1', 't-2', 't-3']);
    expect(getDocsCalls.map((c) => c.constraints[0])).toEqual([
      { field: 'assigneeId', op: '==', value: 'user-1' },
      { field: 'assigneeIds', op: 'array-contains', value: 'user-1' },
    ]);
  });

  it('C-TM-04: getTasksCreatedBy single assignerId query', async () => {
    getDocsImpl = async () => ({ docs: [snap('t-9', { title: 'Mine' })] });
    const out = await getTasksCreatedBy(fakeFs, 'user-1');
    expect(out).toEqual([{ id: 't-9', title: 'Mine' }]);
    expect(getDocsCalls[0].constraints[0]).toEqual({ field: 'assignerId', op: '==', value: 'user-1' });
  });

  it('C-TM-05: createTask stamps Timestamp.now() and returns the new id', async () => {
    const id = await createTask(fakeFs, { title: 'New', status: 'pending' } as any);
    expect(id).toBe('created-1');
    const payload = (addDocMock.mock.calls[0] as any)[1];
    expect(payload).toMatchObject({ title: 'New', status: 'pending', createdAt: NOW_SENTINEL, updatedAt: NOW_SENTINEL });
  });

  it('C-TM-06: updateTask status normalization table', async () => {
    const cases: Array<[string, string]> = [
      ['pending', 'pending'],
      ['In-Progress', 'in-progress'],
      ['submitted-for-review', 'submitted-for-review'],
      ['completed', 'completed'],
      ['overdue', 'in-progress'], // legacy display status never persists via this helper
      ['bogus', 'in-progress'],
    ];
    for (const [input, expected] of cases) {
      updateDocMock.mockClear();
      await updateTask(fakeFs, 't-1', { status: input } as any);
      const payload = (updateDocMock.mock.calls[0] as any)[1];
      expect(payload.status).toBe(expected);
      expect(payload.updatedAt).toBe(NOW_SENTINEL);
    }
    updateDocMock.mockClear();
    await updateTask(fakeFs, 't-1', { title: 'Retitle' } as any);
    const payload = (updateDocMock.mock.calls[0] as any)[1];
    expect('status' in payload).toBe(false);
    expect(payload.title).toBe('Retitle');
  });
});
