/**
 * @jest-environment node
 *
 * Gamification flip Phase 2 (2026-10-29) — B-GAME-1 conversion pins:
 * the apply_workflow_bonus seam (applyWorkflowBonusViaSupa).
 * - Claim id shape: pa_wf_<workflowId>_<userId>_WORKFLOW_BONUS
 *   (sanitized segments, same alphabet as the C-07 award ids).
 * - FLAG LAW: primary OFF (or no client) => null, rpc never called.
 * - Primary ON: one rpc under the name apply_workflow_bonus with the
 *   exact p_* argument contract; duplicate passes through untouched.
 * - Invariants (userId / workflowId non-empty, points finite >= 0)
 *   reject BEFORE the rpc; under an adapter override they throw.
 * - The SQL artifact itself is pinned for the B-GAME-1 shape:
 *   claim-first ON CONFLICT, workflowsCompletedCount, finalize to
 *   PROCESSED in the same function.
 *
 * Zero live Supabase / Firestore: mocked seam modules + fake adapters.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const mockState = { primary: false, clientPresent: true };
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const simLedger = new Set<string>();

function simRpc(fn: string, args: Record<string, any>) {
  rpcCalls.push({ fn, args });
  if (args.p_points > 0) {
    if (simLedger.has(args.p_ledger_id)) {
      return [{ applied: false, duplicate: true, new_total_points: null }];
    }
    simLedger.add(args.p_ledger_id);
  }
  return [{ applied: true, duplicate: false, new_total_points: args.p_points }];
}

jest.mock('@/lib/supa', () => ({
  useSupa: jest.fn(() => true),
  isSupaPrimary: jest.fn(() => mockState.primary),
  getSupaClient: jest.fn(() => (mockState.clientPresent ? {} : null)),
  getSupaAdapter: jest.fn(() => ({ rpc: simRpc })),
}));

import {
  applyWorkflowBonusViaSupa,
  workflowBonusLedgerId,
} from '@/lib/supa/gamification';

const bonus = {
  workflowId: 'wf-1', userId: 'user-1', points: 10, badgeId: 'final-badge',
  timestampIso: '2026-10-29T00:00:00.000Z',
};

beforeEach(() => {
  mockState.primary = false;
  mockState.clientPresent = true;
  rpcCalls.length = 0;
  simLedger.clear();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('workflow bonus claim id', () => {
  it('is pa_wf_<workflowId>_<userId>_WORKFLOW_BONUS, segments sanitized', () => {
    expect(workflowBonusLedgerId({ workflowId: 'wf-1', userId: 'user-1' }))
      .toBe('pa_wf_wf-1_user-1_WORKFLOW_BONUS');
    expect(workflowBonusLedgerId({ workflowId: 'wf/1 x', userId: 'u.2' }))
      .toBe('pa_wf_wf_1_x_u_2_WORKFLOW_BONUS');
  });
});

describe('flag law (OFF = today exactly)', () => {
  it('primary OFF => null, rpc never called', async () => {
    await expect(applyWorkflowBonusViaSupa(bonus)).resolves.toBeNull();
    expect(rpcCalls).toEqual([]);
  });

  it('primary ON but no client => null, rpc never called', async () => {
    mockState.primary = true;
    mockState.clientPresent = false;
    await expect(applyWorkflowBonusViaSupa(bonus)).resolves.toBeNull();
    expect(rpcCalls).toEqual([]);
  });
});

describe('converted path (primary ON)', () => {
  beforeEach(() => { mockState.primary = true; });

  it('invokes apply_workflow_bonus once with the exact p_* contract', async () => {
    const res = await applyWorkflowBonusViaSupa(bonus);
    expect(res).toEqual({
      applied: true, duplicate: false,
      ledgerId: 'pa_wf_wf-1_user-1_WORKFLOW_BONUS', newTotalPoints: 10,
    });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('apply_workflow_bonus');
    expect(rpcCalls[0].args).toEqual({
      p_ledger_id: 'pa_wf_wf-1_user-1_WORKFLOW_BONUS',
      p_user_id: 'user-1',
      p_workflow_id: 'wf-1',
      p_points: 10,
      p_badge_id: 'final-badge',
      p_timestamp: '2026-10-29T00:00:00.000Z',
    });
  });

  it('duplicate passes through: second identical call pays nothing', async () => {
    const first = await applyWorkflowBonusViaSupa(bonus);
    const second = await applyWorkflowBonusViaSupa(bonus);
    expect(first?.applied).toBe(true);
    expect(second).toEqual({
      applied: false, duplicate: true,
      ledgerId: 'pa_wf_wf-1_user-1_WORKFLOW_BONUS',
    });
    expect(simLedger.size).toBe(1);
  });

  it('badge-only call (points 0, no badge) defaults p_badge_id to null', async () => {
    const res = await applyWorkflowBonusViaSupa({ workflowId: 'wf-2', userId: 'u-9', points: 0 });
    expect(res?.applied).toBe(true);
    expect(rpcCalls[0].args.p_badge_id).toBeNull();
    expect(rpcCalls[0].args.p_points).toBe(0);
  });
});

describe('invariants under an adapter override (throw, rpc never reached)', () => {
  const explodingAdapter: any = {
    rpc: jest.fn(async () => { throw new Error('rpc must not be reached'); }),
  };

  it('rejects negative points', async () => {
    await expect(applyWorkflowBonusViaSupa({ ...bonus, points: -1 }, explodingAdapter))
      .rejects.toThrow(/points must be a finite number >= 0/);
    expect(explodingAdapter.rpc).not.toHaveBeenCalled();
  });

  it('rejects an empty userId', async () => {
    await expect(applyWorkflowBonusViaSupa({ ...bonus, userId: '' }, explodingAdapter))
      .rejects.toThrow(/userId missing/);
  });

  it('rejects an empty workflowId', async () => {
    await expect(applyWorkflowBonusViaSupa({ ...bonus, workflowId: '' }, explodingAdapter))
      .rejects.toThrow(/workflowId missing/);
  });

  it('rejects NaN points', async () => {
    await expect(applyWorkflowBonusViaSupa({ ...bonus, points: Number.NaN }, explodingAdapter))
      .rejects.toThrow(/points/);
  });
});

describe('SQL artifact contract (sql/apply_workflow_bonus.sql)', () => {
  const sql = readFileSync(join(__dirname, '..', 'sql', 'apply_workflow_bonus.sql'), 'utf8');

  it('defines the function with the seam parameter contract', () => {
    expect(sql).toMatch(/create or replace function apply_workflow_bonus\(/);
    for (const p of ['p_ledger_id text', 'p_user_id text', 'p_workflow_id text', 'p_points integer', 'p_badge_id text default null', 'p_timestamp timestamptz default now()']) {
      expect(sql).toContain(p);
    }
    expect(sql).toMatch(/returns table \(applied boolean, duplicate boolean, new_total_points integer\)/);
  });

  it('is claim-first: ledger insert ON CONFLICT DO NOTHING, duplicate returns before any counter write', () => {
    const body = sql.slice(sql.indexOf('create or replace function'));
    const claimIdx = body.indexOf('on conflict (id) do nothing');
    const countersIdx = body.indexOf('workflowsCompletedCount');
    expect(claimIdx).toBeGreaterThan(-1);
    expect(countersIdx).toBeGreaterThan(claimIdx);
    expect(sql).toContain("return query select false, true, null::integer");
  });

  it('increments points, total_points and workflowsCompletedCount only under the p_points > 0 guard', () => {
    expect(sql).toMatch(/if p_points > 0 then[\s\S]*'workflowsCompletedCount'/);
    expect(sql).toContain("'action', 'WORKFLOW_BONUS'");
    expect(sql).toContain("'workflowId', p_workflow_id");
  });

  it('finalizes the claim to PROCESSED in the same function and locks the user row FOR UPDATE', () => {
    expect(sql).toContain("jsonb_build_object('status', 'PROCESSED')");
    expect(sql).toMatch(/from fs_users where id = p_user_id for update/);
    expect(sql).toMatch(/insert into fs_users \(id, firebase_uid, parent_path, data\)/);
  });
});
