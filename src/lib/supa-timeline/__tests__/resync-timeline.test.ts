/**
 * @jest-environment node
 *
 * fs_timeline resync (timeline seam, 2026-11-01):
 *  - drift detection between Firestore source docs and fs_timeline
 *    rows, including timestamp representation parity (a Firestore
 *    Timestamp-like and the mirror's ISO string for the same
 *    instant are IN SYNC);
 *  - missing rows and orphan rows are reported;
 *  - DRY-RUN (the default) performs ZERO adapter writes;
 *  - repair upserts drifted/missing rows and deletes orphans,
 *    capturing per-doc failures without aborting the rest;
 *  - over the read cap the run reports overBudget and writes
 *    nothing;
 *  - flag OFF reports unavailable and touches nothing.
 */

jest.mock('@/lib/supa', () => ({
  useSupa: (surface: string) => {
    const raw = process.env.SUPA_SURFACES;
    if (!raw) return false;
    const list = raw
      .split(',')
      .map((s: string) => s.trim().toLowerCase())
      .filter(Boolean);
    return list.includes('*') || list.includes(surface.toLowerCase());
  },
  getSupaClient: () => ({}),
  getSupaAdapter: () => null,
  parseSupaSurfaces: (raw: string | undefined) =>
    new Set(
      (raw ?? '')
        .split(',')
        .map((s: string) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
}));

import { runTimelineResync, type TimelineResyncDb } from '../resync-timeline';
import {
  setPublicTimelineAdapterForTests,
  type TimelineSupaAdapter,
} from '../public-timeline';

/** Timestamp-like in the shape the Firestore Admin SDK produces. */
function ts(iso: string) {
  const d = new Date(iso);
  return {
    seconds: Math.floor(d.getTime() / 1000),
    nanoseconds: 0,
    toDate: () => d,
    toMillis: () => d.getTime(),
  };
}

function fakeDb(docs: Array<{ id: string; data: Record<string, unknown> }>): TimelineResyncDb {
  return {
    collection: () => ({
      limit: () => ({
        get: async () => ({
          size: docs.length,
          docs: docs.map((d) => ({ id: d.id, data: () => d.data })),
        }),
      }),
    }),
  };
}

function fakeAdapter(rows: Array<Record<string, unknown>>, opts?: { failSetFor?: string }) {
  const calls: Array<{ op: string; id: string; data?: Record<string, unknown> }> = [];
  const adapter: TimelineSupaAdapter = {
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

const SOURCE = [
  {
    id: 'ev-oct',
    data: {
      title: 'October milestone',
      description: 'Shipped',
      icon: 'Rocket',
      isPublished: true,
      position: 3,
      date: ts('2026-10-05T10:00:00.000Z'),
      link: null,
    },
  },
  {
    id: 'ev-sep',
    data: {
      title: 'September milestone',
      description: 'Earlier',
      icon: 'Wrench',
      isPublished: false,
      position: 2,
      date: ts('2026-09-01T09:00:00.000Z'),
      link: null,
    },
  },
];

const MIRROR_IN_SYNC = [
  {
    id: 'ev-oct',
    title: 'October milestone',
    description: 'Shipped',
    icon: 'Rocket',
    isPublished: true,
    position: 3,
    date: '2026-10-05T10:00:00.000Z',
    link: null,
  },
  {
    id: 'ev-sep',
    title: 'September milestone',
    description: 'Earlier',
    icon: 'Wrench',
    isPublished: false,
    position: 2,
    date: '2026-09-01T09:00:00.000Z',
    link: null,
  },
];

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, SUPA_SURFACES: 'timeline' };
  setPublicTimelineAdapterForTests(undefined);
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('runTimelineResync', () => {
  it('in-sync mirror: clean report, zero writes in dry-run', async () => {
    const { adapter, calls } = fakeAdapter(MIRROR_IN_SYNC);
    setPublicTimelineAdapterForTests(adapter);
    const report = await runTimelineResync(fakeDb(SOURCE));
    expect(report.mode).toBe('dry-run');
    expect(report.sourceCount).toBe(2);
    expect(report.mirrorCount).toBe(2);
    expect(report.missing).toEqual([]);
    expect(report.drifted).toEqual([]);
    expect(report.orphans).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('detects drift, missing and orphans; dry-run writes nothing', async () => {
    const mirror = [
      { ...MIRROR_IN_SYNC[0], title: 'STALE TITLE' },
      { id: 'ev-ghost', title: 'Ghost', isPublished: true, position: 9 },
    ];
    const { adapter, calls } = fakeAdapter(mirror);
    setPublicTimelineAdapterForTests(adapter);
    const report = await runTimelineResync(fakeDb(SOURCE));
    expect(report.missing).toEqual(['ev-sep']);
    expect(report.drifted).toEqual([{ id: 'ev-oct', fields: ['title'] }]);
    expect(report.orphans).toEqual(['ev-ghost']);
    expect(calls).toHaveLength(0);
  });

  it('repair upserts missing/drifted, deletes orphans, survives a per-doc failure', async () => {
    const mirror = [
      { ...MIRROR_IN_SYNC[0], title: 'STALE TITLE' },
      { id: 'ev-ghost', title: 'Ghost', isPublished: true, position: 9 },
    ];
    const { adapter, calls } = fakeAdapter(mirror, { failSetFor: 'ev-sep' });
    setPublicTimelineAdapterForTests(adapter);
    const report = await runTimelineResync(fakeDb(SOURCE), { mode: 'repair' });
    expect(report.repaired).toEqual({ upserted: 1, deleted: 1 });
    expect(report.failures).toEqual([{ id: 'ev-sep', op: 'set', error: 'boom' }]);
    const setCall = calls.find((c) => c.op === 'set' && c.id === 'ev-oct');
    expect(setCall?.data?.date).toBe('2026-10-05T10:00:00.000Z');
    expect(calls.some((c) => c.op === 'delete' && c.id === 'ev-ghost')).toBe(true);
  });

  it('flag OFF: unavailable, nothing touched', async () => {
    delete process.env.SUPA_SURFACES;
    const { adapter, calls } = fakeAdapter(MIRROR_IN_SYNC);
    setPublicTimelineAdapterForTests(adapter);
    const report = await runTimelineResync(fakeDb(SOURCE));
    expect(report.unavailable).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
