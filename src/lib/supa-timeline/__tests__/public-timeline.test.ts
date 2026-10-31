/**
 * @jest-environment node
 *
 * Public-timeline seam contracts (mocked adapter; zero live reads):
 *  - Flag OFF -> every helper reports "unavailable" (null) and the
 *    adapter is never touched; the route answers 503 so clients keep
 *    their Firestore path byte-identically.
 *  - Flag ON -> reads come from the adapter with the exact query
 *    shapes of the current Firestore surfaces: full = published
 *    only, position asc, limit 200; teaser = published only,
 *    position desc, limit 7 (6 + sentinel).
 *  - Timestamps normalize at the seam and serialize to ISO strings
 *    for the wire (toPublicJson).
 *  - Adapter errors fall back (null) instead of throwing.
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

import {
  listTimelineFull,
  listTimelineTeaser,
  publicTimelineSupaEnabled,
  setPublicTimelineAdapterForTests,
  toPublicJson,
  type TimelineSupaAdapter,
} from '../public-timeline';

function fakeAdapter(rows: Array<Record<string, unknown>>, opts?: { throwOnList?: boolean }) {
  const calls: Array<{ options?: unknown }> = [];
  const adapter: TimelineSupaAdapter = {
    getDoc: async () => null,
    listDocs: async (_c: string, options?: unknown) => {
      calls.push({ options });
      if (opts?.throwOnList) throw new Error('adapter boom');
      return rows;
    },
    countDocs: async () => rows.length,
    setDoc: async (_c: string, id: string, data: Record<string, unknown>) => ({ id, ...data }),
    updateDoc: async (_c: string, id: string, data: Record<string, unknown>) => ({ id, ...data }),
    deleteDoc: async () => undefined,
  };
  return { adapter, calls };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.SUPA_SURFACES;
  setPublicTimelineAdapterForTests(undefined);
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('flag gate', () => {
  it('flag OFF: helpers return null and never touch the adapter', async () => {
    const { adapter, calls } = fakeAdapter([{ id: 'a' }]);
    setPublicTimelineAdapterForTests(adapter);
    expect(publicTimelineSupaEnabled()).toBe(false);
    await expect(listTimelineFull()).resolves.toBeNull();
    await expect(listTimelineTeaser()).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('flag ON via env argument evaluates that env', () => {
    expect(publicTimelineSupaEnabled({ SUPA_SURFACES: 'events,timeline' } as never)).toBe(true);
    expect(publicTimelineSupaEnabled({ SUPA_SURFACES: 'events' } as never)).toBe(false);
    expect(publicTimelineSupaEnabled({ SUPA_SURFACES: '*' } as never)).toBe(true);
  });
});

describe('query shapes', () => {
  beforeEach(() => {
    process.env.SUPA_SURFACES = 'timeline';
  });

  it('full: published only, position asc, limit 200', async () => {
    const { adapter, calls } = fakeAdapter([
      { id: 'b', title: 'B', isPublished: true, position: 2 },
      { id: 'a', title: 'A', isPublished: true, position: 1 },
    ]);
    setPublicTimelineAdapterForTests(adapter);
    const rows = await listTimelineFull();
    expect(rows).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].options).toEqual({
      where: [['isPublished', '==', true]],
      orderBy: { field: 'position', direction: 'asc' },
      limit: 200,
    });
  });

  it('teaser: published only, position desc, limit 7', async () => {
    const { adapter, calls } = fakeAdapter([]);
    setPublicTimelineAdapterForTests(adapter);
    await expect(listTimelineTeaser()).resolves.toEqual([]);
    expect(calls[0].options).toEqual({
      where: [['isPublished', '==', true]],
      orderBy: { field: 'position', direction: 'desc' },
      limit: 7,
    });
  });

  it('adapter error falls back to null instead of throwing', async () => {
    const { adapter } = fakeAdapter([], { throwOnList: true });
    setPublicTimelineAdapterForTests(adapter);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(listTimelineFull()).resolves.toBeNull();
    spy.mockRestore();
  });
});

describe('wire serialization', () => {
  it('toPublicJson turns Timestamp-likes into ISO strings', () => {
    const d = new Date('2026-10-05T10:00:00.000Z');
    const out = toPublicJson({
      id: 'x',
      date: { seconds: Math.floor(d.getTime() / 1000), nanoseconds: 0, toDate: () => d, toMillis: () => d.getTime() },
    }) as Record<string, unknown>;
    expect(out.date).toBe('2026-10-05T10:00:00.000Z');
  });
});
