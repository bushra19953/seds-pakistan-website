/**
 * Regression test for the Internal Server Error when an admin marks a
 * workflow task Completed via the Edit Task form
 * (src/app/api/tasks/route.ts -> executeGamificationTransaction).
 *
 * Root cause: in the Auto-Handoff Workflow Next Step branch of
 * src/lib/server/gamification-transaction.ts, the per-participant
 * notification was built with
 *   link: isNext ? `/profile/...` : undefined
 * and passed to Transaction.set(). Firestore rejects undefined field
 * values, so the whole transaction threw whenever a workflow had a
 * participant who was NOT the next step's assignee. Saving the same task
 * as Pending skipped the transaction entirely, which is why only
 * completing the task 500ed.
 *
 * This test runs the REAL executeGamificationTransaction against a fake
 * Firestore that enforces the real SDK rule (set/update with any
 * undefined value throws), proving the completion path no longer throws.
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
  'tasks/task-a': {
    title: 'Deliverable A: The 60-90s Executive Briefing Cut (Deans & ORIC)',
    status: 'pending',
    assigneeIds: ['maira-uid', 'yahya-uid'],
    assigneeId: 'maira-uid',
    workflowId: 'wf-1',
    workflowTitle: 'Produce China Aerospace Sourcing Bridge Executive Briefing & Social Launch Videos',
    workflowParticipantIds: ['maira-uid', 'yahya-uid'],
    sequenceIndex: 0,
    points: 4,
    workflowBonusPoints: 10,
  },
  'tasks/task-b': {
    title: 'Deliverable B: The 30-45s Social Recruitment Teaser (Mobile Vertical)',
    status: 'pending',
    assigneeIds: ['yahya-uid'],
    assigneeId: 'yahya-uid',
    workflowId: 'wf-1',
    workflowTitle: 'Produce China Aerospace Sourcing Bridge Executive Briefing & Social Launch Videos',
    workflowParticipantIds: ['maira-uid', 'yahya-uid'],
    sequenceIndex: 1,
    points: 3,
  },
  'tasks/task-final': {
    title: 'Final Step',
    status: 'pending',
    assigneeIds: ['maira-uid'],
    assigneeId: 'maira-uid',
    workflowId: 'wf-final',
    workflowTitle: 'Final Workflow',
    workflowParticipantIds: ['maira-uid', 'yahya-uid'],
    sequenceIndex: 0,
    points: 4,
    workflowBonusPoints: 10,
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

import { executeGamificationTransaction } from '../gamification-transaction';

describe('executeGamificationTransaction workflow completion', () => {
  beforeEach(() => {
    written.length = 0;
  });

  test('completing a non-final workflow step with a non-next participant does not throw', async () => {
    // Deliverable A (seq 0) completes; next step is Deliverable B (assignee
    // Yahya). Maira is a participant but NOT the next assignee, so her
    // handoff notification must not carry an undefined link.
    const result = await executeGamificationTransaction(
      'task-a',
      { status: 'completed' },
      { status: 'pending' },
      'admin-uid'
    );

    expect(result.success).toBe(true);

    // The task itself was marked completed inside the transaction.
    const taskUpdate = written.find((w) => w.op === 'update' && w.path === 'tasks/task-a');
    expect(taskUpdate).toBeDefined();
    expect(taskUpdate!.data.status).toBe('completed');

    // Next step was released.
    const nextUpdate = written.find((w) => w.op === 'update' && w.path === 'tasks/task-b');
    expect(nextUpdate).toBeDefined();
    expect(nextUpdate!.data.isCurrentStep).toBe(true);

    // Both participants got a handoff notification; neither carries an
    // undefined link (the fake Firestore would have thrown otherwise).
    const notifs = written.filter((w) => w.op === 'set' && w.path.includes('/notifications/'));
    const handoffNotifs = notifs.filter(
      (w) => w.data.type === 'task_assigned' || w.data.type === 'task_status_change'
    );
    expect(handoffNotifs.length).toBe(2);
    for (const n of handoffNotifs) {
      expect(n.data).not.toHaveProperty('link', undefined);
    }
    // The next assignee (Yahya) keeps a link; the other participant does not.
    const nextNotif = handoffNotifs.find((w) => w.data.type === 'task_assigned');
    expect(nextNotif).toBeDefined();
    expect(typeof nextNotif!.data.link).toBe('string');
    const otherNotif = handoffNotifs.find((w) => w.data.type === 'task_status_change');
    expect(otherNotif).toBeDefined();
    expect(otherNotif!.data).not.toHaveProperty('link');
  });

  test('completing the final workflow step does not throw', async () => {
    const result = await executeGamificationTransaction(
      'task-final',
      { status: 'completed' },
      { status: 'pending' },
      'admin-uid'
    );
    expect(result.success).toBe(true);
    const taskUpdate = written.find((w) => w.op === 'update' && w.path === 'tasks/task-final');
    expect(taskUpdate).toBeDefined();
    expect(taskUpdate!.data.status).toBe('completed');
  });
});
