/**
 * admin-dashboard-supa — the ONE seam between the admin dashboard init
 * route (src/app/api/admin/dashboard/init/route.ts) and the in-flight
 * Supabase adapter, for the `admin-dashboard` surface.
 *
 * Adapter (branch feat/supa-adapter, not on this branch yet):
 *   src/lib/supa/adapter.ts  exports getSupaAdapter(): SupaAdapter
 *     { getDoc, listDocs, countDocs, ... } over collection names
 *     ('users', 'applications', 'audit_logs', ... -> fs_* tables)
 *   src/lib/supa/flags.ts    exports useSupa(surface)
 *   src/lib/supa/client.ts   exports getSupaClient() (null when
 *     SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are unconfigured)
 *
 * Adapter resolution is a lazy require inside a try/catch (the established
 * sibling pattern, see notifications-supa-seam.ts): a missing module, an
 * unconfigured client, or any adapter error all resolve to "no Supa
 * payload", and the route falls back to its Firestore path byte-
 * identically. Flag OFF (the default) never touches the adapter at all.
 *
 * Semantics are the dashboard route's, computed over fs_* rows:
 *  - every count carries the effective chapter filter
 *    (applyEffectiveChapterFilter semantics: where chapterId == id, or
 *    no filter when the effective chapterId is null);
 *  - pending applications: countDocs is the exact pool size; the median
 *    derives from an id-ordered limit-100 sample, ages from
 *    `created_at ?? createdAt`, future timestamps clamp to age 0, and
 *    the median rounds to 0.1 days (null when no sampled doc carries a
 *    parseable timestamp);
 *  - tasks: per-status counts over the TaskStatus union only
 *    (completed / pending / in-progress / submitted-for-review /
 *    overdue); legacy statuses are never queried, so they are excluded
 *    from numerator and denominator; a zero denominator yields rate 0;
 *  - audit: latest 20 ordered by timestamp desc. The adapter finishes
 *    data-field orderings client-side (timestamps chronologically,
 *    numbers numerically, id-ascending tiebreak), so this seam relies
 *    on that ordering and never re-sorts by raw text.
 *
 * DIVERGENCE (adjudicated, see cluster-admin/PARITY_TABLE.md section 1,
 * dashboard string-timestamp row): the Firestore route maps a
 * string-form audit timestamp to `new Date().toISOString()` (now),
 * because `timestamp?.toDate` is absent on a string. That is a quirk,
 * not a contract. This seam carries the stored ISO string through.
 * Pinned by the "string-form timestamp" test in
 * src/lib/server/__tests__/admin-dashboard-supa.test.ts.
 */

/* ------------------------------------------------------------------ types */

export type AdminDashboardWhereClause = [field: string, op: string, value: unknown];

export interface AdminDashboardSupaAdapter {
  countDocs(
    collectionPath: string,
    where?: AdminDashboardWhereClause[],
  ): Promise<number>;
  listDocs(
    collectionPath: string,
    options?: {
      where?: AdminDashboardWhereClause[];
      orderBy?:
        | string
        | { field: string; direction?: 'asc' | 'desc' }
        | Array<{ field: string; direction?: 'asc' | 'desc' }>;
      limit?: number;
      startAfter?: string | number;
    },
  ): Promise<Array<{ id: string } & Record<string, unknown>>>;
}

export interface AdminDashboardInitPayload {
  metrics: {
    users: number;
    projects: number;
    blogs: number;
    events: number;
    announcements: number;
    applicationsPending: number;
    applicationsShortlisted: number;
    applicationsRejected: number;
  };
  indicators: {
    usersDeparted: number;
    medianDaysWaiting: number | null;
    tasksCompleted: number;
    tasksOverdueRate: number;
  };
  auditLogs: Array<{
    id: string;
    action: unknown;
    targetUidOrResource: unknown;
    timestamp: string;
  }>;
}

/* --------------------------------------------------------------- flag gate */

/**
 * useSupa('admin-dashboard') equivalent. Mirrors src/lib/supa/flags.ts
 * semantics exactly (SUPA_SURFACES comma list, case-insensitive, '*'
 * enables everything, unset/empty = OFF) so this branch does not import
 * a module that does not exist on it yet. At adapter merge time this
 * body is the one line that can be swapped for the real useSupa.
 */
export function adminDashboardSupaEnabled(): boolean {
  const raw = process.env.SUPA_SURFACES;
  if (!raw) return false;
  const surfaces = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (surfaces.length === 0) return false;
  if (surfaces.includes('*')) return true;
  return surfaces.includes('admin-dashboard');
}

/* -------------------------------------------------------- adapter plumbing */

let injectedAdapter: AdminDashboardSupaAdapter | null | undefined;

/** Test-only injection point (fake adapter; no live Supabase in tests). */
export function setAdminDashboardSupaAdapterForTests(
  adapter: AdminDashboardSupaAdapter | null,
): void {
  injectedAdapter = adapter;
}

function resolveRealAdapter(): AdminDashboardSupaAdapter | null {
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
    return adapterModule.getSupaAdapter() as AdminDashboardSupaAdapter;
  } catch {
    return null;
  }
}

/** The adapter when the surface is ON and Supabase is configured, else null. */
export function getAdminDashboardSupaAdapter(): AdminDashboardSupaAdapter | null {
  if (!adminDashboardSupaEnabled()) return null;
  if (injectedAdapter !== undefined) return injectedAdapter;
  return resolveRealAdapter();
}

/* ------------------------------------------------------------ timestamps */

/**
 * Millis for any timestamp shape that can reach this seam: ISO strings
 * and numbers (jsonb storage), Date, Timestamp-like (toMillis/toDate —
 * the adapter's SupaTimestamp rehydration exposes both), and the plain
 * {seconds} / {_seconds} object forms. Mirrors the dashboard route's
 * defensive timestampMillis, extended for the stored shapes.
 */
export function supaTimestampMillis(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number') {
    const ms = new Date(v).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (v instanceof Date) {
    const ms = v.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.toMillis === 'function') {
      try {
        const ms = (o.toMillis as () => number).call(v);
        return Number.isFinite(ms) ? ms : null;
      } catch {
        return null;
      }
    }
    if (typeof o.toDate === 'function') {
      try {
        const ms = (o.toDate as () => Date).call(v).getTime();
        return Number.isNaN(ms) ? null : ms;
      } catch {
        return null;
      }
    }
    const seconds =
      typeof o.seconds === 'number'
        ? o.seconds
        : typeof o._seconds === 'number'
          ? o._seconds
          : null;
    if (seconds !== null) {
      const nanos =
        typeof o.nanoseconds === 'number'
          ? o.nanoseconds
          : typeof o._nanoseconds === 'number'
            ? o._nanoseconds
            : 0;
      return seconds * 1000 + nanos / 1_000_000;
    }
  }
  return null;
}

/**
 * Audit timestamp -> ISO string. CONTRACT behavior: a stored ISO string
 * is carried through verbatim (the Firestore route's replace-with-now
 * quirk for string-form timestamps is deliberately NOT replicated).
 * Timestamp-like values convert through their millis. Missing or
 * unparseable values fall back to `nowMs`, preserving the route's
 * response shape (timestamp is always an ISO string).
 */
export function supaTimestampToIso(v: unknown, nowMs: number): string {
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return v;
  }
  const ms = supaTimestampMillis(v);
  if (ms !== null) return new Date(ms).toISOString();
  return new Date(nowMs).toISOString();
}

/* ------------------------------------------------------------- computation */

const DAY_MS = 86_400_000;
const TASK_UNION = [
  'completed',
  'pending',
  'in-progress',
  'submitted-for-review',
  'overdue',
] as const;

function chapterWhere(
  chapterId: string | null,
  extra: AdminDashboardWhereClause[] = [],
): AdminDashboardWhereClause[] {
  const where: AdminDashboardWhereClause[] = [...extra];
  if (chapterId !== null) where.push(['chapterId', '==', chapterId]);
  return where;
}

/**
 * Compute the dashboard init payload from fs_* tables via the adapter.
 * Throws on any adapter error — the dispatch wrapper below converts a
 * throw into the route's Firestore fallback.
 */
export async function getAdminDashboardInitFromSupa(
  adapter: AdminDashboardSupaAdapter,
  opts: { chapterId: string | null; nowMs: number },
): Promise<AdminDashboardInitPayload> {
  const { chapterId, nowMs } = opts;

  const count = (collection: string, extra?: AdminDashboardWhereClause[]) =>
    adapter.countDocs(collection, chapterWhere(chapterId, extra));

  // Pending applications: exact count + id-ordered limit-100 sample.
  const pendingWhere = chapterWhere(chapterId, [['status', '==', 'pending']]);
  const pendingSamplePromise = adapter.listDocs('applications', {
    where: pendingWhere,
    orderBy: { field: 'id', direction: 'asc' },
    limit: 100,
  });

  const [
    users,
    projects,
    blogs,
    events,
    announcements,
    usersDeparted,
    applicationsPending,
    applicationsShortlisted,
    applicationsRejected,
    pendingSample,
    taskCounts,
    auditDocs,
  ] = await Promise.all([
    count('users'),
    count('projects'),
    count('blogs'),
    count('events'),
    count('announcements'),
    count('users', [['memberStatus', '==', 'departed']]),
    adapter.countDocs('applications', pendingWhere),
    count('applications', [['status', '==', 'shortlisted']]),
    count('applications', [['status', '==', 'rejected']]),
    pendingSamplePromise,
    Promise.all(
      TASK_UNION.map((status) => count('tasks', [['status', '==', status]])),
    ),
    adapter.listDocs('audit_logs', {
      where: chapterWhere(chapterId),
      orderBy: { field: 'timestamp', direction: 'desc' },
      limit: 20,
    }),
  ]);

  // Median days waiting from the sample (route semantics verbatim).
  const agesInDays: number[] = [];
  for (const d of pendingSample) {
    const createdMs = supaTimestampMillis(d.created_at ?? d.createdAt);
    if (createdMs !== null) {
      agesInDays.push(Math.max(0, (nowMs - createdMs) / DAY_MS));
    }
  }
  agesInDays.sort((a, b) => a - b);
  let medianDaysWaiting: number | null = null;
  if (agesInDays.length > 0) {
    const mid = Math.floor(agesInDays.length / 2);
    const raw =
      agesInDays.length % 2 === 1
        ? agesInDays[mid]
        : (agesInDays[mid - 1] + agesInDays[mid]) / 2;
    medianDaysWaiting = Math.round(raw * 10) / 10;
  }

  const [completed, pending, inProgress, submittedForReview, overdue] = taskCounts;
  const decidedPlusActive =
    completed + pending + inProgress + submittedForReview + overdue;

  return {
    metrics: {
      users,
      projects,
      blogs,
      events,
      announcements,
      applicationsPending,
      applicationsShortlisted,
      applicationsRejected,
    },
    indicators: {
      usersDeparted,
      medianDaysWaiting,
      tasksCompleted: completed,
      tasksOverdueRate:
        decidedPlusActive > 0
          ? Math.round((overdue / decidedPlusActive) * 1000) / 10
          : 0,
    },
    auditLogs: auditDocs.map((d) => ({
      id: d.id,
      action: d.action,
      targetUidOrResource: d.targetUidOrResource,
      timestamp: supaTimestampToIso(d.timestamp, nowMs),
    })),
  };
}

/**
 * Route dispatch: the Supa payload when the surface is ON, an adapter is
 * available, and it answers cleanly; null in every other case (flag OFF,
 * unconfigured, adapter error) — null means "run the Firestore path
 * exactly as today".
 */
export async function tryAdminDashboardInitFromSupa(opts: {
  chapterId: string | null;
  nowMs?: number;
}): Promise<AdminDashboardInitPayload | null> {
  const adapter = getAdminDashboardSupaAdapter();
  if (!adapter) return null;
  try {
    return await getAdminDashboardInitFromSupa(adapter, {
      chapterId: opts.chapterId,
      nowMs: opts.nowMs ?? Date.now(),
    });
  } catch (err) {
    console.error(
      '[Dashboard] Supa dashboard init failed, falling back to Firestore:',
      err,
    );
    return null;
  }
}
