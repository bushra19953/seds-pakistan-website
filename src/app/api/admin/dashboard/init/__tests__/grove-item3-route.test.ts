/**
 * @jest-environment node
 *
 * Grove Item 3 — paired dashboard indicators.
 *
 * Spec (Item 3 in seds_website_grove_optimization_comparison.md):
 * extend GET /api/admin/dashboard/init with three counter-indicators,
 * all computed from existing collections inside the existing route:
 *   1. departed count ("+N departed this term" under Personnel) —
 *      users whose lifecycle status is departed
 *      (memberStatus === 'departed'; see src/lib/server/member-lifecycle.ts,
 *      departedAt is stamped by the depart route).
 *   2. median days waiting for pending applications
 *      ("median days waiting" under Recruitment Pending) —
 *      median age, in days, of applications with status 'pending',
 *      aged from the application doc's created_at timestamp.
 *   3. overdue rate percentage, paired with a Tasks Completed figure —
 *      overdue tasks as a percentage (0-100). All-overdue = 100,
 *      none-overdue = 0, and zero tasks must not divide by zero.
 *
 * Mocking style mirrors the existing route.test.ts in this folder
 * (in-memory collections, makeQuery with where/orderBy/limit/count/get,
 * mocked firebase-admin / auth-middleware / permissions). The mock is
 * extended to support the 'in' / comparison operators and the `tasks`
 * collection, so implementations that either count with queries or
 * fetch-and-compute in memory are both exercised.
 *
 * Field-name tolerance: the Item 3 implementation was not yet present
 * when these tests were written, so the response field is located by
 * searching the JSON body (metrics first, then top level, recursively)
 * for any of the plausible names listed in `pick()`. The VALUES are
 * asserted strictly; only the key name is flexible. If no plausible
 * key exists the test fails and prints the keys that were returned.
 */

import { NextRequest } from 'next/server';

type Doc = { id: string; data: Record<string, any> };
type Filter = [string, string, unknown];

const state = {
  authResult: { authenticated: false } as any,
  canAccess: true,
  userDocs: new Map<string, Record<string, any>>(),
  collections: new Map<string, Doc[]>(),
  queryExecutions: 0,
};

function comparable(v: unknown): any {
  if (v && typeof v === 'object') {
    const o: any = v as any;
    if (typeof o.toDate === 'function') return o.toDate().getTime();
    if (o instanceof Date) return o.getTime();
    if (typeof o.toMillis === 'function') return o.toMillis();
    if (typeof o.seconds === 'number') return o.seconds * 1000;
  }
  return v;
}

function matches(data: Record<string, any>, filters: Filter[]): boolean {
  return filters.every(([f, op, v]) => {
    const actual = comparable(data[f]);
    const expected = comparable(v);
    switch (op) {
      case '==':
        return actual === expected;
      case '!=':
        return actual !== expected;
      case 'in':
        return Array.isArray(v) && (v as unknown[]).map(comparable).includes(actual);
      case 'array-contains':
        return Array.isArray(data[f]) && data[f].includes(v);
      case '>=':
        return actual >= expected;
      case '<=':
        return actual <= expected;
      case '>':
        return actual > expected;
      case '<':
        return actual < expected;
      default:
        return actual === expected;
    }
  });
}

function matchingDocs(name: string, filters: Filter[]): Doc[] {
  const rows = state.collections.get(name) || [];
  return rows.filter((d) => matches(d.data, filters));
}

function makeQuery(name: string, filters: Filter[] = []): any {
  const q: any = {
    where: (f: string, op: string, v?: unknown) =>
      // Support both where(field, value) and where(field, op, value).
      v === undefined ? makeQuery(name, [...filters, [f, '==', op]]) : makeQuery(name, [...filters, [f, op, v]]),
    orderBy: () => q,
    limit: () => q,
    count: () => ({
      get: async () => {
        state.queryExecutions++;
        return { data: () => ({ count: matchingDocs(name, filters).length }) };
      },
    }),
    get: async () => {
      state.queryExecutions++;
      const docs = matchingDocs(name, filters).map((d) => ({
        id: d.id,
        exists: true,
        data: () => ({ ...d.data }),
      }));
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  };
  return q;
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'permissions') {
      return {
        doc: (_id: string) => ({
          get: async () => ({ exists: false, data: () => undefined }),
        }),
      };
    }
    return {
      ...makeQuery(name),
      doc: (id: string) => ({
        get: async () => {
          const data = state.userDocs.get(id);
          return { exists: !!data, id, data: () => data };
        },
      }),
    };
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
  admin: {},
  getAdminDiagnostics: jest.fn(() => ({})),
  getLastAdminError: jest.fn(() => null),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async () => state.canAccess),
}));

import { GET } from '@/app/api/admin/dashboard/init/route';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Firestore-Timestamp-like object for a moment `daysAgo` days before now. */
function tsDaysAgo(daysAgo: number) {
  const d = new Date(Date.now() - daysAgo * DAY_MS);
  return {
    toDate: () => d,
    toMillis: () => d.getTime(),
    seconds: Math.floor(d.getTime() / 1000),
    nanoseconds: 0,
  };
}

function pendingApp(id: string, daysAgo: number, chapterId = 'ist'): Doc {
  const ts = tsDaysAgo(daysAgo);
  // Both spellings are set: production application docs carry created_at,
  // but an implementation reading createdAt must see the same instant.
  return { id, data: { chapterId, status: 'pending', created_at: ts, createdAt: ts } };
}

function decidedApp(id: string, status: string, daysAgo: number, chapterId = 'ist'): Doc {
  const ts = tsDaysAgo(daysAgo);
  return { id, data: { chapterId, status, created_at: ts, createdAt: ts } };
}

function user(id: string, extra: Record<string, any> = {}, chapterId = 'ist'): Doc {
  return { id, data: { chapterId, ...extra } };
}

function departedUser(id: string, chapterId = 'ist'): Doc {
  const ts = tsDaysAgo(1);
  return {
    id,
    data: {
      chapterId,
      memberStatus: 'departed',
      departedAt: ts,
      departed_at: ts,
    },
  };
}

function task(id: string, status: string, chapterId = 'ist'): Doc {
  return { id, data: { chapterId, status } };
}

function baseCollections(overrides: Record<string, Doc[]> = {}) {
  const base: Record<string, Doc[]> = {
    users: [],
    projects: [],
    blogs: [],
    events: [],
    announcements: [],
    applications: [],
    audit_logs: [],
    tasks: [],
  };
  state.collections = new Map(Object.entries({ ...base, ...overrides }));
}

function asGlobalAdmin() {
  state.authResult = { authenticated: true, user: { userId: 'g1', role: 'superadmin' } };
  state.userDocs.set('g1', { role: 'superadmin' });
}

function asChapterAdmin() {
  state.authResult = { authenticated: true, user: { userId: 'c1', role: 'chair_design' } };
  state.userDocs.set('c1', { chapterId: 'ist', role: 'chair_design' });
}

function req(qs = '') {
  return new NextRequest(`http://localhost/api/admin/dashboard/init${qs}`);
}

async function getBody(qs = '') {
  const res = await GET(req(qs));
  expect(res.status).toBe(200);
  return res.json();
}

// ---------------------------------------------------------------------------
// Response field lookup (name-flexible, value-strict)
// ---------------------------------------------------------------------------

function flatten(obj: any, prefix = '', out: Record<string, any> = {}): Record<string, any> {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      out[path] = v;
      flatten(v, path, out);
    }
  }
  return out;
}

function normaliseKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Find a numeric indicator in the response body. Candidates are matched
 * against the normalised leaf key name, metrics object preferred.
 */
function pick(body: any, candidates: string[], leafTest?: (leaf: string) => boolean): number | null | undefined {
  const flat = flatten(body);
  const normCandidates = candidates.map(normaliseKey);
  const entries = Object.entries(flat).filter(([, v]) => typeof v === 'number' || v === null);
  // Prefer metrics.* paths, then anything else.
  entries.sort(([a], [b]) => (a.startsWith('metrics.') === b.startsWith('metrics.') ? 0 : a.startsWith('metrics.') ? -1 : 1));
  for (const [path, v] of entries) {
    const leaf = normaliseKey(path.split('.').pop() || '');
    if (normCandidates.includes(leaf)) return v as number | null;
  }
  if (leafTest) {
    for (const [path, v] of entries) {
      const leaf = normaliseKey(path.split('.').pop() || '');
      if (leafTest(leaf)) return v as number | null;
    }
  }
  return undefined;
}

function pickDeparted(body: any) {
  return pick(
    body,
    ['departed', 'departedCount', 'departedThisTerm', 'usersDeparted', 'departedMembers', 'membersDeparted', 'departedUsers'],
    (leaf) => leaf.includes('depart') && !leaf.includes('at') && !leaf.includes('by'),
  );
}

function pickMedianDaysWaiting(body: any) {
  return pick(
    body,
    [
      'medianDaysWaiting',
      'medianWaitingDays',
      'medianApplicationAgeDays',
      'medianPendingDays',
      'medianDaysPending',
      'medianWaitDays',
      'applicationsMedianDaysWaiting',
      'medianApplicationDays',
      'medianDays',
    ],
    (leaf) => leaf.includes('median'),
  );
}

function pickOverdueRate(body: any) {
  return pick(
    body,
    ['overdueRate', 'overdueRatePercent', 'overdueRatePercentage', 'tasksOverdueRate', 'overduePercent', 'overduePercentage', 'overdueRatePct'],
    (leaf) => leaf.includes('overdue') && (leaf.includes('rate') || leaf.includes('percent') || leaf.includes('pct')),
  );
}

function pickTasksCompleted(body: any) {
  return pick(body, ['tasksCompleted', 'completedTasks', 'tasksComplete'], (leaf) => leaf.includes('task') && leaf.includes('complet'));
}

function expectFound(value: unknown, body: any, label: string) {
  if (value === undefined) {
    throw new Error(
      `${label}: no plausible field found in dashboard init response. Keys returned: ${Object.keys(flatten(body)).join(', ')}`,
    );
  }
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  state.authResult = { authenticated: false };
  state.canAccess = true;
  state.userDocs = new Map();
  state.queryExecutions = 0;
  baseCollections();
  jest.clearAllMocks();
});

describe('Grove Item 3 — median days waiting (pending applications)', () => {
  it('odd pending set: ages 1, 3, 5 days -> median 3', async () => {
    asGlobalAdmin();
    baseCollections({
      applications: [pendingApp('a1', 1), pendingApp('a2', 3), pendingApp('a3', 5)],
    });
    const body = await getBody();
    const median = pickMedianDaysWaiting(body);
    expectFound(median, body, 'median days waiting');
    expect(median).not.toBeNull();
    expect(Number.isNaN(median as number)).toBe(false);
    expect(median as number).toBeCloseTo(3, 0);
  });

  it('even pending set: ages 2, 4, 6, 8 days -> median 5 (mean of middle two)', async () => {
    asGlobalAdmin();
    baseCollections({
      applications: [pendingApp('a1', 2), pendingApp('a2', 4), pendingApp('a3', 6), pendingApp('a4', 8)],
    });
    const body = await getBody();
    const median = pickMedianDaysWaiting(body);
    expectFound(median, body, 'median days waiting');
    expect(median as number).toBeCloseTo(5, 0);
  });

  it('single pending application: age 7 days -> median 7', async () => {
    asGlobalAdmin();
    baseCollections({ applications: [pendingApp('a1', 7)] });
    const body = await getBody();
    const median = pickMedianDaysWaiting(body);
    expectFound(median, body, 'median days waiting');
    expect(median as number).toBeCloseTo(7, 0);
  });

  it('empty pending set: median is 0 or null, never NaN or undefined', async () => {
    asGlobalAdmin();
    baseCollections({
      applications: [decidedApp('a1', 'shortlisted', 10), decidedApp('a2', 'rejected', 20)],
    });
    const body = await getBody();
    const median = pickMedianDaysWaiting(body);
    expectFound(median, body, 'median days waiting');
    expect(median === 0 || median === null).toBe(true);
    if (typeof median === 'number') expect(Number.isNaN(median)).toBe(false);
  });

  it('ignores non-pending applications: a 100-day-old shortlisted application does not move the median', async () => {
    asGlobalAdmin();
    baseCollections({
      applications: [
        pendingApp('a1', 2),
        pendingApp('a2', 4),
        decidedApp('a3', 'shortlisted', 100),
        decidedApp('a4', 'rejected', 100),
      ],
    });
    const body = await getBody();
    const median = pickMedianDaysWaiting(body);
    expectFound(median, body, 'median days waiting');
    expect(median as number).toBeCloseTo(3, 0);
  });
});

describe('Grove Item 3 — departed count', () => {
  it('counts only departed members: 3 departed of active + departed + erased users', async () => {
    asGlobalAdmin();
    baseCollections({
      users: [
        departedUser('u1'),
        departedUser('u2'),
        departedUser('u3'),
        user('u4', { memberStatus: 'active' }),
        user('u5', { memberStatus: 'active' }),
        user('u6', { memberStatus: 'erased' }),
        user('u7', {}),
      ],
    });
    const body = await getBody();
    const departed = pickDeparted(body);
    expectFound(departed, body, 'departed count');
    expect(departed).toBe(3);
    // The headline Personnel count must not be inflated/deflated by the new field.
    expect(body.metrics.users).toBe(7);
  });

  it('zero departed members -> 0', async () => {
    asGlobalAdmin();
    baseCollections({
      users: [user('u1', { memberStatus: 'active' }), user('u2', {})],
    });
    const body = await getBody();
    const departed = pickDeparted(body);
    expectFound(departed, body, 'departed count');
    expect(departed).toBe(0);
  });

  it('chapter caller: departed count is chapter-scoped like every other dashboard figure', async () => {
    asChapterAdmin();
    baseCollections({
      users: [
        departedUser('u1', 'ist'),
        departedUser('u2', 'other'),
        departedUser('u3', 'other'),
        user('u4', { memberStatus: 'active' }, 'ist'),
      ],
    });
    const body = await getBody();
    const departed = pickDeparted(body);
    expectFound(departed, body, 'departed count');
    expect(departed).toBe(1);
  });
});

describe('Grove Item 3 — overdue rate (paired with tasks completed)', () => {
  it('zero tasks: overdue rate is 0, never NaN from a divide by zero', async () => {
    asGlobalAdmin();
    baseCollections({ tasks: [] });
    const body = await getBody();
    const rate = pickOverdueRate(body);
    expectFound(rate, body, 'overdue rate');
    expect(rate).toBe(0);
    if (typeof rate === 'number') expect(Number.isNaN(rate)).toBe(false);
  });

  it('all tasks overdue -> 100%', async () => {
    asGlobalAdmin();
    baseCollections({
      tasks: [task('t1', 'overdue'), task('t2', 'overdue'), task('t3', 'overdue'), task('t4', 'overdue')],
    });
    const body = await getBody();
    const rate = pickOverdueRate(body);
    expectFound(rate, body, 'overdue rate');
    expect(rate as number).toBeCloseTo(100, 5);
  });

  it('no tasks overdue (completed only) -> 0%', async () => {
    asGlobalAdmin();
    baseCollections({
      tasks: [task('t1', 'completed'), task('t2', 'completed'), task('t3', 'completed')],
    });
    const body = await getBody();
    const rate = pickOverdueRate(body);
    expectFound(rate, body, 'overdue rate');
    expect(rate).toBe(0);
  });

  it('mixed decided tasks: 2 completed + 2 overdue -> 50%', async () => {
    asGlobalAdmin();
    baseCollections({
      tasks: [task('t1', 'completed'), task('t2', 'completed'), task('t3', 'overdue'), task('t4', 'overdue')],
    });
    const body = await getBody();
    const rate = pickOverdueRate(body);
    expectFound(rate, body, 'overdue rate');
    expect(rate as number).toBeCloseTo(50, 5);
  });

  it('reports the paired tasks-completed figure alongside the rate', async () => {
    asGlobalAdmin();
    baseCollections({
      tasks: [task('t1', 'completed'), task('t2', 'completed'), task('t3', 'completed'), task('t4', 'overdue')],
    });
    const body = await getBody();
    const completed = pickTasksCompleted(body);
    expectFound(completed, body, 'tasks completed');
    expect(completed).toBe(3);
  });
});
