/**
 * @jest-environment node
 *
 * GC: mirror writers in src/lib/server/admin-analytics-supa.ts,
 * driven through the real seam functions with a fake adapter
 * injected via setAdminAnalyticsSupaAdapterForTests. In-memory
 * only; zero production reads.
 */
import {
  analyticsMirrorTimestampIso,
  mirrorAnalyticsEvent,
  mirrorPageVisitIncrement,
  setAdminAnalyticsSupaAdapterForTests,
  type AdminAnalyticsAdapter,
} from '@/lib/server/admin-analytics-supa';

type Row = { id: string } & Record<string, unknown>;

interface SetDocCall {
  collectionPath: string;
  id: string;
  data: Record<string, unknown>;
  options?: { merge?: boolean };
}

type FakeAdapter = AdminAnalyticsAdapter & {
  setDocCalls: SetDocCall[];
  row: (collectionPath: string, id: string) => Row | undefined;
};

function makeFakeAdapter(
  seed: Record<string, Row[]> = {},
): FakeAdapter {
  const store = new Map<string, Map<string, Row>>();
  const bucket = (collectionPath: string): Map<string, Row> => {
    let rows = store.get(collectionPath);
    if (!rows) {
      rows = new Map<string, Row>();
      store.set(collectionPath, rows);
    }
    return rows;
  };
  for (const [collectionPath, rows] of Object.entries(seed)) {
    for (const row of rows) bucket(collectionPath).set(row.id, { ...row });
  }
  const setDocCalls: SetDocCall[] = [];
  return {
    setDocCalls,
    row: (collectionPath, id) => bucket(collectionPath).get(id),
    async listDocs() {
      return [];
    },
    async getDoc(collectionPath, id) {
      const found = bucket(collectionPath).get(id);
      return found ? { ...found } : null;
    },
    async countDocs() {
      return 0;
    },
    async setDoc(collectionPath, id, data, options) {
      setDocCalls.push({ collectionPath, id, data, options });
      const existing = bucket(collectionPath).get(id);
      const next: Row = (
        options?.merge && existing
          ? { ...existing, ...data }
          : { ...data, id }
      ) as Row;
      bucket(collectionPath).set(id, next);
    },
  };
}

const originalSurfaces = process.env.SUPA_SURFACES;

beforeEach(() => {
  process.env.SUPA_SURFACES = 'admin-analytics';
});

afterEach(() => {
  setAdminAnalyticsSupaAdapterForTests(null);
  if (originalSurfaces === undefined) {
    delete process.env.SUPA_SURFACES;
  } else {
    process.env.SUPA_SURFACES = originalSurfaces;
  }
  jest.restoreAllMocks();
});

describe('admin-analytics mirror writers', () => {
  it('mirrorAnalyticsEvent writes one fs_analyticsEvents row via setDoc(analyticsEvents, id, payload) when the surface is on', async () => {
    const adapter = makeFakeAdapter();
    setAdminAnalyticsSupaAdapterForTests(adapter);
    const ok = await mirrorAnalyticsEvent('e1', {
      type: 'product_view',
      path: '/store/p1',
      userId: 'user-1',
      productId: 'p1',
      timestamp: '2026-10-31T00:00:00.000Z',
    });
    expect(ok).toBe(true);
    expect(adapter.setDocCalls).toHaveLength(1);
    expect(adapter.setDocCalls[0].collectionPath).toBe('analyticsEvents');
    expect(adapter.setDocCalls[0].id).toBe('e1');
    expect(adapter.setDocCalls[0].data).toEqual({
      type: 'product_view',
      path: '/store/p1',
      userId: 'user-1',
      productId: 'p1',
      timestamp: '2026-10-31T00:00:00.000Z',
    });
  });

  it('mirrorAnalyticsEvent returns false and writes nothing when admin-analytics is not in SUPA_SURFACES', async () => {
    delete process.env.SUPA_SURFACES;
    const adapter = makeFakeAdapter();
    setAdminAnalyticsSupaAdapterForTests(adapter);
    const ok = await mirrorAnalyticsEvent('e1', {
      type: 'product_view',
      path: '/store/p1',
      userId: 'user-1',
      productId: 'p1',
      timestamp: '2026-10-31T00:00:00.000Z',
    });
    expect(ok).toBe(false);
    expect(adapter.setDocCalls).toHaveLength(0);
  });

  it('mirrorAnalyticsEvent returns false and writes nothing when the injected adapter is null', async () => {
    setAdminAnalyticsSupaAdapterForTests(null);
    const ok = await mirrorAnalyticsEvent('e1', {
      type: 'product_view',
      path: '/store/p1',
      userId: 'user-1',
      productId: 'p1',
      timestamp: '2026-10-31T00:00:00.000Z',
    });
    expect(ok).toBe(false);
  });

  it('mirrorAnalyticsEvent returns false and writes nothing when the adapter has no setDoc', async () => {
    const readOnly: AdminAnalyticsAdapter = {
      async listDocs() {
        return [];
      },
      async getDoc() {
        return null;
      },
      async countDocs() {
        return 0;
      },
    };
    setAdminAnalyticsSupaAdapterForTests(readOnly);
    const ok = await mirrorAnalyticsEvent('e1', {
      type: 'product_view',
      path: '/store/p1',
      userId: 'user-1',
      productId: 'p1',
      timestamp: '2026-10-31T00:00:00.000Z',
    });
    expect(ok).toBe(false);
  });

  it('mirrorAnalyticsEvent never throws when setDoc rejects; it returns false', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const adapter = makeFakeAdapter();
    adapter.setDoc = async () => {
      throw new Error('supa down');
    };
    setAdminAnalyticsSupaAdapterForTests(adapter);
    await expect(
      mirrorAnalyticsEvent('e1', {
        type: 'click',
        path: '/x',
        userId: 'user-1',
        timestamp: '2026-10-31T00:00:00.000Z',
      }),
    ).resolves.toBe(false);
  });

  it('analyticsMirrorTimestampIso converts an ISO string, a Date and a Timestamp-like value to the same ISO instant, and falls back to now for a serverTimestamp-shaped sentinel', () => {
    const iso = '2026-10-25T12:00:00.000Z';
    const ms = Date.parse(iso);
    expect(analyticsMirrorTimestampIso(iso)).toBe(iso);
    expect(analyticsMirrorTimestampIso(new Date(ms))).toBe(iso);
    expect(analyticsMirrorTimestampIso({ toMillis: () => ms })).toBe(iso);
    const fallbackNow = new Date('2026-10-31T01:02:03.000Z');
    expect(analyticsMirrorTimestampIso({}, fallbackNow)).toBe(
      '2026-10-31T01:02:03.000Z',
    );
    expect(
      analyticsMirrorTimestampIso(
        { _methodName: 'serverTimestamp' },
        fallbackNow,
      ),
    ).toBe('2026-10-31T01:02:03.000Z');
  });

  it('mirrorPageVisitIncrement creates a missing counter at visits 1 with path and an ISO lastVisit', async () => {
    const adapter = makeFakeAdapter();
    setAdminAnalyticsSupaAdapterForTests(adapter);
    const ok = await mirrorPageVisitIncrement('_store', '/store');
    expect(ok).toBe(true);
    expect(adapter.setDocCalls).toHaveLength(1);
    const call = adapter.setDocCalls[0];
    expect(call.collectionPath).toBe('pageVisits');
    expect(call.id).toBe('_store');
    expect(call.options).toEqual({ merge: true });
    expect(call.data.path).toBe('/store');
    expect(call.data.visits).toBe(1);
    expect(call.data.lastVisit).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('mirrorPageVisitIncrement increments an existing counter from 41 to 42', async () => {
    const adapter = makeFakeAdapter({
      pageVisits: [
        {
          id: '_store',
          path: '/store',
          visits: 41,
          lastVisit: '2026-10-30T00:00:00.000Z',
        },
      ],
    });
    setAdminAnalyticsSupaAdapterForTests(adapter);
    const ok = await mirrorPageVisitIncrement('_store', '/store');
    expect(ok).toBe(true);
    expect(adapter.setDocCalls[0].data.visits).toBe(42);
    expect(adapter.row('pageVisits', '_store')?.visits).toBe(42);
  });

  it('mirrorPageVisitIncrement writes the total doc with no path key', async () => {
    const adapter = makeFakeAdapter();
    setAdminAnalyticsSupaAdapterForTests(adapter);
    const ok = await mirrorPageVisitIncrement('site_total_visits', null);
    expect(ok).toBe(true);
    const call = adapter.setDocCalls[0];
    expect(call.id).toBe('site_total_visits');
    expect(call.data).not.toHaveProperty('path');
    expect(call.data.visits).toBe(1);
    expect(call.data.lastVisit).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('mirrorPageVisitIncrement merges and preserves unrelated stored keys on the snapshot row', async () => {
    const adapter = makeFakeAdapter({
      pageVisits: [
        { id: '_store', path: '/store', visits: 5, note: 'keep-me' },
      ],
    });
    setAdminAnalyticsSupaAdapterForTests(adapter);
    const ok = await mirrorPageVisitIncrement('_store', '/store');
    expect(ok).toBe(true);
    const stored = adapter.row('pageVisits', '_store');
    expect(stored?.visits).toBe(6);
    expect(stored?.note).toBe('keep-me');
  });

  it('mirrorPageVisitIncrement returns false and writes nothing when the surface is off', async () => {
    delete process.env.SUPA_SURFACES;
    const adapter = makeFakeAdapter();
    setAdminAnalyticsSupaAdapterForTests(adapter);
    const ok = await mirrorPageVisitIncrement('_store', '/store');
    expect(ok).toBe(false);
    expect(adapter.setDocCalls).toHaveLength(0);
  });
});
