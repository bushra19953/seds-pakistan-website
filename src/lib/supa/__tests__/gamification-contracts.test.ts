/**
 * @jest-environment node
 *
 * Cluster Q contract tests: src/lib/supa/gamification.ts
 * - points RPC idempotency: double-apply = single ledger effect
 * - ledger invariants (validateLedgerEntry)
 * - flag OFF / unconfigured / pre-claim error => null (Firestore fallback)
 * - post-claim error => partial-claim (never null: fallback would double-pay)
 * - split maths + leaderboard shaping parity with the Firestore shapes
 *
 * Zero live Supabase / Firestore: an in-memory adapter implements the
 * SupaAdapter surface over Maps.
 */

const mockState = { flagOn: true, clientPresent: true };

jest.mock('@/lib/supa', () => ({
  useSupa: jest.fn(() => mockState.flagOn),
  getSupaClient: jest.fn(() => (mockState.clientPresent ? {} : null)),
  getSupaAdapter: jest.fn(() => { throw new Error('tests must pass an adapter override'); }),
}));

import {
  applyPointsAwardViaSupa,
  computePointsToAward,
  pointsAwardLedgerId,
  shapeLeaderboardRow,
  validateLedgerEntry,
} from '@/lib/supa/gamification';
import type { SupaAdapter } from '@/lib/supa';

function makeFakeAdapter(failOn?: string) {
  const store = new Map<string, Map<string, Record<string, any>>>();
  const coll = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  };
  const adapter = {
    async getDoc(collectionPath: string, id: string) {
      if (failOn === 'getDoc') throw new Error('adapter boom');
      const doc = coll(collectionPath).get(id);
      return doc ? { id, ...structuredClone(doc) } : null;
    },
    async listDocs() { return []; },
    async countDocs() { return 0; },
    async setDoc(collectionPath: string, id: string, data: Record<string, any>, options?: { merge?: boolean }) {
      if (failOn === `setDoc:${collectionPath}`) throw new Error('adapter boom');
      const existing = coll(collectionPath).get(id) || {};
      const next = options?.merge ? { ...existing, ...data } : { ...data };
      coll(collectionPath).set(id, structuredClone(next));
      return { id, ...next };
    },
    async updateDoc(collectionPath: string, id: string, updates: Record<string, any>) {
      if (failOn === `updateDoc:${collectionPath}`) throw new Error('adapter boom');
      const existing = coll(collectionPath).get(id);
      if (!existing) throw new Error(`updateDoc on missing ${collectionPath}/${id}`);
      const next = { ...existing, ...updates };
      coll(collectionPath).set(id, next);
      return { id, ...next };
    },
    async deleteDoc(collectionPath: string, id: string) { coll(collectionPath).delete(id); },
  } as unknown as SupaAdapter;
  return { adapter, store };
}

const award = {
  taskId: 'task-1', userId: 'user-1', action: 'COMPLETION', points: 50,
  reason: 'task_completion', countCompletion: true, onTime: true,
  timestampIso: '2026-10-25T00:00:00.000Z',
};

beforeEach(() => {
  mockState.flagOn = true;
  mockState.clientPresent = true;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('idempotency key', () => {
  it('is deterministic across callers for the same award event', () => {
    expect(pointsAwardLedgerId(award)).toBe(pointsAwardLedgerId({ ...award }));
    expect(pointsAwardLedgerId(award)).toBe('pa_task-1_user-1_COMPLETION');
  });
  it('differs per user / action / task, sanitizes unsafe chars, null user = chapter', () => {
    expect(pointsAwardLedgerId({ ...award, userId: 'user-2' })).not.toBe(pointsAwardLedgerId(award));
    expect(pointsAwardLedgerId({ ...award, action: 'PENALTY' })).not.toBe(pointsAwardLedgerId(award));
    expect(pointsAwardLedgerId({ taskId: 't/1', userId: 'u 1', action: 'A' })).toBe('pa_t_1_u_1_A');
    expect(pointsAwardLedgerId({ taskId: 't', userId: null, action: 'COMPLETION' })).toBe('pa_t_chapter_COMPLETION');
  });
});

describe('points RPC idempotency (double-apply = single ledger effect)', () => {
  it('second identical apply is a duplicate: counters and ledger unchanged', async () => {
    const { adapter, store } = makeFakeAdapter();
    const first = await applyPointsAwardViaSupa(award, adapter);
    expect(first).toEqual({ applied: true, duplicate: false, ledgerId: 'pa_task-1_user-1_COMPLETION', newTotalPoints: 50 });

    const second = await applyPointsAwardViaSupa(award, adapter);
    expect(second).toEqual({ applied: false, duplicate: true, ledgerId: 'pa_task-1_user-1_COMPLETION' });

    const user = store.get('users')!.get('user-1')!;
    expect(user.total_points).toBe(50);
    expect(user.points).toBe(50);
    expect(user.tasksCompletedCount).toBe(1);
    expect(user.tasksCompletedOnTimeCount).toBe(1);
    expect(store.get('points_ledger')!.size).toBe(1);
    const ledger = store.get('points_ledger')!.get('pa_task-1_user-1_COMPLETION')!;
    expect(ledger.status).toBe('PROCESSED');
    expect(ledger.points_awarded).toBe(50);
    expect(validateLedgerEntry(ledger)).toEqual([]);
  });

  it('distinct users for the same task each get their own award (per-user key)', async () => {
    const { adapter, store } = makeFakeAdapter();
    await applyPointsAwardViaSupa(award, adapter);
    const other = await applyPointsAwardViaSupa({ ...award, userId: 'user-2' }, adapter);
    expect(other?.applied).toBe(true);
    expect(store.get('points_ledger')!.size).toBe(2);
  });

  it('sum of user totals always equals sum of PROCESSED ledger points (invariant)', async () => {
    const { adapter, store } = makeFakeAdapter();
    await applyPointsAwardViaSupa(award, adapter);
    await applyPointsAwardViaSupa({ ...award, taskId: 'task-2', points: 30 }, adapter);
    await applyPointsAwardViaSupa(award, adapter); // duplicate, no effect
    const ledgerSum = [...store.get('points_ledger')!.values()]
      .filter((l) => l.status === 'PROCESSED').reduce((s, l) => s + l.points_awarded, 0);
    expect(store.get('users')!.get('user-1')!.total_points).toBe(ledgerSum);
    expect(ledgerSum).toBe(80);
  });

  it('collective award credits the chapter, keyed with the chapter segment', async () => {
    const { adapter, store } = makeFakeAdapter();
    const res = await applyPointsAwardViaSupa(
      { taskId: 'task-9', userId: null, chapterId: 'ist', action: 'COMPLETION', points: 20 }, adapter);
    expect(res?.applied).toBe(true);
    expect(store.get('chapters')!.get('ist')).toMatchObject({ collective_score: 20, tasks_completed: 1 });
  });

  it('badges union without duplication across awards', async () => {
    const { adapter, store } = makeFakeAdapter();
    await applyPointsAwardViaSupa({ ...award, badgeIds: ['b1'] }, adapter);
    await applyPointsAwardViaSupa({ ...award, taskId: 'task-2', badgeIds: ['b1', 'b2'] }, adapter);
    expect(store.get('users')!.get('user-1')!.badges).toEqual(['b1', 'b2']);
  });
});

describe('flag / fallback parity', () => {
  it('flag OFF => null (caller serves Firestore byte-identically)', async () => {
    mockState.flagOn = false;
    await expect(applyPointsAwardViaSupa(award)).resolves.toBeNull();
  });
  it('flag ON but no client => null', async () => {
    mockState.clientPresent = false;
    await expect(applyPointsAwardViaSupa(award)).resolves.toBeNull();
  });
  it('post-claim failure => partial-claim result, never null', async () => {
    const { adapter, store } = makeFakeAdapter('setDoc:users');
    const res = await applyPointsAwardViaSupa(award, adapter);
    expect(res).toMatchObject({ applied: false, duplicate: false, partialClaim: true });
    // The claim survives visibly as CLAIMED (not PROCESSED) for recovery.
    expect(store.get('points_ledger')!.get('pa_task-1_user-1_COMPLETION')!.status).toBe('CLAIMED');
  });
});

describe('ledger invariants', () => {
  it('accepts a well-formed entry, rejects each broken field', () => {
    const ok = { task_id: 't', user_id: 'u', action: 'COMPLETION', points_awarded: 5, status: 'PROCESSED', idempotency_key: 'k' };
    expect(validateLedgerEntry(ok)).toEqual([]);
    expect(validateLedgerEntry({ ...ok, user_id: null })).toEqual([]); // collective
    expect(validateLedgerEntry({ ...ok, points_awarded: -1 })).not.toEqual([]);
    expect(validateLedgerEntry({ ...ok, points_awarded: Number.NaN })).not.toEqual([]);
    expect(validateLedgerEntry({ ...ok, task_id: '' })).not.toEqual([]);
    expect(validateLedgerEntry({ ...ok, status: 'DONE' })).not.toEqual([]);
    expect(validateLedgerEntry({ ...ok, idempotency_key: '' })).not.toEqual([]);
  });
});

describe('split maths (faithful to the pinned transaction)', () => {
  it('split floors per recipient; duplicate/collective pay full', () => {
    expect(computePointsToAward({ basePoints: 100, distributionMode: 'split', assignmentType: 'individual', assigneeCount: 3 })).toBe(33);
    expect(computePointsToAward({ basePoints: 100, distributionMode: 'duplicate', assignmentType: 'individual', assigneeCount: 3 })).toBe(100);
    expect(computePointsToAward({ basePoints: 100, distributionMode: 'split', assignmentType: 'collective', assigneeCount: 3 })).toBe(100);
    expect(computePointsToAward({ basePoints: 100, distributionMode: 'split', assignmentType: 'individual', assigneeCount: 0 })).toBe(100);
  });
});

describe('leaderboard shaping parity', () => {
  it('matches the Firestore route shape incl. defaults and badge cap', () => {
    const row = shapeLeaderboardRow({ id: 'u1', name: 'A', points: 7, badges: ['1', '2', '3', '4', '5', '6'] });
    expect(row.displayName).toBe('A');
    expect(row.points).toBe(7);
    expect(row.badges).toHaveLength(5);
    expect(row.role).toBeNull();
    expect(row.isOnVacation).toBe(false);
  });
});
