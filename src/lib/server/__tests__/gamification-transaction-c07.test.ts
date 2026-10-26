/**
 * @jest-environment node
 *
 * C-07 pins for the converted pinned transaction
 * (src/lib/server/gamification-transaction.ts):
 * - GAP-N1 residual #1: the THREE notification sites (per-assignee,
 *   delegatee, workflow handoff) mirror post-commit in EVERY flag
 *   mode (the mirror seam itself is notifications-gated).
 * - OFF (primary false): Firestore writes are exactly the pre-cutover
 *   ones — points_ledger rows and user increments present, and the
 *   seam's RPC entry point is never called.
 * - ON (primary true): ledger-bearing awards leave Firestore entirely
 *   (no points_ledger writes, no points increments; only the workload
 *   release stays) and are claimed once per recipient via the seam.
 */

const mockState = {
  primary: false,
  awards: [] as any[],
  mirrors: [] as any[],
};

jest.mock('@/lib/supa/flags', () => ({
  isSupaPrimary: jest.fn(() => mockState.primary),
}));

jest.mock('@/lib/supa/gamification', () => ({
  applyPointsAwardViaSupa: jest.fn(async (input: any) => {
    mockState.awards.push(input);
    return { applied: true, duplicate: false, ledgerId: 'pa_sim', newTotalPoints: input.points };
  }),
}));

jest.mock('@/lib/server/notifications-supa-seam', () => ({
  mirrorNotificationCreate: jest.fn(async (path: string, id: string, data: any) => {
    mockState.mirrors.push({ path, id, data });
    return true;
  }),
  userNotificationsPath: (uid: string) => `users/${uid}/notifications`,
}));

const written: Array<{ op: string; path: string; data?: any }> = [];
let genCounter = 0;

const store: Record<string, any> = {
  'tasks/task-del': {
    title: 'Delegated Task', status: 'pending',
    assigneeIds: ['delegator-uid'], assigneeId: 'delegator-uid',
    points: 20,
    delegation: { status: 'accepted', delegatedTo: 'worker-uid', pointsKept: 12, pointsShared: 8 },
  },
  'tasks/task-wf': {
    title: 'Step One', status: 'pending',
    assigneeIds: ['p1'], assigneeId: 'p1', points: 5,
    workflowId: 'wf-9', workflowTitle: 'Flow', sequenceIndex: 0,
    workflowParticipantIds: ['p1', 'p2'],
  },
  'tasks/task-wf2': {
    title: 'Step Two', status: 'pending',
    assigneeId: 'p2', workflowId: 'wf-9', sequenceIndex: 1,
  },
};

function makeDocRef(collectionName: string, docId: string): any {
  const path = `${collectionName}/${docId}`;
  return {
    __kind: 'doc', id: docId, path,
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
        .filter(([p]) => { const parts = p.split('/'); return parts.length === 2 && parts[0] === collectionName; })
        .filter(([, data]) => filters.every((f) => f.op === '==' && (data as any)[f.field] === f.val))
        .slice(0, limitN ?? Number.POSITIVE_INFINITY)
        .map(([p, data]) => { const id = p.split('/')[1]; return { id, ref: makeDocRef(collectionName, id), data: () => data }; });
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
  set: (ref: any, data: any) => { written.push({ op: 'set', path: ref.path, data }); },
  update: (ref: any, data: any) => { written.push({ op: 'update', path: ref.path, data }); },
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
    admin: { firestore: { Timestamp: { now: () => ({ __ts: 'now', toDate: () => new Date() }) }, FieldValue } },
    getDb: () => mockDb,
  };
});

import { executeGamificationTransaction } from '../gamification-transaction';

beforeEach(() => {
  written.length = 0;
  mockState.awards.length = 0;
  mockState.mirrors.length = 0;
  mockState.primary = false;
});

describe('GAP-N1 residual #1: notification mirroring at the 3 converted sites', () => {
  it('site 1 (assignee) + site 2 (delegatee) mirror post-commit, OFF mode', async () => {
    const res = await executeGamificationTransaction('task-del', { status: 'completed' }, {}, 'admin-uid');
    expect(res.success).toBe(true);
    const byType = mockState.mirrors.map((m) => `${m.path}|${m.data.title}`);
    expect(mockState.mirrors).toHaveLength(2);
    expect(byType.some((s: string) => s.startsWith('users/delegator-uid/notifications|Task Approved'))).toBe(true);
    expect(byType.some((s: string) => s.startsWith('users/worker-uid/notifications|Delegated Task Completed'))).toBe(true);
    // Mirror ids are the Firestore notification doc ids (same rows).
    const notifWrites = written.filter((w) => w.path.includes('/notifications/'));
    expect(notifWrites).toHaveLength(2);
  });

  it('site 3 (workflow handoff) mirrors for every target, OFF mode', async () => {
    const res = await executeGamificationTransaction('task-wf', { status: 'completed' }, {}, 'admin-uid');
    expect(res.success).toBe(true);
    // 1 assignee approval (site 1) + 2 handoff notifications (site 3).
    expect(mockState.mirrors).toHaveLength(3);
    const handoff = mockState.mirrors.filter((m) => m.data.type === 'task_assigned' || m.data.type === 'task_status_change');
    expect(handoff).toHaveLength(2);
    expect(handoff.map((m) => m.path).sort()).toEqual([
      'users/p1/notifications', 'users/p2/notifications',
    ]);
  });
});

describe('OFF byte-identity (primary false)', () => {
  it('delegated completion writes Firestore ledger + increments, seam never called', async () => {
    await executeGamificationTransaction('task-del', { status: 'completed' }, {}, 'admin-uid');
    expect(mockState.awards).toEqual([]);
    const ledgerWrites = written.filter((w) => w.path.startsWith('points_ledger/'));
    expect(ledgerWrites).toHaveLength(2); // delegator + delegatee
    const delegatorWrite = written.find((w) => w.path === 'users/delegator-uid');
    expect(delegatorWrite!.data.total_points).toEqual({ __fv: 'increment', n: 12 });
  });
});

describe('ON converted path (primary true)', () => {
  beforeEach(() => { mockState.primary = true; });

  it('awards are claimed via the seam once per recipient; Firestore keeps no ledger/points writes', async () => {
    const res = await executeGamificationTransaction('task-del', { status: 'completed' }, {}, 'admin-uid');
    expect(res.success).toBe(true);
    expect(mockState.awards).toEqual([
      expect.objectContaining({ taskId: 'task-del', userId: 'delegator-uid', action: 'COMPLETION', reason: 'task_completion_delegator', points: 12, countCompletion: true }),
      expect.objectContaining({ taskId: 'task-del', userId: 'worker-uid', action: 'COMPLETION', reason: 'task_completion_delegatee', points: 8, countCompletion: true }),
    ]);
    expect(written.filter((w) => w.path.startsWith('points_ledger/'))).toEqual([]);
    const userWrites = written.filter((w) => w.path === 'users/delegator-uid' || w.path === 'users/worker-uid');
    for (const w of userWrites) {
      expect(w.data).not.toHaveProperty('total_points');
      expect(w.data).not.toHaveProperty('points');
    }
    // Only the workload release stays for the delegator.
    const delegatorWrite = written.find((w) => w.path === 'users/delegator-uid');
    expect(delegatorWrite!.data).toEqual({ tasksAssignedCount: { __fv: 'increment', n: -1 } });
    // Notifications still write + mirror on the converted path.
    expect(mockState.mirrors).toHaveLength(2);
  });
});
