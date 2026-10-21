import {
  instanceDocId,
  planSeedRun,
  shouldSkipExistingInstance,
  type ExistingInstance,
} from '../loader-core';
import { FY2026_27_INSTANCES } from '../seed-data';

const clean: ExistingInstance = {
  evidence: null,
  status: 'scheduled',
  ownerUidSnapshot: null,
  hasDefaultNotice: false,
};

describe('shouldSkipExistingInstance (never-overwrite guard matrix)', () => {
  it('no existing instance -> never skip', () => {
    expect(shouldSkipExistingInstance(null)).toEqual({ skip: false });
  });

  it('untouched scheduled instance -> no skip', () => {
    expect(shouldSkipExistingInstance(clean).skip).toBe(false);
    expect(shouldSkipExistingInstance({ ...clean, status: 'reminded_14' }).skip).toBe(false);
  });

  it('evidence present -> skip', () => {
    const out = shouldSkipExistingInstance({ ...clean, evidence: { ref: 'x' } });
    expect(out).toEqual({ skip: true, reason: 'evidence-present' });
  });

  it('status advanced beyond reminded_* -> skip', () => {
    for (const status of ['due', 'under_review', 'completed', 'overdue', 'cure_period']) {
      const out = shouldSkipExistingInstance({ ...clean, status });
      expect(out.skip).toBe(true);
      expect(out.reason).toBe(`status-advanced:${status}`);
    }
  });

  it('owner resolved -> skip', () => {
    const out = shouldSkipExistingInstance({ ...clean, ownerUidSnapshot: 'uid-1' });
    expect(out).toEqual({ skip: true, reason: 'owner-resolved' });
  });

  it('default notice exists -> skip', () => {
    const out = shouldSkipExistingInstance({ ...clean, hasDefaultNotice: true });
    expect(out).toEqual({ skip: true, reason: 'default-notice-exists' });
  });
});

describe('planSeedRun', () => {
  it('empty database -> creates all 34 templates and all 39 instances, no waivers by default', () => {
    const plan = planSeedRun({
      existingTemplateKeys: new Set(),
      existingInstances: new Map(),
      waiveOctober2026: false,
    });
    expect(plan.templateCreates).toHaveLength(34);
    expect(plan.templateSkips).toHaveLength(0);
    expect(plan.instanceCreates).toHaveLength(39);
    expect(plan.instanceSkips).toHaveLength(0);
    expect(plan.waiverDocIds).toHaveLength(0);
  });

  it('idempotency: a fully seeded database produces zero creates on re-run', () => {
    const all = new Map<string, ExistingInstance>();
    for (const seed of FY2026_27_INSTANCES) all.set(instanceDocId(seed), { ...clean });
    const plan = planSeedRun({
      existingTemplateKeys: new Set(FY2026_27_INSTANCES.map((s) => s.templateKey)),
      existingInstances: all,
      waiveOctober2026: false,
    });
    // Templates already present are skipped by key; creates are zero.
    expect(plan.templateCreates).toHaveLength(0);
    expect(plan.instanceCreates).toHaveLength(0);
  });

  it('guarded instances are reported skipped-guarded, never recreated', () => {
    const map = new Map<string, ExistingInstance>();
    const target = FY2026_27_INSTANCES[0];
    map.set(instanceDocId(target), { ...clean, evidence: { ref: 'proof' } });
    const plan = planSeedRun({
      existingTemplateKeys: new Set(),
      existingInstances: map,
      waiveOctober2026: false,
    });
    expect(plan.instanceCreates).toHaveLength(38);
    expect(plan.instanceSkips).toEqual([
      { instanceKey: target.instanceKey, reason: 'evidence-present' },
    ]);
  });

  it('--waive-october-2026 waives exactly 3 instances', () => {
    const plan = planSeedRun({
      existingTemplateKeys: new Set(),
      existingInstances: new Map(),
      waiveOctober2026: true,
    });
    expect(plan.waiverDocIds).toHaveLength(3);
    expect(new Set(plan.waiverDocIds).size).toBe(3);
    expect(plan.waiverDocIds).toContain('board-meeting__FY27__Q1');
    expect(plan.waiverDocIds).toContain('bank-reconciliation__FY27__2026-10');
    expect(plan.waiverDocIds).toContain('elections-timetable__FY27__annual');
  });

  it('a guarded October instance is NOT waived (guard beats the variant)', () => {
    const map = new Map<string, ExistingInstance>();
    const bankOct = FY2026_27_INSTANCES.find(
      (s) => s.instanceKey === 'fy2026-27:bank-reconciliation:2026-10-15',
    )!;
    map.set(instanceDocId(bankOct), { ...clean, evidence: { ref: 'x' } });
    const plan = planSeedRun({
      existingTemplateKeys: new Set(),
      existingInstances: map,
      waiveOctober2026: true,
    });
    expect(plan.waiverDocIds).toHaveLength(2);
    expect(plan.waiverDocIds).not.toContain(instanceDocId(bankOct));
  });
});
