/**
 * Regression test: awarded points must equal the authorized amount.
 *
 * Bug scenario: Universal Inbox approval for "Deliverable B" (assignee
 * Yahya, ref YG2NEE1K). The review panel pre-fills POINTS TO AWARD = 10,
 * the task base points are 3, and Zubair authorized the maximum (10).
 * The awarded points must equal the authorized amount: 10, not the
 * base 3 and not 0. The points ledger entry must record 10.
 *
 * Root cause under test: src/lib/server/gamification-transaction.ts
 * computes the award from the task document base points
 * (task.points, here 3) and never reads the approver authorized amount
 * carried on updatesToApply.pointsAwarded. That is the same field name
 * the universal-review route and the submissions route already use for
 * awarded points, so the fix reads it here too.
 *
 * This test runs the REAL executeGamificationTransaction against a fake
 * Firestore, following the pattern in
 * src/lib/server/__tests__/gamification-transaction.test.ts. It is
 * expected to FAIL against the current unfixed code (award comes out
 * as 3), and to PASS once the transaction honors the authorized amount.
 */

const written: Array<{ op: string; path: string; data?: any }> = [];

// Mirror the real Firestore SDK: undefined field values are rejected.
function assertNoUndefined(value: any, fieldPath = ''): void {
  if (value === undefined) {
    throw new Error(
      `Function set() called with invalid data. Unsupported field value: undefined (found in field ${fieldPath || 'root'})`
    );
  }
  if (value === null || typeof value !== 'object') return;
  if (value instanceof Date) return;
  if (value.__fv !== undefined || value.__ts !== undefined) return; // FieldValue / Timestamp sentinels
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUndefined(v, `${fieldPath}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    assertNoUndefined(v, fieldPath ? `${fieldPath}.${k}` : k);
  }
}

let genCounter = 0;

// In-memory docs the fake Firestore serves (path -> data).
const store: Record<string, any> = {
  'tasks/task-deliverable-b': {
    title: 'Deliverable B: The 30-45s Social Recruitment Teaser (Mobile Vertical)',
    status: 'pending',
    assigneeIds: ['yahya-uid'],
    assigneeId: 'yahya-uid',
    // No workflowId on purpose: a standalone task keeps this test focused
    // on the award amount, with no handoff or workflow bonus in play.
    // Base points are 3. The approver authorized 10.
    points: 3,
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
  const q: any = {
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
  return q;
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
        Timestamp: { now: () => ({ __ts: 'now' }) },
        FieldValue,
      },
    },
    getDb: () => mockDb,
  };
});

import { executeGamificationTransaction } from '../server/gamification-transaction';

function ledgerCompletionEntries() {
  return written.filter(
    (w) => w.op === 'set' && w.path.startsWith('points_ledger/') && w.data.action === 'COMPLETION'
  );
}

describe('points award matches the authorized amount', () => {
  beforeEach(() => {
    written.length = 0;
  });

  test('authorized 10 points awards 10, not the base 3, and the ledger records 10', async () => {
    // Universal Inbox approval for Deliverable B (Yahya, ref YG2NEE1K):
    // panel pre-fills POINTS TO AWARD = 10, task base points are 3,
    // Zubair authorized the maximum, 10.
    const result = await executeGamificationTransaction(
      'task-deliverable-b',
      { status: 'approved', pointsAwarded: 10 },
      { status: 'pending' },
      'admin-uid'
    );

    expect(result.success).toBe(true);
    expect(result.pointsAwardedTotal).toBe(10);

    // Yahya's point balance grows by the authorized 10, not the base 3.
    const userWrite = written.find((w) => w.op === 'set' && w.path === 'users/yahya-uid');
    expect(userWrite).toBeDefined();
    expect(userWrite!.data.total_points).toEqual({ __fv: 'increment', n: 10 });
    expect(userWrite!.data.points).toEqual({ __fv: 'increment', n: 10 });

    // Exactly one COMPLETION ledger entry, recording the authorized 10.
    const ledgerEntries = ledgerCompletionEntries();
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0].data.user_id).toBe('yahya-uid');
    expect(ledgerEntries[0].data.task_id).toBe('task-deliverable-b');
    expect(ledgerEntries[0].data.points_awarded).toBe(10);
  });

  test('with no authorized override, the base task points still apply', async () => {
    // Guards the other direction: the fix must honor an override when one
    // is present, not replace the award with a hardcoded number.
    const result = await executeGamificationTransaction(
      'task-deliverable-b',
      { status: 'approved' },
      { status: 'pending' },
      'admin-uid'
    );

    expect(result.success).toBe(true);
    expect(result.pointsAwardedTotal).toBe(3);

    const userWrite = written.find((w) => w.op === 'set' && w.path === 'users/yahya-uid');
    expect(userWrite).toBeDefined();
    expect(userWrite!.data.total_points).toEqual({ __fv: 'increment', n: 3 });

    const ledgerEntries = ledgerCompletionEntries();
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0].data.points_awarded).toBe(3);
  });
});
