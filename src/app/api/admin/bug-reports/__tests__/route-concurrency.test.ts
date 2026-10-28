/**
 * @jest-environment node
 *
 * SEC-RACE (audit item 11): bug-bounty award concurrency for
 * PATCH /api/admin/bug-reports.
 *
 * The pre-fix Firestore leg checked report.pointsAwarded on a
 * snapshot read BEFORE a plain WriteBatch, so two concurrent
 * approvals both passed the check and both incremented the reporter.
 * The award now runs inside runTransaction keyed on the report doc +
 * a deterministic ledger doc (bug_bounty_<reportId>).
 *
 * This harness is an in-memory Firestore whose runTransaction is
 * SERIALIZED through a promise chain (the fake-firestore.ts pattern),
 * so two truly concurrent PATCH calls interleave exactly like
 * production: both read the un-awarded report first, then their
 * transactions serialize and the loser re-reads the awarded flag
 * inside its transaction.
 */

const mockState = {
  supaPrimary: false,
  rpcAppliedCount: 0,
  flushCalls: [] as any[],
};

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({
    authenticated: true,
    user: { userId: 'admin-1', email: 'admin@example.com' },
  }),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: async () => true,
}));

jest.mock('@/lib/supa/flags', () => ({
  isSupaPrimary: () => mockState.supaPrimary,
}));

jest.mock('@/lib/supa/gamification', () => ({
  // Simulates the apply_points_award RPC claim: the first claim for a
  // report applies, every later claim for the same report duplicates.
  applyPointsAwardViaSupa: async (input: any) => {
    mockState.rpcAppliedCount += 1;
    if (mockState.rpcAppliedCount === 1) return { applied: true, duplicate: false };
    return { applied: false, duplicate: true };
  },
}));

jest.mock('@/lib/server/supa-identity-primary', () => ({
  flushPendingUsersPrimaryOps: async (ops: any[]) => {
    mockState.flushCalls.push(...ops);
  },
}));

/* ------------------------------------------------ in-memory Firestore */
function isSentinel(v: any, kind: string): boolean {
  return v !== null && typeof v === 'object' && v.__fv === kind;
}
function applyValue(existing: any, value: any): any {
  if (isSentinel(value, 'serverTimestamp')) return 'SERVER_TIMESTAMP';
  if (isSentinel(value, 'increment')) return (typeof existing === 'number' ? existing : 0) + value.n;
  if (isSentinel(value, 'arrayUnion')) {
    const base = Array.isArray(existing) ? [...existing] : [];
    for (const v of value.vals) if (!base.includes(v)) base.push(v);
    return base;
  }
  return value;
}
function applyData(existing: Record<string, any>, data: Record<string, any>): Record<string, any> {
  const next = { ...existing };
  for (const [k, v] of Object.entries(data)) next[k] = applyValue(next[k], v);
  return next;
}

const mockDocs: Record<string, any> = {};
let txChain: Promise<any> = Promise.resolve();

function makeDocRef(collectionName: string, id: string): any {
  const path = `${collectionName}/${id}`;
  return {
    id,
    path,
    get: async () => {
      const data = mockDocs[path];
      return { exists: data !== undefined, data: () => data };
    },
    update: async (data: any) => {
      mockDocs[path] = applyData(mockDocs[path] ?? {}, data);
    },
    set: async (data: any, opts?: any) => {
      mockDocs[path] = opts?.merge ? applyData(mockDocs[path] ?? {}, data) : { ...data };
    },
  };
}

const mockDb = {
  collection: (name: string) => ({
    doc: (id: string) => makeDocRef(name, id),
  }),
  runTransaction: (fn: any) => {
    const run = txChain.then(async () => {
      const tx = {
        get: async (ref: any) => ref.get(),
        set: async (ref: any, data: any, opts?: any) => {
          mockDocs[ref.path] = opts?.merge ? applyData(mockDocs[ref.path] ?? {}, data) : { ...data };
        },
        update: async (ref: any, data: any) => {
          mockDocs[ref.path] = applyData(mockDocs[ref.path] ?? {}, data);
        },
      };
      return fn(tx);
    });
    txChain = run.catch(() => undefined);
    return run;
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDb,
  admin: {
    firestore: {
      FieldValue: {
        serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
        increment: (n: number) => ({ __fv: 'increment', n }),
        arrayUnion: (...vals: any[]) => ({ __fv: 'arrayUnion', vals }),
      },
    },
  },
}));

import { PATCH } from '../route';

function makeRequest(body: any): any {
  return { json: async () => body };
}

function ledgerDocs(): Array<[string, any]> {
  return Object.entries(mockDocs).filter(([p]) => p.startsWith('points_ledger/'));
}

describe('PATCH /api/admin/bug-reports award concurrency (SEC-RACE item 11)', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockDocs)) delete mockDocs[k];
    txChain = Promise.resolve();
    mockState.supaPrimary = false;
    mockState.rpcAppliedCount = 0;
    mockState.flushCalls = [];
    mockDocs['bug_reports/report-1'] = {
      title: 'Crash on save',
      submittedByUid: 'reporter-1',
      status: 'open',
    };
    mockDocs['users/reporter-1'] = { points: 5, total_points: 5 };
  });

  test('two concurrent approvals award exactly once (Firestore leg)', async () => {
    const body = { reportId: 'report-1', status: 'resolved', awardPoints: 50 };
    const [r1, r2]: any[] = await Promise.all([PATCH(makeRequest(body)), PATCH(makeRequest(body))]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Both responses report the award (the loser is a no-op returning
    // the already-awarded result), but the money moved exactly once.
    expect((await r1.json()).pointsAwarded).toBe(50);
    expect((await r2.json()).pointsAwarded).toBe(50);
    expect(mockDocs['users/reporter-1'].points).toBe(55);
    expect(mockDocs['users/reporter-1'].total_points).toBe(55);
    expect(ledgerDocs()).toHaveLength(1);
    expect(ledgerDocs()[0][0]).toBe('points_ledger/bug_bounty_report-1');
    expect(ledgerDocs()[0][1].points_awarded).toBe(50);
    expect(mockDocs['bug_reports/report-1'].pointsAwarded).toBe(50);
    // The users-primary flush runs only for the winning claim.
    expect(mockState.flushCalls).toHaveLength(1);
  });

  test('a sequential repeat approval does not re-award', async () => {
    const body = { reportId: 'report-1', awardPoints: 50 };
    const first: any = await PATCH(makeRequest(body));
    expect((await first.json()).pointsAwarded).toBe(50);
    const second: any = await PATCH(makeRequest(body));
    expect(second.status).toBe(200);
    expect((await second.json()).pointsAwarded).toBe(0);
    expect(mockDocs['users/reporter-1'].points).toBe(55);
    expect(ledgerDocs()).toHaveLength(1);
  });

  test('two concurrent approvals award exactly once (Supa gamification leg)', async () => {
    mockState.supaPrimary = true;
    const body = { reportId: 'report-1', status: 'resolved', awardPoints: 50 };
    const [r1, r2]: any[] = await Promise.all([PATCH(makeRequest(body)), PATCH(makeRequest(body))]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const bodies = [await r1.json(), await r2.json()];
    // The RPC claim applied once; the duplicate claim fell through to
    // a plain report update with no award.
    expect(bodies.filter((b) => b.pointsAwarded === 50)).toHaveLength(1);
    expect(bodies.filter((b) => b.pointsAwarded === 0)).toHaveLength(1);
    expect(mockDocs['bug_reports/report-1'].pointsAwarded).toBe(50);
  });
});
