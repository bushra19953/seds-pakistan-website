/**
 * Deadline fairness in the canonical completion transaction
 * (src/lib/server/gamification-transaction.ts), founder rule
 * 2026-10-26: lateness is judged on the SUBMISSION instant, never on
 * the approval instant. Time a submission spends waiting for review
 * belongs to the reviewer.
 *
 * Runs the REAL executeGamificationTransaction against a fake
 * Firestore with a deterministic clock: Timestamp.now() is pinned to
 * the APPROVAL instant, after the deadline, in every case.
 *
 * The first case is Ahmed's live Step 2 (wf_1793016668063_ci14ft):
 * individualDeadline 2026-10-27T00:34Z (05:34 PKT), submitted
 * 2026-10-26T14:00Z (~10h early), penaltyPoints 10, points 30.
 * On the pre-fix code the approval-time judgment deducts the 10
 * points; this suite fails there and passes on the fix.
 */

const DEADLINE_MS = Date.parse('2026-10-27T00:34:00.000Z');
const SUBMITTED_EARLY_MS = Date.parse('2026-10-26T14:00:00.000Z');
const SUBMITTED_LATE_MS = DEADLINE_MS + 60 * 60 * 1000;
const APPROVAL_NOW_MS = Date.parse('2026-10-27T07:00:00.000Z');

class FakeTimestamp {
  constructor(private ms: number) {}
  toDate() { return new Date(this.ms); }
  toMillis() { return this.ms; }
  static now() { return new FakeTimestamp(APPROVAL_NOW_MS); }
  static fromDate(d: Date) { return new FakeTimestamp(d.getTime()); }
  static fromMillis(ms: number) { return new FakeTimestamp(ms); }
}

function assertNoUndefined(value: any, fieldPath = ''): void {
  if (value === undefined) {
    throw new Error(`Unsupported field value: undefined (found in field ${fieldPath || 'root'})`);
  }
  if (value === null || typeof value !== 'object') return;
  if (value instanceof Date || value instanceof FakeTimestamp) return;
  if ((value as any).__fv !== undefined) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUndefined(v, `${fieldPath}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    assertNoUndefined(v, fieldPath ? `${fieldPath}.${k}` : k);
  }
}

const written: Array<{ op: string; path: string; data?: any }> = [];
let genCounter = 0;

const store: Record<string, any> = {
  'tasks/step-ontime': {
    title: 'Verify the 9 submitted-but-unconfirmed accounts',
    status: 'submitted-for-review',
    assigneeIds: ['ahmed-uid'],
    assigneeId: 'ahmed-uid',
    submittedBy: 'ahmed-uid',
    points: 30,
    penaltyPoints: 10,
    individualDeadline: new FakeTimestamp(DEADLINE_MS),
    submittedAt: new FakeTimestamp(SUBMITTED_EARLY_MS),
  },
  'tasks/step-late': {
    title: 'Late submission',
    status: 'submitted-for-review',
    assigneeIds: ['ahmed-uid'],
    assigneeId: 'ahmed-uid',
    submittedBy: 'ahmed-uid',
    points: 30,
    penaltyPoints: 10,
    individualDeadline: new FakeTimestamp(DEADLINE_MS),
    submittedAt: new FakeTimestamp(SUBMITTED_LATE_MS),
  },
  'tasks/plain-direct': {
    title: 'Direct completion, never submitted',
    status: 'pending',
    assigneeIds: ['ahmed-uid'],
    assigneeId: 'ahmed-uid',
    points: 30,
    penaltyPoints: 10,
    deadline: new FakeTimestamp(DEADLINE_MS),
  },
};

function makeDocRef(collectionName: string, docId: string): any {
  const path = `${collectionName}/${docId}`;
  return {
    __kind: 'doc',
    id: docId,
    path,
    collection: (subName: string) => ({
      doc: (subId?: string) => makeDocRef(`${path}/${subName}`, subId ?? `gen-${++genCounter}`),
    }),
    get: async () => {
      const data = store[path];
      return { exists: data !== undefined, data: () => data, ref: makeDocRef(collectionName, docId) };
    },
  };
}

function makeQuery(collectionName: string, filters: Array<{ field: string; op: string; val: any }>, limitN?: number): any {
  return {
    __kind: 'query',
    where: (field: string, op: string, val: any) => makeQuery(collectionName, [...filters, { field, op, val }], limitN),
    limit: (n: number) => makeQuery(collectionName, filters, n),
    get: async () => {
      const docs = Object.entries(store)
        .filter(([p]) => {
          const parts = p.split('/');
          return parts.length === 2 && parts[0] === collectionName;
        })
        .filter(([, data]) => filters.every((f) => f.op === '==' && (data as any)[f.field] === f.val))
        .slice(0, limitN ?? Number.POSITIVE_INFINITY)
        .map(([p, data]) => {
          const id = p.split('/')[1];
          return { id, ref: makeDocRef(collectionName, id), data: () => data };
        });
      return { empty: docs.length === 0, docs };
    },
  };
}

const fakeTx = {
  get: async (refOrQuery: any) => {
    if (refOrQuery.__kind === 'query') return refOrQuery.get();
    const data = store[refOrQuery.path];
    return { exists: data !== undefined, data: () => data, ref: refOrQuery };
  },
  set: (ref: any, data: any) => {
    assertNoUndefined(data);
    written.push({ op: 'set', path: ref.path, data });
  },
  update: (ref: any, data: any) => {
    assertNoUndefined(data);
    written.push({ op: 'update', path: ref.path, data });
  },
};

const mockDb = {
  collection: (name: string) => ({
    doc: (id?: string) => makeDocRef(name, id ?? `gen-${++genCounter}`),
    where: (field: string, op: string, val: any) => makeQuery(name, [{ field, op, val }]),
  }),
  runTransaction: async (fn: any) => fn(fakeTx),
};

jest.mock('@/lib/server/firebase-admin', () => {
  const FieldValue = {
    delete: () => ({ __fv: 'delete' }),
    serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
    arrayUnion: (...vals: any[]) => ({ __fv: 'arrayUnion', vals }),
    increment: (n: number) => ({ __fv: 'increment', n }),
  };
  return {
    admin: {
      firestore: {
        Timestamp: FakeTimestamp,
        FieldValue,
      },
    },
    getDb: () => mockDb,
  };
});

import { executeGamificationTransaction } from '../gamification-transaction';

function userWrites(uid: string) {
  return written.filter((w) => w.op === 'set' && w.path === `users/${uid}`);
}
function ledgerWrites(taskId: string) {
  return written.filter((w) => w.op === 'set' && w.path.startsWith('points_ledger/') && w.data?.task_id === taskId);
}

describe('deadline fairness: submission instant decides lateness', () => {
  beforeEach(() => {
    written.length = 0;
  });

  test('on-time submission approved AFTER the deadline: no penalty, no late mark', async () => {
    const result = await executeGamificationTransaction(
      'step-ontime',
      { status: 'completed' },
      { status: 'submitted-for-review' },
      'founder-uid'
    );

    expect(result.success).toBe(true);
    expect(result.penaltyApplied).toBe(0);
    expect(result.completedLate).toBe(false);
    expect(result.completedOnTime).toBe(true);
    expect(result.pointsAwardedTotal).toBe(30);

    const counters = userWrites('ahmed-uid').map((w) => w.data).reduce((acc, d) => ({ ...acc, ...d }), {});
    expect(counters.total_points).toEqual({ __fv: 'increment', n: 30 });
    expect(counters.tasksCompletedOnTimeCount).toEqual({ __fv: 'increment', n: 1 });
    expect(counters.tasksCompletedLateCount).toBeUndefined();

    const ledger = ledgerWrites('step-ontime');
    expect(ledger).toHaveLength(1);
    expect(ledger[0].data.points_awarded).toBe(30);
    expect(ledger[0].data.penalty_applied).toBe(0);
    expect(ledger[0].data.completed_late).toBe(false);
  });

  test('genuinely late submission: penalty still applies in full', async () => {
    const result = await executeGamificationTransaction(
      'step-late',
      { status: 'completed' },
      { status: 'submitted-for-review' },
      'founder-uid'
    );

    expect(result.success).toBe(true);
    expect(result.penaltyApplied).toBe(10);
    expect(result.completedLate).toBe(true);
    expect(result.pointsAwardedTotal).toBe(20);

    const ledger = ledgerWrites('step-late');
    expect(ledger).toHaveLength(1);
    expect(ledger[0].data.points_awarded).toBe(20);
    expect(ledger[0].data.penalty_applied).toBe(10);
    expect(ledger[0].data.completed_late).toBe(true);
  });

  test('direct completion with no submission, after the deadline: completion instant decides, penalty applies', async () => {
    const result = await executeGamificationTransaction(
      'plain-direct',
      { status: 'completed' },
      { status: 'pending' },
      'founder-uid'
    );

    expect(result.success).toBe(true);
    expect(result.penaltyApplied).toBe(10);
    expect(result.completedLate).toBe(true);
    expect(result.pointsAwardedTotal).toBe(20);
  });
});
