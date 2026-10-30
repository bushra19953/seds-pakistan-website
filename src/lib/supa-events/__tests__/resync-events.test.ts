/**
 * @jest-environment node
 *
 * fs_events resync (events mirror-staleness fix, 2026-10-28):
 *  - drift detection between Firestore source docs and fs_events
 *    rows, including the exact EV2 soft-delete shape (mirror stuck
 *    at the pre-delete dump state: status 'published', deleted
 *    false; source: status 'archived', deleted true, deletedAt set);
 *  - timestamp representation parity: a Firestore Timestamp-like
 *    and the mirror's ISO string for the same instant are IN SYNC;
 *  - missing rows and orphan rows are reported;
 *  - DRY-RUN (the default) performs ZERO adapter writes;
 *  - repair mode upserts drifted/missing rows from the source doc
 *    and deletes orphans, capturing per-doc failures without
 *    aborting the rest.
 */

import {
  diffEventDocs,
  resyncEventsMirror,
  runEventsResync,
  EVENTS_RESYNC_READ_BUDGET_CAP,
  type EventSourceDoc,
} from '../resync-events';
import {
  setEventsSupaAdapterForTests,
  type EventsSupaAdapter,
} from '../server-events';

/** Timestamp-like in the shape the Firestore Admin SDK / seam produce. */
function ts(iso: string) {
  const d = new Date(iso);
  return {
    seconds: Math.floor(d.getTime() / 1000),
    nanoseconds: 0,
    toDate: () => d,
    toMillis: () => d.getTime(),
  };
}

function fakeAdapter(rows: Array<Record<string, unknown>>, opts?: { failSetFor?: string }) {
  const calls: Array<{ op: string; id: string; data?: any }> = [];
  const adapter: EventsSupaAdapter = {
    getDoc: async () => null,
    listDocs: async () => rows,
    countDocs: async () => rows.length,
    setDoc: async (_c: string, id: string, data: Record<string, unknown>) => {
      calls.push({ op: 'set', id, data });
      if (opts?.failSetFor === id) throw new Error('boom');
      return { id, ...data };
    },
    updateDoc: async (_c: string, id: string, data: Record<string, unknown>) => {
      calls.push({ op: 'update', id, data });
      return { id, ...data };
    },
    deleteDoc: async (_c: string, id: string) => {
      calls.push({ op: 'delete', id });
    },
  };
  return { adapter, calls };
}

const EV2_SOURCE: EventSourceDoc = {
  id: 'ev2-free-test-2026-10-25',
  data: {
    title: 'EV2 FREE TEST 2026-10-25',
    status: 'archived',
    deleted: true,
    showInTicker: false,
    deletedAt: ts('2026-10-26T11:58:46.461Z'),
    createdAt: ts('2026-10-25T03:16:51.266Z'),
  },
};

const EV2_MIRROR_ROW = {
  id: 'ev2-free-test-2026-10-25',
  title: 'EV2 FREE TEST 2026-10-25',
  status: 'published',
  deleted: false,
  showInTicker: false,
  createdAt: '2026-10-25T03:16:51.266Z',
};

describe('diffEventDocs', () => {
  it('reports changed, added and removed top-level fields', () => {
    const diffs = diffEventDocs(
      { a: 1, b: 'new', c: true },
      { a: 1, b: 'old', d: 'gone' },
    );
    expect(diffs).toEqual([
      { field: 'b', from: 'old', to: 'new' },
      { field: 'c', from: undefined, to: true },
      { field: 'd', from: 'gone', to: undefined },
    ]);
  });

  it('treats key order inside nested objects as irrelevant', () => {
    expect(diffEventDocs({ p: { x: 1, y: 2 } }, { p: { y: 2, x: 1 } })).toEqual([]);
  });
});

describe('resyncEventsMirror', () => {
  it('flags the EV2 soft-delete drift with field-level diffs', async () => {
    const { adapter } = fakeAdapter([EV2_MIRROR_ROW]);
    const report = await resyncEventsMirror({
      source: [EV2_SOURCE],
      adapter,
      mode: 'dry-run',
    });
    expect(report.inSync).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.drifted).toHaveLength(1);
    const diffs = report.drifted[0].diffs;
    expect(diffs).toContainEqual({ field: 'deleted', from: false, to: true });
    expect(diffs).toContainEqual({ field: 'status', from: 'published', to: 'archived' });
    expect(diffs).toContainEqual({
      field: 'deletedAt',
      from: undefined,
      to: '2026-10-26T11:58:46.461Z',
    });
    // createdAt differs only in representation (Timestamp-like vs
    // ISO string for the same instant): NOT drift.
    expect(diffs.find((d) => d.field === 'createdAt')).toBeUndefined();
  });

  it('reports in-sync, missing and orphan rows', async () => {
    const { adapter } = fakeAdapter([
      { id: 'same-1', title: 'T', status: 'published', deleted: false },
      { id: 'ghost-1', title: 'G', status: 'published', deleted: false },
    ]);
    const report = await resyncEventsMirror({
      source: [
        { id: 'same-1', data: { title: 'T', status: 'published', deleted: false } },
        { id: 'new-1', data: { title: 'N', status: 'draft', deleted: false } },
      ],
      adapter,
      mode: 'dry-run',
    });
    expect(report.inSync).toEqual(['same-1']);
    expect(report.missing).toEqual(['new-1']);
    expect(report.orphans).toEqual(['ghost-1']);
    expect(report.totalSource).toBe(2);
    expect(report.totalMirror).toBe(2);
  });

  it('dry-run performs zero writes', async () => {
    const { adapter, calls } = fakeAdapter([
      EV2_MIRROR_ROW,
      { id: 'ghost-1', title: 'G' },
    ]);
    const report = await resyncEventsMirror({
      source: [EV2_SOURCE, { id: 'new-1', data: { title: 'N' } }],
      adapter,
      mode: 'dry-run',
    });
    expect(report.drifted).toHaveLength(1);
    expect(report.missing).toEqual(['new-1']);
    expect(report.orphans).toEqual(['ghost-1']);
    expect(report.applied).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('repair upserts drifted + missing from source and deletes orphans', async () => {
    const { adapter, calls } = fakeAdapter([
      EV2_MIRROR_ROW,
      { id: 'ghost-1', title: 'G' },
    ]);
    const report = await resyncEventsMirror({
      source: [EV2_SOURCE, { id: 'new-1', data: { title: 'N', status: 'draft' } }],
      adapter,
      mode: 'repair',
    });
    const setIds = calls.filter((c) => c.op === 'set').map((c) => c.id).sort();
    expect(setIds).toEqual(['ev2-free-test-2026-10-25', 'new-1']);
    const ev2Set = calls.find((c) => c.op === 'set' && c.id === EV2_SOURCE.id);
    expect(ev2Set?.data.deleted).toBe(true);
    expect(ev2Set?.data.status).toBe('archived');
    expect(ev2Set?.data.deletedAt).toBe('2026-10-26T11:58:46.461Z');
    expect(calls.filter((c) => c.op === 'delete')).toEqual([{ op: 'delete', id: 'ghost-1' }]);
    expect(report.applied).toEqual([
      { id: 'new-1', action: 'upsert', ok: true },
      { id: 'ev2-free-test-2026-10-25', action: 'upsert', ok: true },
      { id: 'ghost-1', action: 'delete-orphan', ok: true },
    ]);
  });

  it('repair captures a per-doc failure and continues with the rest', async () => {
    const { adapter } = fakeAdapter([EV2_MIRROR_ROW], { failSetFor: EV2_SOURCE.id });
    const report = await resyncEventsMirror({
      source: [EV2_SOURCE, { id: 'new-1', data: { title: 'N' } }],
      adapter,
      mode: 'repair',
    });
    const failed = report.applied.find((a) => a.id === EV2_SOURCE.id);
    expect(failed).toMatchObject({ action: 'upsert', ok: false, error: 'boom' });
    expect(report.applied.find((a) => a.id === 'new-1')).toMatchObject({ ok: true });
  });
});

/**
 * Cron shelter (census 20 row 7): the production runner's read-budget
 * tripwire, ported from the applications guard. The fake db honours
 * limit(n) exactly like Firestore: it returns at most n docs and
 * reports size accordingly.
 */
describe('runEventsResync read-budget tripwire', () => {
  const savedSurfaces = process.env.SUPA_SURFACES;

  function makeDb(docs: Array<{ id: string; data: Record<string, unknown> }>) {
    const limitCalls: number[] = [];
    return {
      limitCalls,
      db: {
        collection: (_name: string) => ({
          limit: (n: number) => {
            limitCalls.push(n);
            return {
              get: async () => {
                const sliced = docs.slice(0, n);
                return {
                  size: sliced.length,
                  docs: sliced.map((d) => ({ id: d.id, data: () => d.data })),
                };
              },
            };
          },
        }),
      },
    };
  }

  beforeEach(() => {
    process.env.SUPA_SURFACES = 'events';
  });

  afterEach(() => {
    setEventsSupaAdapterForTests(undefined);
    if (savedSurfaces === undefined) delete process.env.SUPA_SURFACES;
    else process.env.SUPA_SURFACES = savedSurfaces;
  });

  it('asks for cap + 1 and, under the cap, resyncs normally with readsUsed reported', async () => {
    const { adapter, calls } = fakeAdapter([
      { id: 'same-1', title: 'T', status: 'published', deleted: false },
    ]);
    setEventsSupaAdapterForTests(adapter);
    const { db, limitCalls } = makeDb([
      { id: 'same-1', data: { title: 'T', status: 'published', deleted: false } },
      { id: 'new-1', data: { title: 'N', status: 'draft', deleted: false } },
    ]);
    const report = await runEventsResync(db, 'repair');
    expect(limitCalls).toEqual([EVENTS_RESYNC_READ_BUDGET_CAP + 1]);
    expect(report).not.toBeNull();
    expect(report!.overBudget).toBe(false);
    expect(report!.readsUsed).toBe(2);
    expect(report!.missing).toEqual(['new-1']);
    expect(calls.filter((c) => c.op === 'set').map((c) => c.id)).toEqual(['new-1']);
  });

  it('301 docs trip the cap: overBudget report, mirror never listed, zero writes even in repair mode', async () => {
    const docs = Array.from({ length: EVENTS_RESYNC_READ_BUDGET_CAP + 1 }, (_, i) => ({
      id: `ev-${i + 1}`,
      data: { title: `E${i + 1}` },
    }));
    let listCalls = 0;
    const { adapter, calls } = fakeAdapter([]);
    const countingAdapter: EventsSupaAdapter = {
      ...adapter,
      listDocs: async (...args: Parameters<EventsSupaAdapter['listDocs']>) => {
        listCalls += 1;
        return adapter.listDocs(...args);
      },
    };
    setEventsSupaAdapterForTests(countingAdapter);
    const { db, limitCalls } = makeDb(docs);
    const report = await runEventsResync(db, 'repair');
    expect(limitCalls).toEqual([EVENTS_RESYNC_READ_BUDGET_CAP + 1]);
    expect(report).not.toBeNull();
    expect(report!.overBudget).toBe(true);
    expect(report!.readsUsed).toBe(EVENTS_RESYNC_READ_BUDGET_CAP + 1);
    expect(report!.applied).toEqual([]);
    expect(report!.missing).toEqual([]);
    expect(report!.drifted).toEqual([]);
    expect(listCalls).toBe(0);
    expect(calls).toEqual([]);
  });

  it('exactly at the cap (300) does NOT trip', async () => {
    const docs = Array.from({ length: EVENTS_RESYNC_READ_BUDGET_CAP }, (_, i) => ({
      id: `ev-${i + 1}`,
      data: { title: `E${i + 1}` },
    }));
    const { adapter } = fakeAdapter([]);
    setEventsSupaAdapterForTests(adapter);
    const { db } = makeDb(docs);
    const report = await runEventsResync(db, 'dry-run');
    expect(report!.overBudget).toBe(false);
    expect(report!.readsUsed).toBe(EVENTS_RESYNC_READ_BUDGET_CAP);
    expect(report!.missing).toHaveLength(EVENTS_RESYNC_READ_BUDGET_CAP);
  });

  it('adapter unavailable -> null (route answers 503), and no Firestore scan happens', async () => {
    setEventsSupaAdapterForTests(null);
    const { db, limitCalls } = makeDb([{ id: 'x', data: {} }]);
    const report = await runEventsResync(db, 'dry-run');
    expect(report).toBeNull();
    expect(limitCalls).toEqual([]);
  });
});
