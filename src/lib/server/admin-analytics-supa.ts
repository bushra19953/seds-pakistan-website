/**
 * admin-analytics-supa — the seam between the admin analytics surface
 * (src/app/admin/analytics/page.tsx, oracle) and the Supabase adapter.
 *
 * Sibling lazy-require pattern (see notifications-supa-seam.ts): the
 * adapter lives at src/lib/supa/ on the merged tree, NOT on this branch,
 * so adapter resolution is a lazy require inside a try/catch. A missing
 * module or an unconfigured client resolves to "no adapter" and the
 * caller serves nothing from Supa (the NEW route 404s; there is no
 * pre-existing server route to fall back to).
 *
 * TRAP ADJUDICATIONS (PARITY_TABLE section 3, both DIVERGENCE rows):
 *
 * (a) NUMERIC-ORDERING TRAP — pageVisits. A naive server-side text
 *     extraction order sorts visits as TEXT ('9' > '85' > '50' > '100'),
 *     which is not the Firestore numeric desc order. This seam NEVER
 *     trusts an incoming order for pageVisits: after the fetch it
 *     re-sorts by Number(visits) descending in JS. The Firestore query
 *     is also UNBOUNDED in the oracle page; this port bounds it
 *     explicitly (PAGE_VISITS_CAP below).
 *
 * (b) ISO-TREND HAZARD — analyticsEvents. The oracle page's trend
 *     derivation guards on `e.timestamp?.toDate`, which silently zeroes
 *     the 7-day trend for ISO-string timestamps — and jsonb rows carry
 *     ISO strings. This seam NEVER ports that guard: every event
 *     timestamp is normalized to millis first (normalizeAnalytics-
 *     TimestampMs: Timestamp-like / dumped shape via toMillis/toDate,
 *     ISO strings via Date.parse, numbers as-is) and ALL derivations run
 *     over the normalized values, so Timestamp-form and ISO-form inputs
 *     produce identical output.
 */

/* ------------------------------------------------------------------ types */

export interface AdminAnalyticsAdapter {
  listDocs(
    collectionPath: string,
    options?: {
      where?: Array<[string, string, unknown]>;
      orderBy?:
        | string
        | { field: string; direction?: 'asc' | 'desc' }
        | Array<{ field: string; direction?: 'asc' | 'desc' }>;
      limit?: number;
      startAfter?: string | number;
    },
  ): Promise<Array<{ id: string } & Record<string, unknown>>>;
  getDoc(
    collectionPath: string,
    id: string,
  ): Promise<({ id: string } & Record<string, unknown>) | null>;
  countDocs(
    collectionPath: string,
    where?: Array<[string, string, unknown]>,
  ): Promise<number>;
  setDoc?(
    collectionPath: string,
    id: string,
    data: Record<string, unknown>,
    options?: { merge?: boolean },
  ): Promise<unknown>;
}

export interface AnalyticsPageVisit {
  path: string;
  visits: number;
  lastVisit: unknown;
}

export interface AnalyticsEventView {
  type: string;
  label: string | null;
  path: string | null;
  targetId: string | null;
  /** ISO string (normalized from whatever shape was stored), or null. */
  timestamp: string | null;
  /** Normalized timestamp millis, or null when absent/unparseable. */
  timestampMs: number | null;
  timeOnPageMs: number | null;
  scrollDepth: number | null;
}

export interface AdminAnalyticsViewModel {
  pageVisits: AnalyticsPageVisit[];
  /** pageVisits with path 'home' removed, first 5 (oracle top5Pages). */
  top5Pages: AnalyticsPageVisit[];
  totalVisits: number;
  totalUsers: number;
  projectsCount: number;
  recentEvents: AnalyticsEventView[];
  topClicked: Array<{ label: string; count: number }>;
  clicksByDay: Array<{ date: string; count: number }>;
  avgTimeOnPageMs: number;
  avgScrollDepth: number;
  /** Count of click events inside the latest-200 window (harness name). */
  recentClicks: number;
}

/* ------------------------------------------------------------------ bounds */

/**
 * Explicit bound for the pageVisits read. The oracle Firestore query is
 * unbounded; pageVisits docs are path-keyed (one doc per site path, plus
 * the site_total_visits counter), so the collection is inherently small
 * — a generous cap of 1000 covers any plausible path count while making
 * the read bounded by construction instead of by assumption.
 */
export const PAGE_VISITS_CAP = 1000;

/** The oracle page reads analyticsEvents with limit(200). */
export const ANALYTICS_EVENTS_CAP = 200;

export const SITE_TOTAL_VISITS_ID = 'site_total_visits';

/* ------------------------------------------------------- timestamp handling */

/**
 * Normalize any timestamp shape this database holds to millis:
 * - ISO strings (the jsonb shape) via Date.parse
 * - numbers pass through
 * - Timestamp-like objects via toMillis() / toDate()
 * - dumped shapes {_seconds,_nanoseconds} / {seconds,nanoseconds}
 * Returns null for anything else (missing, unparseable). This is the
 * function the ISO-trend hazard turns on: ISO strings MUST yield millis
 * here, never be skipped for lacking a toDate method.
 */
export function normalizeAnalyticsTimestampMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.toMillis === 'function') {
      try {
        const ms = (v.toMillis as () => number).call(value);
        return Number.isFinite(ms) ? ms : null;
      } catch {
        return null;
      }
    }
    if (typeof v.toDate === 'function') {
      try {
        const ms = (v.toDate as () => Date).call(value).getTime();
        return Number.isFinite(ms) ? ms : null;
      } catch {
        return null;
      }
    }
    const seconds =
      typeof v._seconds === 'number'
        ? v._seconds
        : typeof v.seconds === 'number'
          ? v.seconds
          : null;
    const nanos =
      typeof v._nanoseconds === 'number'
        ? v._nanoseconds
        : typeof v.nanoseconds === 'number'
          ? v.nanoseconds
          : 0;
    if (seconds !== null) return seconds * 1000 + nanos / 1_000_000;
  }
  return null;
}

/* ---------------------------------------------------------------- flag gate */

/**
 * useSupa('admin-analytics') equivalent for the SERVER flag
 * (SUPA_SURFACES). Mirrors src/lib/supa/flags.ts semantics exactly
 * (comma list, case-insensitive, '*' enables everything, unset = OFF)
 * so this branch does not import a module that does not exist here yet.
 */
export function adminAnalyticsSupaEnabled(): boolean {
  const raw = process.env.SUPA_SURFACES;
  if (!raw) return false;
  const surfaces = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (surfaces.length === 0) return false;
  if (surfaces.includes('*')) return true;
  return surfaces.includes('admin-analytics');
}

/* -------------------------------------------------------- adapter plumbing */

let injectedAdapter: AdminAnalyticsAdapter | null | undefined;

/** Test-only injection point (fake adapter; no live Supabase in tests). */
export function setAdminAnalyticsSupaAdapterForTests(
  adapter: AdminAnalyticsAdapter | null,
): void {
  injectedAdapter = adapter;
}

function resolveRealAdapter(): AdminAnalyticsAdapter | null {
  try {
    // Lazy require so this branch compiles and runs before the adapter
    // branch lands. ONE-EDIT RE-POINT: these two module paths.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const adapterModule = require('@/lib/supa/adapter');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const clientModule = require('@/lib/supa/client');
    if (typeof clientModule?.getSupaClient !== 'function') return null;
    if (!clientModule.getSupaClient()) return null; // unconfigured
    if (typeof adapterModule?.getSupaAdapter !== 'function') return null;
    return adapterModule.getSupaAdapter() as AdminAnalyticsAdapter;
  } catch {
    return null;
  }
}

/** The adapter when the surface is ON and Supabase is configured, else null. */
export function getAdminAnalyticsSupaAdapter(): AdminAnalyticsAdapter | null {
  if (!adminAnalyticsSupaEnabled()) return null;
  if (injectedAdapter !== undefined) return injectedAdapter;
  return resolveRealAdapter();
}

/* ------------------------------------------------------------ mirror writes */

export function analyticsMirrorTimestampIso(
  value: unknown,
  now: Date = new Date(),
): string {
  const ms = normalizeAnalyticsTimestampMs(value);
  return ms === null ? now.toISOString() : new Date(ms).toISOString();
}

export async function mirrorAnalyticsEvent(
  id: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const adapter = getAdminAnalyticsSupaAdapter();
  if (!adapter || typeof adapter.setDoc !== 'function') return false;
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) payload[key] = value;
  }
  payload.timestamp = analyticsMirrorTimestampIso(data.timestamp);
  try {
    await adapter.setDoc('analyticsEvents', id, payload);
    return true;
  } catch (err) {
    console.error('[admin-analytics-supa] mirror analyticsEvent failed', err);
    return false;
  }
}

export async function mirrorPageVisitIncrement(
  pageId: string,
  path: string | null,
): Promise<boolean> {
  const adapter = getAdminAnalyticsSupaAdapter();
  if (
    !adapter ||
    typeof adapter.setDoc !== 'function' ||
    typeof adapter.getDoc !== 'function'
  ) {
    return false;
  }
  try {
    const existing = await adapter.getDoc('pageVisits', pageId);
    const visits = numericVisits(existing?.visits) + 1;
    const payload: Record<string, unknown> =
      path === null
        ? { visits, lastVisit: new Date().toISOString() }
        : { path, visits, lastVisit: new Date().toISOString() };
    await adapter.setDoc('pageVisits', pageId, payload, { merge: true });
    return true;
  } catch (err) {
    console.error('[admin-analytics-supa] mirror pageVisit failed', err);
    return false;
  }
}

/* --------------------------------------------------------------- view model */

function numericVisits(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Build the analytics page's full view model from Supabase, with
 * semantics identical to the oracle page's in-page derivations.
 */
export async function getAnalyticsSupa(
  adapter: AdminAnalyticsAdapter,
  options: { nowMs: number },
): Promise<AdminAnalyticsViewModel> {
  const nowMs = options?.nowMs ?? Date.now();

  const [visitDocs, totalDoc, totalUsers, projectsCount, eventDocs] =
    await Promise.all([
      adapter.listDocs('pageVisits', {
        orderBy: { field: 'visits', direction: 'desc' },
        limit: PAGE_VISITS_CAP,
      }),
      adapter.getDoc('pageVisits', SITE_TOTAL_VISITS_ID),
      adapter.countDocs('users'),
      adapter.countDocs('projects'),
      adapter.listDocs('analyticsEvents', {
        orderBy: { field: 'timestamp', direction: 'desc' },
        limit: ANALYTICS_EVENTS_CAP,
      }),
    ]);

  /* pageVisits — TRAP (a): never trust the fetch order for visits.
   * Whatever order the adapter returned (its server-side text order
   * would put '9' above '100'), re-sort NUMERICALLY desc here. The
   * site_total_visits counter doc is excluded from the list and used
   * only as the total (0 when the counter doc is missing). */
  const pageVisits: AnalyticsPageVisit[] = visitDocs
    .filter((d) => d.id !== SITE_TOTAL_VISITS_ID)
    .map((d) => ({
      path: d.id.replace(/_/g, '/'),
      visits: numericVisits(d.visits),
      lastVisit: d.lastVisit ?? null,
    }))
    .sort((a, b) => b.visits - a.visits);
  const top5Pages = pageVisits.filter((v) => v.path !== 'home').slice(0, 5);
  const totalVisits = totalDoc ? numericVisits(totalDoc.visits) : 0;

  /* analyticsEvents — normalize timestamps FIRST (trap (b)), then run
   * the oracle derivations over the normalized events. The adapter is
   * asked for timestamp desc + cap 200, exactly the oracle query; the
   * seam additionally re-sorts by normalized millis desc (stable, so
   * equal timestamps keep fetch order) and re-applies the cap, so the
   * working set is the latest 200 regardless of the stored shape. */
  const events: AnalyticsEventView[] = eventDocs
    .map((d) => {
      const timestampMs = normalizeAnalyticsTimestampMs(d.timestamp ?? null);
      return {
        type: (d.type as string) ?? 'unknown',
        label: (d.label as string) ?? null,
        path: (d.path as string) ?? null,
        targetId: (d.targetId as string) ?? null,
        timestamp: timestampMs === null ? null : new Date(timestampMs).toISOString(),
        timestampMs,
        timeOnPageMs: ((d.timeOnPageMs ?? d.durationMs ?? null) as number | null),
        scrollDepth: (d.scrollDepth as number) ?? null,
      };
    })
    .sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0))
    .slice(0, ANALYTICS_EVENTS_CAP);

  // Top clicked: label || targetId || 'unknown', count desc, ties
  // first-seen (Record insertion order + stable sort, as in the oracle).
  const labelCounts: Record<string, number> = {};
  for (const e of events) {
    if (e.type !== 'click') continue;
    const key = e.label || e.targetId || 'unknown';
    labelCounts[key] = (labelCounts[key] || 0) + 1;
  }
  const topClicked = Object.entries(labelCounts)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // 7-day click trend: UTC buckets ending today (by normalized millis —
  // NO toDate guard; ISO-form events bucket exactly like Timestamp-form).
  const buckets: Record<string, number> = {};
  const nowDate = new Date(nowMs);
  const todayUtcMs = Date.UTC(
    nowDate.getUTCFullYear(),
    nowDate.getUTCMonth(),
    nowDate.getUTCDate(),
  );
  for (let i = 0; i < 7; i++) {
    const key = new Date(todayUtcMs - i * 86_400_000).toISOString().slice(0, 10);
    buckets[key] = 0;
  }
  for (const e of events) {
    if (e.type !== 'click' || e.timestampMs === null) continue;
    const key = new Date(e.timestampMs).toISOString().slice(0, 10);
    if (key in buckets) buckets[key] += 1;
  }
  const clicksByDay = Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

  // Averages (oracle: time_on_page uses timeOnPageMs with durationMs
  // fallback — already applied in the mapping above; Math.round mean).
  const times: number[] = events
    .filter((e) => e.type === 'time_on_page' && typeof e.timeOnPageMs === 'number')
    .map((e) => e.timeOnPageMs as number);
  const avgTimeOnPageMs = times.length
    ? Math.round(times.reduce((s, v) => s + v, 0) / times.length)
    : 0;
  const depths: number[] = events
    .filter((e) => e.type === 'scroll_depth' && typeof e.scrollDepth === 'number')
    .map((e) => e.scrollDepth as number);
  const avgScrollDepth = depths.length
    ? Math.round(depths.reduce((s, v) => s + v, 0) / depths.length)
    : 0;

  return {
    pageVisits,
    top5Pages,
    totalVisits,
    totalUsers,
    projectsCount,
    recentEvents: events,
    topClicked,
    clicksByDay,
    avgTimeOnPageMs,
    avgScrollDepth,
    recentClicks: events.filter((e) => e.type === 'click').length,
  };
}
