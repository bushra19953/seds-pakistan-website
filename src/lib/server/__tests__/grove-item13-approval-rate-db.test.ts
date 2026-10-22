/**
 * Grove Item 13 — last-10 approval rate: server (Firestore-backed)
 * helper tests.
 *
 * Spec (Item 13 in
 * ~/workspace/your_files/seds_website_grove_optimization_comparison.md):
 * "Write one server helper that computes the last-10 approval rate for
 * a user from decided tasks." Figure rendered with its denominator:
 * "9 of last 10 approved". Data model impact: none — the figure is
 * computed at read time from existing task history.
 *
 * This suite drives the helper through a fake Firestore (the repo's
 * established pattern for server code), seeded with task docs whose
 * submitter is carried on assigneeId / submittedBy / userId (task docs
 * carry all three in these fixtures so any correct lookup field works).
 *
 * Mandated cases: 0 decided (no history), 3 decided all approved,
 * 10 decided mixed, more than 10 decided (only the most recent 10
 * count), pending submissions excluded from the denominator — plus
 * other members' tasks must not leak into a member's rate.
 *
 * Implementation status at time of writing: the helper had NOT landed
 * in this worktree. The suite discovers it from the candidate module
 * locations below; if none exists, the discovery test fails with an
 * explicit "implementation has not landed" message.
 */

// --- Fake Firestore (shared via globalThis so the jest.mock factories
// below, which execute lazily when the helper module is required, hand
// the helper this exact instance) -------------------------------------

interface SeedTask {
  id: string;
  owner: string;
  status: string;
  /** days before the newest task in the seed (0 = most recent) */
  ageDays: number;
}

const BASE_TIME = Date.UTC(2026, 9, 20, 12, 0, 0); // 2026-10-20

let taskDocs: Array<{ id: string; data: Record<string, any> }> = [];

function seedTasks(tasks: SeedTask[]) {
  taskDocs = tasks.map((t) => {
    const when = new Date(BASE_TIME - t.ageDays * 24 * 3600 * 1000);
    const iso = when.toISOString();
    return {
      id: t.id,
      data: {
        title: `Task ${t.id}`,
        status: t.status,
        assigneeId: t.owner,
        submittedBy: t.owner,
        userId: t.owner,
        createdAt: iso,
        updatedAt: iso,
        reviewedAt: iso,
        decidedAt: iso,
        completedAt: iso,
      },
    };
  });
}

function compareVals(a: any, b: any): number {
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (av === bv) return 0;
  if (av === undefined || av === null) return -1;
  if (bv === undefined || bv === null) return 1;
  return av < bv ? -1 : 1;
}

function makeQuery(
  filters: Array<[string, string, any]> = [],
  orders: Array<[string, string]> = [],
  limitN: number | null = null,
): any {
  const q: any = {
    where: (field: string, op: string, val: any) =>
      makeQuery([...filters, [field, op, val]], orders, limitN),
    orderBy: (field: string, dir: string = 'asc') =>
      makeQuery(filters, [...orders, [field, dir]], limitN),
    limit: (n: number) => makeQuery(filters, orders, n),
    get: async () => {
      let rows = [...taskDocs];
      for (const [field, op, val] of filters) {
        rows = rows.filter((r) => {
          const actual = r.data[field];
          if (op === '==') return actual === val;
          if (op === 'in') return Array.isArray(val) && val.includes(actual);
          if (op === '>=') return compareVals(actual, val) >= 0;
          if (op === '<=') return compareVals(actual, val) <= 0;
          return false;
        });
      }
      for (const [field, dir] of [...orders].reverse()) {
        rows.sort((x, y) => {
          const c = compareVals(x.data[field], y.data[field]);
          return dir === 'desc' ? -c : c;
        });
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      const docs = rows.map((r) => ({
        id: r.id,
        exists: true,
        data: () => ({ ...r.data }),
        ref: { id: r.id, path: `tasks/${r.id}` },
      }));
      return { docs, empty: docs.length === 0, size: docs.length, forEach: (cb: any) => docs.forEach(cb) };
    },
  };
  return q;
}

const fakeDb: any = {
  collection: (name: string) => {
    if (name !== 'tasks') {
      return { ...makeQuery(), doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }) };
    }
    const base = makeQuery();
    return {
      ...base,
      doc: (id: string) => ({
        id,
        path: `tasks/${id}`,
        get: async () => {
          const found = taskDocs.find((d) => d.id === id);
          return { exists: !!found, id, data: () => (found ? { ...found.data } : undefined) };
        },
      }),
    };
  },
};

(globalThis as any).__grove13Db = fakeDb;

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => (globalThis as any).__grove13Db,
  getAdminDb: () => (globalThis as any).__grove13Db,
  adminDb: (globalThis as any).__grove13Db,
  db: (globalThis as any).__grove13Db,
  admin: {
    firestore: () => (globalThis as any).__grove13Db,
  },
  getLastAdminError: () => null,
}));

jest.mock('firebase-admin', () => ({
  apps: [],
  initializeApp: () => ({}),
  firestore: Object.assign(() => (globalThis as any).__grove13Db, {
    FieldValue: { serverTimestamp: () => new Date(), increment: (n: number) => n },
  }),
  credential: { cert: () => ({}) },
}));

// --- Discovery + result normalization (same contract as the pure
// suite in src/lib/__tests__/grove-item13-approval-rate.test.ts) ------

const CANDIDATE_MODULES = [
  '@/lib/server/approval-rate',
  '@/lib/server/task-approval-rate',
  '@/lib/server/review-approval-rate',
  '@/lib/server/assignee-approval-rate',
  '@/lib/server/submission-approval-rate',
  '@/lib/server/approval-rate-helper',
  '@/lib/approval-rate',
];

interface Normalized {
  approved?: number;
  decided?: number;
  rate: number | null | undefined;
  hasHistory?: boolean;
  raw: any;
}

function normalize(raw: any): Normalized {
  if (raw === null || raw === undefined) return { rate: null, hasHistory: false, raw };
  if (typeof raw === 'number') {
    return { rate: Number.isNaN(raw) ? undefined : raw > 1 ? raw / 100 : raw, raw };
  }
  if (typeof raw === 'string') {
    const m = raw.match(/(\d+)\s*(?:of|\/)\s*(?:last\s*)?(\d+)/i);
    if (m) {
      const approved = Number(m[1]);
      const decided = Number(m[2]);
      return { approved, decided, rate: decided > 0 ? approved / decided : null, hasHistory: decided > 0, raw };
    }
    const pct = raw.match(/(\d+(?:\.\d+)?)\s*%/);
    if (pct) return { rate: Number(pct[1]) / 100, raw };
    return { rate: undefined, raw };
  }
  if (typeof raw === 'object') {
    const pick = (...keys: string[]) => {
      for (const k of keys) if (raw[k] !== undefined && raw[k] !== null) return raw[k];
      return undefined;
    };
    const approved = pick('approved', 'approvedCount', 'approvals', 'approvedSubmissions', 'numApproved', 'countApproved');
    const decided = pick('decided', 'decidedCount', 'totalDecided', 'decidedSubmissions', 'considered', 'windowSize', 'sampleSize', 'total', 'count');
    let rate: number | null | undefined;
    const r = pick('rate', 'approvalRate', 'ratio', 'fraction');
    if (typeof r === 'number') rate = r > 1 ? r / 100 : r;
    if (r === null) rate = null;
    if (rate === undefined) {
      const pct = pick('percent', 'percentage', 'approvalPercent');
      if (typeof pct === 'number') rate = pct / 100;
    }
    if (rate === undefined && typeof approved === 'number' && typeof decided === 'number') {
      rate = decided > 0 ? approved / decided : null;
    }
    return {
      approved: typeof approved === 'number' ? approved : undefined,
      decided: typeof decided === 'number' ? decided : undefined,
      rate,
      hasHistory: typeof raw.hasHistory === 'boolean' ? raw.hasHistory : typeof decided === 'number' ? decided > 0 : undefined,
      raw,
    };
  }
  return { rate: undefined, raw };
}

type CallStyle = (uid: string) => Promise<Normalized>;
let callHelper: CallStyle | null = null;
let discoveryError = '';

async function tryStyles(fn: any): Promise<CallStyle | null> {
  const db = (globalThis as any).__grove13Db;
  const styles: Array<(uid: string) => any> = [
    (uid) => fn(uid),
    (uid) => fn(uid, db),
    (uid) => fn(db, uid),
    (uid) => fn({ userId: uid }),
    (uid) => fn({ userId: uid, db }),
    (uid) => fn({ db, userId: uid }),
    (uid) => fn({ assigneeId: uid }),
    (uid) => fn({ uid }),
  ];
  for (const style of styles) {
    try {
      const raw = await style('member-1');
      const n = normalize(raw);
      if (n.decided === 3 || (n.decided === undefined && n.rate !== undefined && n.rate !== null && Math.abs(n.rate - 2 / 3) < 0.011)) {
        return async (uid: string) => normalize(await style(uid));
      }
    } catch {
      // next style
    }
  }
  return null;
}

beforeAll(async () => {
  // Probe fixture: member-1 has 2 approved + 1 rejected decided, and
  // one pending (excluded). member-2 noise must not leak in.
  seedTasks([
    { id: 'p-old-rej', owner: 'member-1', status: 'rejected', ageDays: 3 },
    { id: 'p-app-2', owner: 'member-1', status: 'approved', ageDays: 2 },
    { id: 'p-app-1', owner: 'member-1', status: 'approved', ageDays: 1 },
    { id: 'p-pending', owner: 'member-1', status: 'submitted-for-review', ageDays: 0 },
    { id: 'p-other', owner: 'member-2', status: 'rejected', ageDays: 1 },
  ]);
  const seen: string[] = [];
  for (const modulePath of CANDIDATE_MODULES) {
    let mod: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require(modulePath);
    } catch {
      continue;
    }
    const exportsMap = mod && typeof mod === 'object' ? mod : { default: mod };
    for (const [name, value] of Object.entries(exportsMap)) {
      if (typeof value !== 'function' || !/approval/i.test(name)) continue;
      seen.push(`${modulePath}:${name}`);
      const call = await tryStyles(value);
      if (call) {
        callHelper = call;
        return;
      }
    }
  }
  discoveryError =
    'IMPLEMENTATION HAS NOT LANDED (or landed under an unrecognized ' +
    'name/location): no Firestore-backed approval-rate helper found. ' +
    'Modules probed: ' +
    CANDIDATE_MODULES.join(', ') +
    (seen.length ? `. Exports seen but not callable as a db helper: ${seen.join(', ')}` : '. No candidate module exists yet.');
});

async function rateFor(uid: string): Promise<Normalized> {
  if (!callHelper) throw new Error(discoveryError);
  return callHelper(uid);
}

function expectRate(n: Normalized, approved: number, decided: number) {
  if (n.decided !== undefined) expect(n.decided).toBe(decided);
  if (n.approved !== undefined) expect(n.approved).toBe(approved);
  expect(n.rate).not.toBeUndefined();
  expect(n.rate).not.toBeNull();
  expect(Math.abs((n.rate as number) - approved / decided)).toBeLessThan(0.011);
}

/** Seed from a most-recent-first status list for one member. */
function seedFromStatuses(statusesMostRecentFirst: string[], owner = 'member-1') {
  seedTasks(
    statusesMostRecentFirst.map((s, i) => ({
      id: `t-${i}`,
      owner,
      status: s,
      ageDays: i, // 0 = most recent; larger age = older. Insertion is reversed below so the store stays chronological.
    })).reverse(),
  );
}

// --- Tests ----------------------------------------------------------------

describe('Grove Item 13 — last-10 approval rate (server helper, fake Firestore)', () => {
  test('discovery: a Firestore-backed approval-rate helper exists', () => {
    if (!callHelper) throw new Error(discoveryError);
    expect(typeof callHelper).toBe('function');
  });

  test('0 decided submissions: member with no tasks gets the no-history state', async () => {
    seedTasks([{ id: 'x-1', owner: 'member-2', status: 'approved', ageDays: 1 }]);
    const n = await rateFor('member-1');
    if (n.decided !== undefined) expect(n.decided).toBe(0);
    if (n.approved !== undefined) expect(n.approved).toBe(0);
    if (n.hasHistory !== undefined) expect(n.hasHistory).toBe(false);
    if (n.rate !== undefined && n.rate !== null) {
      expect(Number.isNaN(n.rate)).toBe(false);
      expect(n.rate).toBe(0);
    }
  });

  test('0 decided submissions: member with only pending work gets the no-history state', async () => {
    seedFromStatuses(['submitted-for-review', 'pending', 'in-progress']);
    const n = await rateFor('member-1');
    if (n.decided !== undefined) expect(n.decided).toBe(0);
    if (n.approved !== undefined) expect(n.approved).toBe(0);
    if (n.rate !== undefined && n.rate !== null) expect(n.rate).toBe(0);
  });

  test('3 decided, all approved: 3 of 3, rate 1', async () => {
    seedFromStatuses(['approved', 'approved', 'approved']);
    expectRate(await rateFor('member-1'), 3, 3);
  });

  test('10 decided, mixed (7 approved, 3 rejected): 7 of 10, rate 0.7', async () => {
    seedFromStatuses([
      'approved', 'rejected', 'approved', 'approved', 'rejected',
      'approved', 'approved', 'approved', 'rejected', 'approved',
    ]);
    expectRate(await rateFor('member-1'), 7, 10);
  });

  test('more than 10 decided: only the most recent 10 count (15 decided, newest 10 approved, oldest 5 rejected)', async () => {
    seedFromStatuses([
      ...Array(10).fill('approved'),
      ...Array(5).fill('rejected'),
    ]);
    expectRate(await rateFor('member-1'), 10, 10);
  });

  test('pending submissions are excluded from the denominator', async () => {
    seedFromStatuses([
      'approved',
      'submitted-for-review',
      'rejected',
      'pending',
      'approved',
      'in-progress',
      'submitted-for-review',
    ]);
    expectRate(await rateFor('member-1'), 2, 3);
  });

  test("other members' tasks do not leak into the rate", async () => {
    seedTasks([
      { id: 'a1', owner: 'member-1', status: 'approved', ageDays: 2 },
      { id: 'a2', owner: 'member-1', status: 'approved', ageDays: 1 },
      { id: 'b1', owner: 'member-2', status: 'rejected', ageDays: 5 },
      { id: 'b2', owner: 'member-2', status: 'rejected', ageDays: 4 },
      { id: 'b3', owner: 'member-2', status: 'rejected', ageDays: 3 },
      { id: 'b4', owner: 'member-2', status: 'rejected', ageDays: 1 },
    ]);
    expectRate(await rateFor('member-1'), 2, 2);
    expectRate(await rateFor('member-2'), 0, 4);
  });
});
