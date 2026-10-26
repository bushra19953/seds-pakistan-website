/**
 * @jest-environment node
 *
 * GAP-T2-02 bound enforcement + primacy write pins for
 * seam-tasks-lists (feat/supa-cut-tasks). Mocked adapter only — zero
 * live reads.
 *
 * GAP-T2-02 decision (seam header): every caller of this seam filters
 * to a bounded set by construction (single-user legs, <=10-id chunks),
 * so the seam enforces a stated per-leg bound, TASKS_LISTS_LEG_BOUND,
 * whenever a caller supplies no explicit limit. These tests pin the
 * enforcement firing: a caller that passes no limit (the previous
 * unbounded shape) now reaches the adapter WITH the bound, and an
 * explicit caller limit always wins. The approval-rate legs — the
 * original unbounded site — are pinned to carry the bound on all
 * three legs.
 *
 * Primacy: writeDocPrimaryFirst writes the adapter first and throws
 * on failure when SUPA_PRIMARY=tasks; with SUPA_PRIMARY unset it is a
 * no-op returning false (the caller keeps its Firestore-first flow).
 */

import {
  TASKS_LISTS_LEG_BOUND,
  withLegBound,
  listDocsViaSeam,
  listTasksViaSeam,
  getApprovalRateViaSeam,
  writeDocPrimaryFirst,
  __setSupaLoaderForTests,
  type SupaAdapterLike,
} from '../seam-tasks-lists';

const ORIGINAL_ENV = { ...process.env };

function makeAdapter(overrides: Partial<SupaAdapterLike> = {}): SupaAdapterLike {
  return {
    getDoc: jest.fn(async () => null),
    listDocs: jest.fn(async () => []),
    countDocs: jest.fn(async () => 0),
    setDoc: jest.fn(async () => ({ id: 'x' }) as any),
    updateDoc: jest.fn(async () => ({ id: 'x' }) as any),
    deleteDoc: jest.fn(async () => undefined),
    ...overrides,
  };
}

function installModule(adapter: SupaAdapterLike) {
  __setSupaLoaderForTests(async () => ({
    useSupa: () => true,
    getSupaAdapter: () => adapter,
  }));
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.SUPA_SURFACES;
  delete process.env.SUPA_PRIMARY;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  __setSupaLoaderForTests(null);
  jest.restoreAllMocks();
});

describe('GAP-T2-02 bound enforcement', () => {
  it('withLegBound fills the stated bound and preserves explicit limits', () => {
    expect(TASKS_LISTS_LEG_BOUND).toBe(5000);
    expect(withLegBound(undefined).limit).toBe(5000);
    expect(withLegBound({}).limit).toBe(5000);
    expect(withLegBound({ limit: 100 }).limit).toBe(100);
    expect(withLegBound({ limit: 0 }).limit).toBe(5000);
    expect(withLegBound({ where: [['a', '==', 1]] }).where).toEqual([['a', '==', 1]]);
  });

  it('listDocsViaSeam: an unbounded-shaped call reaches the adapter WITH the bound', async () => {
    const adapter = makeAdapter();
    installModule(adapter);
    const snap = await listDocsViaSeam('reporting_relationships', {
      where: [['managerId', 'in', ['m1', 'm2']]],
    });
    expect(snap).not.toBeNull();
    expect(adapter.listDocs).toHaveBeenCalledTimes(1);
    const [, opts] = (adapter.listDocs as jest.Mock).mock.calls[0];
    expect(opts.limit).toBe(TASKS_LISTS_LEG_BOUND);
    expect(opts.where).toEqual([['managerId', 'in', ['m1', 'm2']]]);
  });

  it('listTasksViaSeam: team legs carry the bound; an explicit limit wins', async () => {
    const adapter = makeAdapter();
    installModule(adapter);
    await listTasksViaSeam([['assigneeId', 'in', ['u1', 'u2']]]);
    await listTasksViaSeam([['status', '==', 'submitted-for-review']], { limit: 100 });
    const calls = (adapter.listDocs as jest.Mock).mock.calls;
    expect(calls[0][1].limit).toBe(TASKS_LISTS_LEG_BOUND);
    expect(calls[1][1].limit).toBe(100);
  });

  it('getApprovalRateViaSeam: all three single-user legs carry the stated bound', async () => {
    const adapter = makeAdapter({
      listDocs: jest.fn(async () => [
        {
          id: 't1',
          assigneeId: 'u1',
          submittedBy: 'u1',
          status: 'completed',
          approvedAt: '2026-10-20T00:00:00.000Z',
          createdAt: '2026-10-19T00:00:00.000Z',
        },
      ]),
    });
    installModule(adapter);
    const rate = await getApprovalRateViaSeam('u1');
    expect(rate).not.toBeNull();
    expect(adapter.listDocs).toHaveBeenCalledTimes(3);
    for (const call of (adapter.listDocs as jest.Mock).mock.calls) {
      expect(call[0]).toBe('tasks');
      expect(call[1].limit).toBe(TASKS_LISTS_LEG_BOUND);
      expect(call[1].where).toHaveLength(1);
    }
    const wheres = (adapter.listDocs as jest.Mock).mock.calls.map((c: any) => c[1].where[0][0]);
    expect(wheres).toEqual(['assigneeId', 'assigneeIds', 'submittedBy']);
  });
});

describe('writeDocPrimaryFirst (tasks-lists primacy)', () => {
  it('primary active: writes the adapter and returns true', async () => {
    process.env.SUPA_SURFACES = 'tasks';
    process.env.SUPA_PRIMARY = 'tasks';
    const adapter = makeAdapter();
    installModule(adapter);
    const wrote = await writeDocPrimaryFirst('tasks/t1/activity', 'a1', {
      type: 'comment',
      createdAt: '2026-10-26T00:00:00.000Z',
    });
    expect(wrote).toBe(true);
    expect(adapter.setDoc).toHaveBeenCalledWith('tasks/t1/activity', 'a1', {
      type: 'comment',
      createdAt: '2026-10-26T00:00:00.000Z',
    });
  });

  it('primary active: an adapter failure throws (request must fail)', async () => {
    process.env.SUPA_SURFACES = 'tasks';
    process.env.SUPA_PRIMARY = 'tasks';
    const adapter = makeAdapter({
      setDoc: jest.fn(async () => {
        throw new Error('supa down');
      }),
    });
    installModule(adapter);
    await expect(
      writeDocPrimaryFirst('tasks/t1/activity', 'a1', { type: 'comment' }),
    ).rejects.toThrow('supa down');
  });

  it('SUPA_PRIMARY unset: no-op returning false, adapter untouched', async () => {
    process.env.SUPA_SURFACES = 'tasks';
    const adapter = makeAdapter();
    installModule(adapter);
    await expect(
      writeDocPrimaryFirst('tasks/t1/activity', 'a1', { type: 'comment' }),
    ).resolves.toBe(false);
    expect(adapter.setDoc).not.toHaveBeenCalled();
  });
});
