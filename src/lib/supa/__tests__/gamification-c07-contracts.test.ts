/**
 * @jest-environment node
 *
 * C-07 contract pins: the converted gamification award path.
 * - FLAG LAW: the RPC path runs only when isSupaPrimary('gamification')
 *   (BOTH SUPA_SURFACES and SUPA_PRIMARY carry the token). A surface
 *   token alone (today's live state) must return null — OFF equals
 *   today exactly.
 * - The rpc is invoked under the grandfathered name apply_points_award
 *   with the exact p_* argument contract from the foundation report.
 * - Claim-first idempotency: a double-award attempt pays ONCE
 *   (simulated SQL semantics over an in-memory store).
 *
 * Zero live Supabase / Firestore: mocked seam modules + in-memory rpc.
 */

const mockState = { useSupa: true, primary: false, clientPresent: true };
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

// In-memory simulation of sql/apply_points_award.sql semantics.
const simLedger = new Map<string, Record<string, any>>();
const simUsers = new Map<string, Record<string, any>>();
function simRpc(fn: string, args: Record<string, any>) {
  rpcCalls.push({ fn, args });
  if (simLedger.has(args.p_ledger_id)) {
    return [{ applied: false, duplicate: true, new_total_points: null }];
  }
  simLedger.set(args.p_ledger_id, {
    user_id: args.p_user_id, task_id: args.p_task_id, action: args.p_action,
    points_awarded: args.p_points, status: 'PROCESSED', idempotency_key: args.p_ledger_id,
  });
  let newTotal: number | null = null;
  if (args.p_user_id) {
    const user = { ...(simUsers.get(args.p_user_id) || {}) };
    newTotal = (user.total_points || 0) + args.p_points;
    user.total_points = newTotal;
    user.points = (user.points || 0) + args.p_points;
    simUsers.set(args.p_user_id, user);
  }
  return [{ applied: true, duplicate: false, new_total_points: newTotal }];
}

jest.mock('@/lib/supa', () => ({
  useSupa: jest.fn(() => mockState.useSupa),
  isSupaPrimary: jest.fn(() => mockState.primary),
  getSupaClient: jest.fn(() => (mockState.clientPresent ? {} : null)),
  getSupaAdapter: jest.fn(() => ({ rpc: simRpc })),
}));

import { applyPointsAwardViaSupa, pointsAwardLedgerId } from '@/lib/supa/gamification';

const award = {
  taskId: 'task-1', userId: 'user-1', action: 'COMPLETION', points: 50,
  reason: 'task_completion', countCompletion: true, onTime: true,
  timestampIso: '2026-10-26T00:00:00.000Z',
};

beforeEach(() => {
  mockState.useSupa = true;
  mockState.primary = false;
  mockState.clientPresent = true;
  rpcCalls.length = 0;
  simLedger.clear();
  simUsers.clear();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('C-07 flag law (OFF = today exactly)', () => {
  it('surface token alone (primary OFF) => null, rpc never called', async () => {
    mockState.useSupa = true;
    mockState.primary = false;
    await expect(applyPointsAwardViaSupa(award)).resolves.toBeNull();
    expect(rpcCalls).toEqual([]);
  });

  it('primary token alone (surface OFF) => null, rpc never called', async () => {
    mockState.useSupa = false;
    mockState.primary = false; // isSupaPrimary is false by construction here:
    // flags.ts computes primary = useSupa && token; the seam consumes
    // isSupaPrimary only, so this state is the same null.
    await expect(applyPointsAwardViaSupa(award)).resolves.toBeNull();
    expect(rpcCalls).toEqual([]);
  });

  it('primary ON but no client => null, rpc never called', async () => {
    mockState.primary = true;
    mockState.clientPresent = false;
    await expect(applyPointsAwardViaSupa(award)).resolves.toBeNull();
    expect(rpcCalls).toEqual([]);
  });
});

describe('C-07 converted path (primary ON)', () => {
  beforeEach(() => { mockState.primary = true; });

  it('invokes apply_points_award once with the exact foundation arg contract', async () => {
    const res = await applyPointsAwardViaSupa(award);
    expect(res).toEqual({
      applied: true, duplicate: false,
      ledgerId: 'pa_task-1_user-1_COMPLETION', newTotalPoints: 50,
    });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('apply_points_award');
    expect(rpcCalls[0].args).toEqual({
      p_ledger_id: pointsAwardLedgerId(award),
      p_user_id: 'user-1',
      p_chapter_id: null,
      p_task_id: 'task-1',
      p_action: 'COMPLETION',
      p_reason: 'task_completion',
      p_points: 50,
      p_count_completion: true,
      p_on_time: true,
      p_hours_worked: 0,
      p_badge_ids: [],
      p_timestamp: '2026-10-26T00:00:00.000Z',
    });
  });

  it('claim-first idempotency: a double-award attempt pays once', async () => {
    const first = await applyPointsAwardViaSupa(award);
    const second = await applyPointsAwardViaSupa(award);
    expect(first?.applied).toBe(true);
    expect(second).toEqual({ applied: false, duplicate: true, ledgerId: 'pa_task-1_user-1_COMPLETION' });
    expect(simUsers.get('user-1')!.total_points).toBe(50);
    expect(simLedger.size).toBe(1);
  });

  it('collective award passes user null + chapter through to the rpc', async () => {
    const res = await applyPointsAwardViaSupa(
      { taskId: 'task-9', userId: null, chapterId: 'ist', action: 'COMPLETION', points: 20 });
    expect(res?.applied).toBe(true);
    expect(rpcCalls[0].args.p_user_id).toBeNull();
    expect(rpcCalls[0].args.p_chapter_id).toBe('ist');
    expect(rpcCalls[0].args.p_ledger_id).toBe('pa_task-9_chapter_COMPLETION');
  });
});
