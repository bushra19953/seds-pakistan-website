/**
 * Grove Item 13 — last-10 approval rate: pure computation tests.
 *
 * Spec (~/workspace/your_files/seds_website_grove_optimization_comparison.md,
 * Item 13, "Optimization: how"):
 *   1. "Write one server helper that computes the last-10 approval rate
 *      for a user from decided tasks."
 *   2. Render the figure with its denominator ("9 of last 10 approved").
 *   Tests required by the spec: "helper unit tests (fewer than 10
 *   submissions, all-approved, all-rejected)".
 *
 * This suite covers the mandated cases:
 *   - 0 decided submissions (no-history state)
 *   - 3 decided, all approved
 *   - 10 decided, mixed
 *   - more than 10 decided (only the last / most-recent 10 count)
 *   - pending / undecided submissions excluded from the denominator
 *   - all rejected (from the comparison doc)
 *
 * Implementation status at time of writing: the helper had NOT landed in
 * this worktree (no approval-rate module exists under src). Because the
 * implementer's exact module path / export name / return shape are not
 * yet fixed, this suite DISCOVERS the helper from the candidate server
 * locations below and normalizes its result (number, fraction, percent,
 * or {approved, decided, rate} object, or a "9 of last 10 approved"
 * label string). If no helper is found, the discovery test fails with
 * an explicit "implementation has not landed" message — that failure is
 * the honest signal, not a test bug.
 *
 * Input convention: submission objects are passed MOST-RECENT FIRST
 * (the order the review read path gets from a desc-ordered query), and
 * each carries decidedAt / reviewedAt / updatedAt timestamps so a
 * helper that sorts by timestamp itself sees the same ordering.
 * Decided = status 'approved' | 'rejected' (the universal-review
 * vocabulary; 'completed' is also accepted as approved where a helper
 * reads task status). Undecided = 'pending', 'in-progress',
 * 'submitted-for-review', 'overdue'.
 */

// Keep any server helper import from initializing the real Admin SDK.
jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => null,
  getAdminDb: () => null,
  adminDb: null,
  db: null,
  admin: { firestore: { FieldValue: { serverTimestamp: () => new Date() } } },
}));
jest.mock('firebase-admin', () => ({
  apps: [],
  initializeApp: () => ({}),
  firestore: Object.assign(() => null, {
    FieldValue: { serverTimestamp: () => new Date(), increment: (n: number) => n },
  }),
  credential: { cert: () => ({}) },
}));

const CANDIDATE_MODULES = [
  '@/lib/server/approval-rate',
  '@/lib/server/task-approval-rate',
  '@/lib/server/review-approval-rate',
  '@/lib/server/assignee-approval-rate',
  '@/lib/server/submission-approval-rate',
  '@/lib/server/approval-rate-helper',
  '@/lib/approval-rate',
  '@/lib/task-approval-rate',
  '@/lib/review-approval-rate',
];

const PURE_NAME_PATTERN =
  /^(compute|calculate|summari[sz]e|derive|get|build|last10|approvalRate)/i;
const NAME_MUST_MATCH = /approval/i;

type AnyFn = (...args: any[]) => any;

interface Normalized {
  approved?: number;
  decided?: number;
  /** fraction 0..1, or null for an explicit no-history result */
  rate: number | null | undefined;
  hasHistory?: boolean;
  raw: any;
}

function normalizeRate(value: any, keyHint = ''): number | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return undefined;
    if (/percent/i.test(keyHint) || value > 1) return value / 100;
    return value;
  }
  return undefined;
}

function normalize(raw: any): Normalized {
  if (raw === null || raw === undefined) {
    return { rate: null, hasHistory: false, raw };
  }
  if (typeof raw === 'number') {
    return { rate: normalizeRate(raw), raw };
  }
  if (typeof raw === 'string') {
    // e.g. "9 of last 10 approved" or "90%"
    const ofMatch = raw.match(/(\d+)\s*(?:of|\/)\s*(?:last\s*)?(\d+)/i);
    if (ofMatch) {
      const approved = Number(ofMatch[1]);
      const decided = Number(ofMatch[2]);
      return {
        approved,
        decided,
        rate: decided > 0 ? approved / decided : null,
        hasHistory: decided > 0,
        raw,
      };
    }
    const pct = raw.match(/(\d+(?:\.\d+)?)\s*%/);
    if (pct) return { rate: Number(pct[1]) / 100, raw };
    return { rate: undefined, raw };
  }
  if (typeof raw === 'object') {
    const pick = (...keys: string[]) => {
      for (const k of keys) {
        if (raw[k] !== undefined && raw[k] !== null) return raw[k];
      }
      return undefined;
    };
    const approved = pick(
      'approved',
      'approvedCount',
      'approvals',
      'approvedSubmissions',
      'numApproved',
      'countApproved',
    );
    const decided = pick(
      'decided',
      'decidedCount',
      'totalDecided',
      'decidedSubmissions',
      'considered',
      'windowSize',
      'sampleSize',
      'total',
      'count',
    );
    let rate = normalizeRate(
      pick('rate', 'approvalRate', 'ratio', 'fraction'),
      'rate',
    );
    if (rate === undefined) {
      const pct = pick('percent', 'percentage', 'approvalPercent');
      if (pct !== undefined) rate = normalizeRate(pct, 'percent');
    }
    if (rate === undefined && typeof approved === 'number' && typeof decided === 'number') {
      rate = decided > 0 ? approved / decided : null;
    }
    const hasHistory =
      typeof raw.hasHistory === 'boolean'
        ? raw.hasHistory
        : typeof decided === 'number'
          ? decided > 0
          : undefined;
    return {
      approved: typeof approved === 'number' ? approved : undefined,
      decided: typeof decided === 'number' ? decided : undefined,
      rate,
      hasHistory,
      raw,
    };
  }
  return { rate: undefined, raw };
}

// --- Discovery ------------------------------------------------------------

interface Discovered {
  modulePath: string;
  exportName: string;
  fn: AnyFn;
  /** how to call fn with a submissions array */
  call: (subs: any[]) => Promise<Normalized>;
}

let discovered: Discovered | null = null;
let discoveryError = '';

const BASE_TIME = Date.UTC(2026, 9, 1, 12, 0, 0); // 2026-10-01

/** Build one submission object; `ageDays` = days before the newest. */
function sub(status: string, ageDays: number, idx: number): any {
  const t = new Date(BASE_TIME + (100 - ageDays) * 24 * 3600 * 1000);
  const iso = t.toISOString();
  return {
    id: `sub-${idx}`,
    status,
    reviewStatus: status,
    decision: status,
    assigneeId: 'member-1',
    submittedBy: 'member-1',
    userId: 'member-1',
    createdAt: iso,
    updatedAt: iso,
    reviewedAt: iso,
    decidedAt: iso,
    completedAt: iso,
  };
}

/** Most-recent-first list from a most-recent-first status list. */
function history(statusesMostRecentFirst: string[]): any[] {
  return statusesMostRecentFirst.map((s, i) => sub(s, i, i));
}

async function tryCallStyles(fn: AnyFn, probe: any[]): Promise<((subs: any[]) => Promise<Normalized>) | null> {
  const styles: Array<(subs: any[]) => any> = [
    (subs) => fn(subs),
    (subs) => fn('member-1', subs),
    (subs) => fn(subs, 'member-1'),
    (subs) => fn({ submissions: subs }),
    (subs) => fn({ tasks: subs }),
    (subs) => fn({ userId: 'member-1', submissions: subs }),
    (subs) => fn({ userId: 'member-1', tasks: subs }),
  ];
  for (const style of styles) {
    try {
      const raw = await style(probe);
      const n = normalize(raw);
      // Probe is 2 approved + 1 rejected: a working call style must
      // report decided=3 (or a rate of 2/3 if it returns only a rate).
      if (n.decided === 3 || (n.decided === undefined && n.rate !== undefined && n.rate !== null && Math.abs(n.rate - 2 / 3) < 0.011)) {
        return async (subs: any[]) => normalize(await style(subs));
      }
    } catch {
      // try the next style
    }
  }
  return null;
}

beforeAll(async () => {
  const probe = history(['approved', 'approved', 'rejected']);
  const seen: string[] = [];
  for (const modulePath of CANDIDATE_MODULES) {
    let mod: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require(modulePath);
    } catch {
      continue; // module not landed at this path
    }
    const exportsMap = mod && typeof mod === 'object' ? mod : { default: mod };
    for (const [name, value] of Object.entries(exportsMap)) {
      if (typeof value !== 'function') continue;
      if (!NAME_MUST_MATCH.test(name) && !PURE_NAME_PATTERN.test(name)) continue;
      seen.push(`${modulePath}:${name}`);
      const call = await tryCallStyles(value as AnyFn, probe);
      if (call) {
        discovered = { modulePath, exportName: name, fn: value as AnyFn, call };
        return;
      }
    }
  }
  discoveryError =
    'IMPLEMENTATION HAS NOT LANDED (or landed under an unrecognized ' +
    'name/location): no pure approval-rate helper found. Modules probed: ' +
    CANDIDATE_MODULES.join(', ') +
    (seen.length ? `. Exports seen but not callable as a pure helper: ${seen.join(', ')}` : '. No candidate module exists yet.');
});

async function rateFor(statusesMostRecentFirst: string[]): Promise<Normalized> {
  if (!discovered) throw new Error(discoveryError);
  return discovered.call(history(statusesMostRecentFirst));
}

function expectRate(n: Normalized, approved: number, decided: number) {
  if (n.decided !== undefined) expect(n.decided).toBe(decided);
  if (n.approved !== undefined) expect(n.approved).toBe(approved);
  expect(n.rate).not.toBeUndefined();
  expect(n.rate).not.toBeNull();
  expect(Math.abs((n.rate as number) - (decided > 0 ? approved / decided : 0))).toBeLessThan(0.011);
}

// --- Tests ----------------------------------------------------------------

describe('Grove Item 13 — last-10 approval rate (pure helper)', () => {
  test('discovery: a server approval-rate helper exists', () => {
    if (!discovered) throw new Error(discoveryError);
    expect(typeof discovered.fn).toBe('function');
  });

  test('0 decided submissions: no-history state (no NaN, no invented rate)', async () => {
    const n = await rateFor([]);
    if (n.decided !== undefined) expect(n.decided).toBe(0);
    if (n.approved !== undefined) expect(n.approved).toBe(0);
    if (n.hasHistory !== undefined) expect(n.hasHistory).toBe(false);
    // Rate must be explicitly empty (null) or 0 with decided=0 — never
    // NaN and never a positive invented figure.
    if (n.rate !== undefined && n.rate !== null) {
      expect(Number.isNaN(n.rate)).toBe(false);
      expect(n.rate).toBe(0);
    }
  });

  test('only undecided submissions: still the no-history state', async () => {
    const n = await rateFor(['submitted-for-review', 'pending', 'in-progress']);
    if (n.decided !== undefined) expect(n.decided).toBe(0);
    if (n.approved !== undefined) expect(n.approved).toBe(0);
    if (n.rate !== undefined && n.rate !== null) expect(n.rate).toBe(0);
  });

  test('3 decided, all approved: 3 of 3, rate 1', async () => {
    const n = await rateFor(['approved', 'approved', 'approved']);
    expectRate(n, 3, 3);
  });

  test('10 decided, mixed (7 approved, 3 rejected): 7 of 10, rate 0.7', async () => {
    const n = await rateFor([
      'approved', 'rejected', 'approved', 'approved', 'rejected',
      'approved', 'approved', 'approved', 'rejected', 'approved',
    ]);
    expectRate(n, 7, 10);
  });

  test('more than 10 decided: only the most recent 10 count (15 decided, newest 10 all approved, oldest 5 rejected)', async () => {
    const statuses = [
      ...Array(10).fill('approved'), // most recent 10
      ...Array(5).fill('rejected'), // oldest 5 — must NOT be counted
    ];
    const n = await rateFor(statuses);
    expectRate(n, 10, 10);
  });

  test('more than 10 decided: window is the most recent 10, not the first 10 and not all (12 decided)', async () => {
    const statuses = [
      // most recent 10: 6 approved, 4 rejected
      'approved', 'rejected', 'approved', 'rejected', 'approved',
      'rejected', 'approved', 'approved', 'rejected', 'approved',
      // oldest 2: both approved — counting them gives 8/12, not 6/10
      'approved', 'approved',
    ];
    const n = await rateFor(statuses);
    expectRate(n, 6, 10);
  });

  test('pending submissions are excluded from the denominator', async () => {
    const n = await rateFor([
      'approved',
      'submitted-for-review',
      'rejected',
      'pending',
      'approved',
      'in-progress',
      'submitted-for-review',
      'overdue',
    ]);
    // Decided = approved, rejected, approved only.
    expectRate(n, 2, 3);
  });

  test('all rejected: 0 of 4, rate 0', async () => {
    const n = await rateFor(['rejected', 'rejected', 'rejected', 'rejected']);
    expectRate(n, 0, 4);
  });
});
