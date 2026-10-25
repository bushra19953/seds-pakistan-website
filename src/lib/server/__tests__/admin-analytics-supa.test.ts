/**
 * admin-analytics-supa.test.ts — drives the REAL seam
 * (src/lib/server/admin-analytics-supa.ts getAnalyticsSupa) with a fake
 * adapter, over the fixtures copied from the admin-6 parity harness.
 * Zero live reads; in-memory only.
 *
 * The fake adapter deliberately models the WORSE documented ordering
 * semantics from PARITY_TABLE section 3: its orderBy on a data field is
 * the naive server-side TEXT extraction order (numbers compare as text:
 * '9' > '85' > '50' > '100'), its orderBy drops docs missing the ordered
 * field, and it applies limit after ordering. If the seam trusted the
 * adapter's order for pageVisits, these tests would produce the trap
 * order and fail — the seam must (and does) re-sort numerically itself.
 * Timestamps reach the fake as ISO text (the stored jsonb shape), whose
 * text order is chronological; Timestamp-form values are given the
 * timestamp's ISO text, exactly what text extraction sees after the
 * dump normalizes them.
 */

import {
  getAnalyticsSupa,
  normalizeAnalyticsTimestampMs,
  PAGE_VISITS_CAP,
  type AdminAnalyticsAdapter,
} from '@/lib/server/admin-analytics-supa';
import {
  ANALYTICS_PAGE_VISITS,
  ANALYTICS_PROJECTS,
  ANALYTICS_USERS,
  NOW_MS,
  analyticsEvents,
  toJsonbAll,
  type FDoc,
} from './admin-analytics-fixtures';

type SupaDoc = { id: string } & Record<string, unknown>;

const toSupaDocs = (docs: FDoc[]): SupaDoc[] =>
  docs.map((d) => ({ id: d.id, ...d.data }));

/** Text extraction as PostgREST sees a stored value: numbers -> their
 *  decimal text; timestamp-shaped values -> their ISO text. */
function textOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    const ms = normalizeAnalyticsTimestampMs(value);
    if (ms !== null) return new Date(ms).toISOString();
    return JSON.stringify(value) ?? '';
  }
  return String(value);
}

function makeFakeAdapter(collections: Record<string, SupaDoc[]>): AdminAnalyticsAdapter {
  return {
    async listDocs(collectionPath, options) {
      let rows = [...(collections[collectionPath] ?? [])];
      const orders =
        options?.orderBy === undefined
          ? []
          : (Array.isArray(options.orderBy)
              ? options.orderBy
              : [options.orderBy]
            ).map((o) =>
              typeof o === 'string' ? { field: o, direction: 'asc' as const } : o,
            );
      // orderBy existence rule: docs missing an ordered field drop out.
      for (const order of orders) {
        rows = rows.filter((r) => r[order.field] !== undefined);
      }
      // NAIVE TEXT ordering (the trap semantics), stable.
      for (const order of [...orders].reverse()) {
        const dir = order.direction === 'desc' ? -1 : 1;
        rows = [...rows].sort((a, b) => {
          const ta = textOf(a[order.field]);
          const tb = textOf(b[order.field]);
          return (ta < tb ? -1 : ta > tb ? 1 : 0) * dir;
        });
      }
      if (options?.limit !== undefined) rows = rows.slice(0, options.limit);
      return rows;
    },
    async getDoc(collectionPath, id) {
      return (collections[collectionPath] ?? []).find((r) => r.id === id) ?? null;
    },
    async countDocs(collectionPath) {
      return (collections[collectionPath] ?? []).length;
    },
  };
}

function makeAdapter(overrides: Partial<Record<string, SupaDoc[]>> = {}): AdminAnalyticsAdapter {
  return makeFakeAdapter({
    pageVisits: toSupaDocs(ANALYTICS_PAGE_VISITS),
    users: toSupaDocs(ANALYTICS_USERS),
    projects: toSupaDocs(ANALYTICS_PROJECTS),
    analyticsEvents: toSupaDocs(toJsonbAll(analyticsEvents('timestamp'))),
    ...overrides,
  });
}

const TEXT_TRAP_ORDER = ['_about', '_blog', 'home', '_events']; // '9' > '85' > '50' > '100'
const NUMERIC_ORDER_PATHS = ['/events', '/blog', 'home', '/about'];

describe('getAnalyticsSupa (admin-analytics seam)', () => {
  it('fake sanity: raw adapter orderBy on visits IS the text trap order', async () => {
    const adapter = makeAdapter();
    const raw = await adapter.listDocs('pageVisits', {
      orderBy: { field: 'visits', direction: 'desc' },
      limit: PAGE_VISITS_CAP,
    });
    expect(raw.map((r) => r.id)).toEqual([
      'site_total_visits',
      ...TEXT_TRAP_ORDER,
    ]);
  });

  it('(a) pageVisits come back in NUMERIC desc order through the full seam, never the text-trap order', async () => {
    const vm = await getAnalyticsSupa(makeAdapter(), { nowMs: NOW_MS });
    expect(vm.pageVisits.map((v) => v.path)).toEqual(NUMERIC_ORDER_PATHS);
    expect(vm.pageVisits.map((v) => v.visits)).toEqual([100, 85, 50, 9]);
    expect(vm.pageVisits.map((v) => v.path)).not.toEqual(
      TEXT_TRAP_ORDER.map((id) => id.replace(/_/g, '/')),
    );
  });

  it('total visits = site_total_visits (9999), counter doc excluded from the list', async () => {
    const vm = await getAnalyticsSupa(makeAdapter(), { nowMs: NOW_MS });
    expect(vm.totalVisits).toBe(9999);
    expect(vm.pageVisits.some((v) => v.visits === 9999)).toBe(false);
    expect(vm.pageVisits).toHaveLength(4);
  });

  it('total visits = 0 when the counter doc is missing', async () => {
    const adapter = makeAdapter({
      pageVisits: toSupaDocs(
        ANALYTICS_PAGE_VISITS.filter((d) => d.id !== 'site_total_visits'),
      ),
    });
    const vm = await getAnalyticsSupa(adapter, { nowMs: NOW_MS });
    expect(vm.totalVisits).toBe(0);
    expect(vm.pageVisits.map((v) => v.path)).toEqual(NUMERIC_ORDER_PATHS);
  });

  it('path derivation (id _ -> /) and top5: home filtered out, 3 rows', async () => {
    const vm = await getAnalyticsSupa(makeAdapter(), { nowMs: NOW_MS });
    expect(vm.pageVisits).toEqual([
      { path: '/events', visits: 100, lastVisit: null },
      { path: '/blog', visits: 85, lastVisit: null },
      { path: 'home', visits: 50, lastVisit: null },
      { path: '/about', visits: 9, lastVisit: null },
    ]);
    expect(vm.top5Pages).toHaveLength(3);
    expect(vm.top5Pages.map((v) => v.path)).toEqual(['/events', '/blog', '/about']);
  });

  it('counts: totalUsers 6 / projectsCount 3 via countDocs', async () => {
    const vm = await getAnalyticsSupa(makeAdapter(), { nowMs: NOW_MS });
    expect(vm.totalUsers).toBe(6);
    expect(vm.projectsCount).toBe(3);
  });

  it('cap-200 derivations over the latest 200 events', async () => {
    const vm = await getAnalyticsSupa(makeAdapter(), { nowMs: NOW_MS });
    expect(vm.recentEvents).toHaveLength(200);
    // The 10 'Join' clicks beyond the cap are excluded: 75, not 85.
    expect(vm.recentClicks).toBe(75);
    // Ties at 30 keep first-seen order: Join before Donate.
    expect(vm.topClicked).toEqual([
      { label: 'Join', count: 30 },
      { label: 'Donate', count: 30 },
      { label: 'cta-1', count: 10 },
      { label: 'unknown', count: 5 },
    ]);
    expect(vm.avgTimeOnPageMs).toBe(2500); // (1000+2000+3000+4000 durationMs fallback)/4
    expect(vm.avgScrollDepth).toBe(50); // (40+60)/2
    const today = new Date(NOW_MS).toISOString().slice(0, 10);
    expect(vm.clicksByDay).toHaveLength(7);
    expect(vm.clicksByDay.find((b) => b.date === today)?.count).toBe(75);
    expect(vm.clicksByDay.filter((b) => b.date !== today).every((b) => b.count === 0)).toBe(true);
  });

  it('(b) ISO-form inputs produce IDENTICAL derivations to Timestamp-form inputs (the hazard test)', async () => {
    const tsVm = await getAnalyticsSupa(makeAdapter(), { nowMs: NOW_MS });
    const isoVm = await getAnalyticsSupa(
      makeAdapter({
        analyticsEvents: toSupaDocs(analyticsEvents('iso')),
      }),
      { nowMs: NOW_MS },
    );
    expect(isoVm).toEqual(tsVm);
    // And the trend specifically is NOT zeroed for ISO strings (the
    // oracle page's toDate guard would bucket nothing here).
    const today = new Date(NOW_MS).toISOString().slice(0, 10);
    expect(isoVm.clicksByDay.find((b) => b.date === today)?.count).toBe(75);
    expect(isoVm.clicksByDay.some((b) => b.count > 0)).toBe(true);
  });

  it('normalizeAnalyticsTimestampMs handles ISO, Timestamp-like, dumped shapes; never needs toDate on a string', () => {
    const ms = Date.parse('2026-10-25T12:00:00.000Z');
    expect(normalizeAnalyticsTimestampMs('2026-10-25T12:00:00.000Z')).toBe(ms);
    expect(normalizeAnalyticsTimestampMs({ toMillis: () => ms })).toBe(ms);
    expect(normalizeAnalyticsTimestampMs({ toDate: () => new Date(ms) })).toBe(ms);
    expect(
      normalizeAnalyticsTimestampMs({
        _seconds: Math.floor(ms / 1000),
        _nanoseconds: 0,
      }),
    ).toBe(ms);
    expect(normalizeAnalyticsTimestampMs(null)).toBeNull();
    expect(normalizeAnalyticsTimestampMs('not a date')).toBeNull();
  });
});
