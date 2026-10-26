/**
 * @jest-environment node
 *
 * Cutover primacy + GAP-T1-01 pins for the tasks-route seam
 * (feat/supa-cut-tasks). Mocked adapter only — zero live reads.
 *
 * Covers:
 * - isTasksSupaPrimary flag law: BOTH SUPA_SURFACES and SUPA_PRIMARY
 *   must name 'tasks' ('*' counts in either).
 * - GAP-T1-01 bound-before-filter: the seam guarantee the GET
 *   /api/tasks?assigneeId= route algorithm relies on — each union leg
 *   is bounded by limitParam BEFORE union/dedupe/filter/slice, so a
 *   doc beyond its leg's bound is invisible to the request even when
 *   it would pass the filter (the ratified divergence from the OFF
 *   path's unbounded legs, contract C-LIST-06).
 * - createTaskDocPrimaryFirst: adapter-first write with resolved
 *   serverTimestamp sentinels; adapter failure throws; primacy
 *   inactive -> no adapter call, returns false.
 * - deleteTaskDocWithPrimacy: adapter delete runs BEFORE the
 *   Firestore mirror delete; adapter failure leaves Firestore
 *   untouched and throws; primacy inactive -> Firestore first, mirror
 *   after (pre-cutover order).
 * - mirror commit gate: with SUPA_PRIMARY set, mirror failures throw;
 *   without it, they never do (pre-cutover pin preserved).
 */

import {
  isTasksSupaPrimary,
  createTaskDocPrimaryFirst,
  deleteTaskDocWithPrimacy,
  mirrorTaskDocById,
  listTasksDocs,
  resolveForPrimaryWrite,
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
  delete process.env.SUPA_PRIMARY;
  __resetTasksSupaAdapterForTests();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

function enablePrimary(adapter: TasksSupaAdapter) {
  process.env.SUPA_SURFACES = 'tasks';
  process.env.SUPA_PRIMARY = 'tasks';
  __setTasksSupaAdapterForTests(adapter);
}

describe('isTasksSupaPrimary flag law', () => {
  it('requires BOTH flags to name tasks', () => {
    expect(isTasksSupaPrimary({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isTasksSupaPrimary({ SUPA_SURFACES: 'tasks' } as any)).toBe(false);
    expect(isTasksSupaPrimary({ SUPA_PRIMARY: 'tasks' } as any)).toBe(false);
    expect(isTasksSupaPrimary({ SUPA_SURFACES: 'tasks', SUPA_PRIMARY: 'events' } as any)).toBe(false);
    expect(isTasksSupaPrimary({ SUPA_SURFACES: 'tasks', SUPA_PRIMARY: 'tasks' } as any)).toBe(true);
    expect(isTasksSupaPrimary({ SUPA_SURFACES: 'events, tasks', SUPA_PRIMARY: 'tasks,users' } as any)).toBe(true);
    expect(isTasksSupaPrimary({ SUPA_SURFACES: '*', SUPA_PRIMARY: '*' } as any)).toBe(true);
  });
});

describe('GAP-T1-01 bound-before-filter (ratified ON-path semantics)', () => {
  it('a doc beyond its leg bound is invisible even when it passes the filter', async () => {
    // Adapter storage order for the assigneeId leg: three pending/
    // completed docs. The adapter enforces the limit per leg, exactly
    // as the real adapter's listDocs finishing does.
    const legDocs = [
      { id: 'a', status: 'pending', createdAt: '2026-10-25T03:00:00.000Z' },
      { id: 'b', status: 'completed', createdAt: '2026-10-25T02:00:00.000Z' },
      { id: 'c', status: 'pending', createdAt: '2026-10-25T01:00:00.000Z' },
    ];
    const adapter = makeAdapter({
      listDocs: jest.fn(async (_c: string, opts: any) => legDocs.slice(0, opts.limit)),
    });
    const limitParam = 2;

    // The route's assignee algorithm, verbatim in shape: bounded legs,
    // union + dedupe, status filter, createdAt-desc sort, slice.
    const [primaryDocs, coDocs] = await Promise.all([
      listTasksDocs(adapter, { where: [['assigneeId', '==', 'u1']], limit: limitParam }),
      listTasksDocs(adapter, { where: [['assigneeIds', 'array-contains', 'u1']], limit: limitParam }),
    ]);
    expect(adapter.listDocs).toHaveBeenCalledTimes(2);
    for (const call of (adapter.listDocs as jest.Mock).mock.calls) {
      expect(call[1].limit).toBe(limitParam);
    }
    const seen = new Set<string>();
    const union = [...primaryDocs, ...coDocs].filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
    const filtered = union.filter((d) => String(d.data().status).toLowerCase() === 'pending');
    const page = filtered.slice(0, limitParam);

    // Bound-before-filter: 'c' is pending and WOULD appear on the OFF
    // path (unbounded legs, filter over the full union), but its leg
    // position (3rd) exceeds limitParam=2, so the ON path never sees it.
    expect(page.map((d) => d.id)).toEqual(['a']);
    // The OFF-path expectation over the same fixture, for contrast:
    const offUnion = legDocs.filter((d) => d.status === 'pending');
    expect(offUnion.map((d) => d.id)).toEqual(['a', 'c']);
  });

  it('terminal vocabulary is untouched by the bound: completed + legacy approved both survive the filter stage', async () => {
    const adapter = makeAdapter({
      listDocs: jest.fn(async () => [
        { id: 't1', status: 'completed', createdAt: '2026-10-25T03:00:00.000Z' },
        { id: 't2', status: 'approved', createdAt: '2026-10-25T02:00:00.000Z' },
      ]),
    });
    const docs = await listTasksDocs(adapter, { where: [['assigneeId', '==', 'u1']], limit: 100 });
    expect(docs.map((d) => d.data().status)).toEqual(['completed', 'approved']);
  });
});

describe('createTaskDocPrimaryFirst', () => {
  it('writes the adapter first with serverTimestamp sentinels resolved to ISO', async () => {
    const adapter = makeAdapter();
    enablePrimary(adapter);
    const ok = await createTaskDocPrimaryFirst('task-1', {
      title: 'X',
      createdAt: { _methodName: 'serverTimestamp' },
      count: { _methodName: 'increment', n: 1 },
    });
    expect(ok).toBe(true);
    expect(adapter.setDoc).toHaveBeenCalledTimes(1);
    const [collection, id, payload] = (adapter.setDoc as jest.Mock).mock.calls[0];
    expect(collection).toBe('tasks');
    expect(id).toBe('task-1');
    expect(payload.title).toBe('X');
    expect(typeof payload.createdAt).toBe('string');
    expect(() => new Date(payload.createdAt).toISOString()).not.toThrow();
    expect(payload.count).toBeUndefined();
  });

  it('throws when the primary write fails (no silent fallback)', async () => {
    const adapter = makeAdapter({
      setDoc: jest.fn(async () => {
        throw new Error('supa down');
      }),
    });
    enablePrimary(adapter);
    await expect(createTaskDocPrimaryFirst('task-1', { title: 'X' })).rejects.toThrow('supa down');
  });

  it('primacy inactive: returns false and never touches the adapter', async () => {
    const adapter = makeAdapter();
    process.env.SUPA_SURFACES = 'tasks'; // dual-write only, no SUPA_PRIMARY
    __setTasksSupaAdapterForTests(adapter);
    await expect(createTaskDocPrimaryFirst('task-1', { title: 'X' })).resolves.toBe(false);
    expect(adapter.setDoc).not.toHaveBeenCalled();
  });
});

describe('deleteTaskDocWithPrimacy', () => {
  it('primary: adapter delete runs BEFORE the Firestore mirror delete', async () => {
    const order: string[] = [];
    const adapter = makeAdapter({
      deleteDoc: jest.fn(async () => {
        order.push('supa');
      }),
    });
    enablePrimary(adapter);
    const mode = await deleteTaskDocWithPrimacy('task-9', async () => {
      order.push('firestore');
    });
    expect(mode).toBe('primary');
    expect(order).toEqual(['supa', 'firestore']);
  });

  it('primary: adapter failure throws and Firestore is never touched', async () => {
    const adapter = makeAdapter({
      deleteDoc: jest.fn(async () => {
        throw new Error('supa down');
      }),
    });
    enablePrimary(adapter);
    const firestoreDelete = jest.fn(async () => undefined);
    await expect(deleteTaskDocWithPrimacy('task-9', firestoreDelete)).rejects.toThrow('supa down');
    expect(firestoreDelete).not.toHaveBeenCalled();
  });

  it('dual-write: Firestore first, mirror delete after (pre-cutover order)', async () => {
    const order: string[] = [];
    const adapter = makeAdapter({
      deleteDoc: jest.fn(async () => {
        order.push('supa');
      }),
    });
    process.env.SUPA_SURFACES = 'tasks';
    __setTasksSupaAdapterForTests(adapter);
    const mode = await deleteTaskDocWithPrimacy('task-9', async () => {
      order.push('firestore');
    });
    expect(mode).toBe('firestore');
    expect(order).toEqual(['firestore', 'supa']);
  });
});

describe('mirror commit gate under primacy', () => {
  it('SUPA_PRIMARY set: a mirror write failure throws', async () => {
    const adapter = makeAdapter({
      setDoc: jest.fn(async () => {
        throw new Error('supa down');
      }),
    });
    enablePrimary(adapter);
    await expect(
      mirrorTaskDocById('task-1', async () => ({ title: 'X' })),
    ).rejects.toThrow('supa down');
  });

  it('SUPA_PRIMARY unset: the same failure is logged, never thrown (pre-cutover pin)', async () => {
    const adapter = makeAdapter({
      setDoc: jest.fn(async () => {
        throw new Error('supa down');
      }),
    });
    process.env.SUPA_SURFACES = 'tasks';
    __setTasksSupaAdapterForTests(adapter);
    await expect(
      mirrorTaskDocById('task-1', async () => ({ title: 'X' })),
    ).resolves.toBeUndefined();
  });
});

describe('resolveForPrimaryWrite', () => {
  it('resolves nested serverTimestamp sentinels and drops other sentinels', () => {
    const out = resolveForPrimaryWrite(
      {
        a: { _methodName: 'serverTimestamp' },
        nested: { b: { _methodName: 'serverTimestamp' }, c: { _methodName: 'deleteField' } },
        when: new Date('2026-10-25T00:00:00.000Z'),
        plain: 42,
      },
      '2026-10-26T00:00:00.000Z',
    );
    expect(out.a).toBe('2026-10-26T00:00:00.000Z');
    expect(out.nested.b).toBe('2026-10-26T00:00:00.000Z');
    expect(out.nested.c).toBeUndefined();
    expect(out.when).toBe('2026-10-25T00:00:00.000Z');
    expect(out.plain).toBe(42);
  });
});
