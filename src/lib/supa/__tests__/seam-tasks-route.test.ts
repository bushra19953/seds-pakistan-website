/**
 * @jest-environment node
 *
 * Seam unit tests for the tasks-route Supabase seam. Mocked adapter only —
 * zero live reads (no Firestore, no Supabase network).
 *
 * Covers:
 * - flag parsing (SUPA_SURFACES, surface 'tasks', default OFF)
 * - flag OFF -> resolveTasksSupaAdapter() is null even with an adapter
 *   injected (the route's Firestore path stays byte-identical)
 * - flag ON + mocked adapter: timestamp normalization (ISO strings and
 *   {seconds,nanoseconds} jsonb shapes become Timestamp-like values the
 *   route's .toDate()/.toMillis()/.seconds consumers can use)
 * - listTasksDocs boundedness: every adapter call carries the limit, and
 *   a missing/invalid limit throws instead of issuing an unbounded read
 * - mirror-on-write: setDoc/deleteDoc receive sanitized data, and mirror
 *   failures (adapter throws, fetch throws) never propagate
 */

import {
  isTasksSupaFlagOn,
  resolveTasksSupaAdapter,
  listTasksDocs,
  mirrorTaskDocById,
  mirrorTaskDocsByIds,
  mirrorTaskDeletesByIds,
  sanitizeForMirror,
  normalizeTaskDocData,
  toSeamTimestamp,
  __setTasksSupaAdapterForTests,
  __resetTasksSupaAdapterForTests,
  type TasksSupaAdapter,
} from '../seam-tasks-route';

const ORIGINAL_ENV = { ...process.env };

function makeAdapter(overrides: Partial<TasksSupaAdapter> = {}): TasksSupaAdapter {
  return {
    getDoc: jest.fn(async () => null),
    listDocs: jest.fn(async () => []),
    countDocs: jest.fn(async () => 0),
    setDoc: jest.fn(async () => undefined),
    updateDoc: jest.fn(async () => undefined),
    deleteDoc: jest.fn(async () => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.SUPA_SURFACES;
  __resetTasksSupaAdapterForTests();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('flag parsing', () => {
  it('defaults OFF when SUPA_SURFACES is unset or does not name tasks', () => {
    expect(isTasksSupaFlagOn({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isTasksSupaFlagOn({ SUPA_SURFACES: '' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isTasksSupaFlagOn({ SUPA_SURFACES: 'events,users' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('is ON only for the exact tasks surface entry', () => {
    expect(isTasksSupaFlagOn({ SUPA_SURFACES: 'tasks' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isTasksSupaFlagOn({ SUPA_SURFACES: 'events, tasks ' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isTasksSupaFlagOn({ SUPA_SURFACES: 'tasks-archive' } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('resolveTasksSupaAdapter', () => {
  it('flag OFF: returns null even when an adapter is available', async () => {
    __setTasksSupaAdapterForTests(makeAdapter());
    await expect(resolveTasksSupaAdapter()).resolves.toBeNull();
  });

  it('flag ON: returns the injected adapter', async () => {
    process.env.SUPA_SURFACES = 'tasks';
    const adapter = makeAdapter();
    __setTasksSupaAdapterForTests(adapter);
    await expect(resolveTasksSupaAdapter()).resolves.toBe(adapter);
  });

  it('flag ON + adapter explicitly absent: returns null', async () => {
    process.env.SUPA_SURFACES = 'tasks';
    __setTasksSupaAdapterForTests(null);
    await expect(resolveTasksSupaAdapter()).resolves.toBeNull();
  });
});

describe('timestamp normalization', () => {
  it('converts ISO strings to Timestamp-like values', () => {
    const ts = toSeamTimestamp('2026-10-25T07:51:00.000Z');
    expect(ts).not.toBeNull();
    expect(ts!.toDate().toISOString()).toBe('2026-10-25T07:51:00.000Z');
    expect(ts!.toMillis()).toBe(Date.parse('2026-10-25T07:51:00.000Z'));
    expect(ts!.seconds).toBe(Math.floor(Date.parse('2026-10-25T07:51:00.000Z') / 1000));
  });

  it('converts {seconds, nanoseconds} jsonb shapes', () => {
    const ts = toSeamTimestamp({ seconds: 1761000000, nanoseconds: 500000000 });
    expect(ts!.toMillis()).toBe(1761000000500);
  });

  it('leaves non-timestamp strings and nulls alone in doc normalization', () => {
    const out = normalizeTaskDocData({
      title: 'Ship it',
      status: 'pending',
      createdAt: '2026-10-25T07:51:00.000Z',
      acceptedAt: null,
      deadline: 'not-a-date',
      acceptanceBy: { u1: { status: 'accepted', acceptedAt: '2026-10-25T08:00:00.000Z', acceptedBy: 'u1' } },
    });
    expect(out.title).toBe('Ship it');
    expect(typeof (out.createdAt as any).toDate).toBe('function');
    expect(out.acceptedAt).toBeNull();
    expect(out.deadline).toBe('not-a-date');
    expect(typeof (out.acceptanceBy.u1.acceptedAt as any).toMillis).toBe('function');
  });
});

describe('listTasksDocs boundedness', () => {
  it('passes the limit through to every adapter call', async () => {
    const adapter = makeAdapter({
      listDocs: jest.fn(async () => [
        { id: 't1', title: 'A', createdAt: '2026-10-25T07:51:00.000Z' },
      ]),
    });
    const docs = await listTasksDocs(adapter, {
      where: [['status', '==', 'pending']],
      orderBy: ['createdAt', 'desc'],
      limit: 25,
    });
    expect(adapter.listDocs).toHaveBeenCalledTimes(1);
    const [, opts] = (adapter.listDocs as jest.Mock).mock.calls[0];
    expect(opts.limit).toBe(25);
    expect(opts.where).toEqual([['status', '==', 'pending']]);
    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe('t1');
    expect(docs[0].data().title).toBe('A');
    expect(typeof (docs[0].get('createdAt') as any).toDate).toBe('function');
  });

  it('throws instead of issuing an unbounded read when limit is missing/invalid', async () => {
    const adapter = makeAdapter();
    await expect(listTasksDocs(adapter, { limit: undefined as any })).rejects.toThrow(/limit/);
    await expect(listTasksDocs(adapter, { limit: 0 })).rejects.toThrow(/limit/);
    await expect(listTasksDocs(adapter, { limit: Number.POSITIVE_INFINITY })).rejects.toThrow(/limit/);
    expect(adapter.listDocs).not.toHaveBeenCalled();
  });

  it('propagates adapter errors so the route ladder can degrade', async () => {
    const adapter = makeAdapter({
      listDocs: jest.fn(async () => {
        throw new Error('adapter boom');
      }),
    });
    await expect(listTasksDocs(adapter, { limit: 10 })).rejects.toThrow('adapter boom');
  });
});

describe('mirror-on-write', () => {
  beforeEach(() => {
    process.env.SUPA_SURFACES = 'tasks';
  });

  it('mirrors a sanitized copy: timestamps become ISO strings, sentinels drop', async () => {
    const adapter = makeAdapter();
    __setTasksSupaAdapterForTests(adapter);
    const fakeTs = {
      toDate: () => new Date('2026-10-25T07:51:00.000Z'),
      toMillis: () => Date.parse('2026-10-25T07:51:00.000Z'),
    };
    await mirrorTaskDocById('task-1', async () => ({
      title: 'A',
      createdAt: fakeTs,
      serverStamp: { _methodName: 'serverTimestamp' },
      nested: { when: new Date('2026-01-01T00:00:00.000Z') },
    }));
    expect(adapter.setDoc).toHaveBeenCalledTimes(1);
    const [collection, id, data] = (adapter.setDoc as jest.Mock).mock.calls[0];
    expect(collection).toBe('tasks');
    expect(id).toBe('task-1');
    expect(data).toEqual({
      title: 'A',
      createdAt: '2026-10-25T07:51:00.000Z',
      nested: { when: '2026-01-01T00:00:00.000Z' },
    });
  });

  it('never throws when the adapter write fails', async () => {
    const adapter = makeAdapter({
      setDoc: jest.fn(async () => {
        throw new Error('mirror boom');
      }),
      deleteDoc: jest.fn(async () => {
        throw new Error('mirror delete boom');
      }),
    });
    __setTasksSupaAdapterForTests(adapter);
    await expect(mirrorTaskDocById('task-1', async () => ({ title: 'A' }))).resolves.toBeUndefined();
    await expect(mirrorTaskDeletesByIds(['task-1'])).resolves.toBeUndefined();
  });

  it('never throws when the re-read fetcher fails', async () => {
    const adapter = makeAdapter();
    __setTasksSupaAdapterForTests(adapter);
    await expect(
      mirrorTaskDocById('task-1', async () => {
        throw new Error('fetch boom');
      })
    ).resolves.toBeUndefined();
    expect(adapter.setDoc).not.toHaveBeenCalled();
  });

  it('flag OFF: performs no adapter calls and does not even invoke the fetcher', async () => {
    delete process.env.SUPA_SURFACES;
    const adapter = makeAdapter();
    __setTasksSupaAdapterForTests(adapter);
    const fetcher = jest.fn(async () => ({ title: 'A' }));
    await mirrorTaskDocById('task-1', fetcher);
    await mirrorTaskDocsByIds(['task-1'], fetcher);
    await mirrorTaskDeletesByIds(['task-1']);
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter.setDoc).not.toHaveBeenCalled();
    expect(adapter.deleteDoc).not.toHaveBeenCalled();
  });

  it('mirrors deletes for each id', async () => {
    const adapter = makeAdapter();
    __setTasksSupaAdapterForTests(adapter);
    await mirrorTaskDeletesByIds(['a', 'b', 'a']);
    expect(adapter.deleteDoc).toHaveBeenCalledTimes(2);
    expect((adapter.deleteDoc as jest.Mock).mock.calls.map((c) => c[1])).toEqual(['a', 'b']);
  });
});

describe('sanitizeForMirror', () => {
  it('drops undefined and FieldValue-like sentinels at any depth', () => {
    expect(
      sanitizeForMirror({
        a: 1,
        b: undefined,
        c: { _methodName: 'increment' },
        d: [{ _methodName: 'arrayUnion' }, 2],
      })
    ).toEqual({ a: 1, d: [2] });
  });
});
