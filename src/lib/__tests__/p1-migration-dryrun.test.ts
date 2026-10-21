/**
 * Phase 1 Workstream M - migration dry-run on fixtures (spec M.9, adapted
 * to the snapshot/plan core) and the mandatory apply-gate refusal (T05).
 */
import {
  buildPlan,
  assertApplyAllowed,
  type Snapshot,
} from '../../../scripts/phase1-migration/migrate-roles';
import { dispositionFor } from '../../../scripts/phase1-migration/remap-table';
import { FOUNDER_UID } from '@/config/founder';
import { isFounderUid } from '@/config/founder';

function snapshot(users: Snapshot['users']): Snapshot {
  return {
    takenAt: '2026-10-21T00:00:00.000Z',
    authUserCount: users.length,
    users,
    roleDefinitionsSlugs: [],
    permissionsSlugs: [],
    termEvidence: { applicationsCount: 0, withTermsEvidence: 0 },
  };
}

describe('migration dispositions', () => {
  it('treasurer maps to chapter_treasurer via block1; superadmin to CTO', () => {
    expect(dispositionFor('treasurer', 'u1', isFounderUid)).toMatchObject({
      kind: 'map', target: 'chapter_treasurer', via: 'block1',
    });
    expect(dispositionFor('superadmin', 'u1', isFounderUid)).toMatchObject({
      kind: 'map', target: 'chief_technology_officer',
    });
  });

  it('admin is founder handling on the founder uid, floor elsewhere', () => {
    expect(dispositionFor('admin', FOUNDER_UID, isFounderUid)).toMatchObject({ kind: 'founder-admin' });
    expect(dispositionFor('admin', 'u2', isFounderUid)).toMatchObject({ kind: 'fallback' });
  });

  it('invented tokens are manual; statuses and none are the member_basic floor', () => {
    expect(dispositionFor('national_vp_operations', 'u1', isFounderUid).kind).toBe('manual');
    expect(dispositionFor('team_member', 'u1', isFounderUid).kind).toBe('manual');
    expect(dispositionFor('none', 'u1', isFounderUid)).toMatchObject({ kind: 'fallback', target: 'member_basic' });
    expect(dispositionFor(null, 'u1', isFounderUid)).toMatchObject({ kind: 'fallback', target: 'member_basic' });
  });

  it('abolished keys carry the branch disposition with their Block 1 target', () => {
    expect(dispositionFor('chair_projects', 'u1', isFounderUid)).toMatchObject({
      kind: 'abolished-branch', block1Target: 'chapter_projects_chair',
    });
  });
});

describe('migration plan (fixtures)', () => {
  const snap = snapshot([
    {
      uid: 'legacy-treasurer',
      rolesDoc: { role: 'treasurer', chapterId: 'seds-ist-chapter' },
      usersDoc: { role: 'treasurer', displayRole: 'treasurer', chapterId: 'seds-ist-chapter' },
      claimsRole: 'treasurer',
    },
    {
      uid: 'manual-holder',
      rolesDoc: { role: 'national_vp_operations', chapterId: 'seds-ist-chapter' },
      usersDoc: { role: 'national_vp_operations', displayRole: 'national_vp_operations', chapterId: 'seds-ist-chapter' },
      claimsRole: null,
    },
    {
      uid: 'bootstrap-user',
      rolesDoc: null,
      usersDoc: { role: 'member', displayRole: 'member', chapterId: null },
      claimsRole: null,
    },
    {
      uid: 'stale-claim-user',
      rolesDoc: null,
      usersDoc: { role: 'chapter_president', displayRole: 'chapter_president', chapterId: 'seds-ist-chapter' },
      claimsRole: 'chapter_president',
    },
    {
      uid: 'abolished-holder',
      rolesDoc: { role: 'vice_president', chapterId: null },
      usersDoc: { role: 'vice_president', displayRole: 'vice_president', chapterId: null },
      claimsRole: null,
    },
    {
      uid: FOUNDER_UID,
      rolesDoc: { role: 'superadmin', chapterId: 'seds-ist-chapter' },
      usersDoc: { role: 'admin', displayRole: 'admin', chapterId: 'seds-ist-chapter' },
      claimsRole: null,
    },
  ]);

  it('a legacy token produces a roles.set plan to the catalog target', () => {
    const plan = buildPlan(snap, { runId: 'fixture-run' });
    const entry = plan.entries.find((e) => e.uid === 'legacy-treasurer');
    const set = entry?.actions.find((a) => a.type === 'roles.set');
    expect(set).toBeDefined();
    if (set?.type === 'roles.set') {
      expect(set.doc.role).toBe('chapter_treasurer');
      expect(set.doc.schemaVersion).toBe(2);
    }
    expect(plan.totals.storedTokensRemapped).toBeGreaterThanOrEqual(1);
  });

  it('a manual-census holder is report-only with no writes planned', () => {
    const plan = buildPlan(snap, { runId: 'fixture-run' });
    const entry = plan.entries.find((e) => e.uid === 'manual-holder');
    expect(entry?.actions.every((a) => a.type === 'report-only')).toBe(true);
    expect(entry?.manualTokens).toContain('national_vp_operations');
    expect(plan.totals.manualCensusCount).toBe(1);
  });

  it('bootstrap and stale-claim users split correctly', () => {
    const plan = buildPlan(snap, { runId: 'fixture-run' });
    expect(plan.totals.usersOnlyBootstrapCount).toBe(1);
    expect(plan.totals.usersOnlyCount).toBe(1);
    const boot = plan.entries.find((e) => e.uid === 'bootstrap-user');
    expect(boot?.actions.some((a) => a.type === 'roles.set')).toBe(true);
    const stale = plan.entries.find((e) => e.uid === 'stale-claim-user');
    expect(stale?.actions.every((a) => a.type === 'report-only')).toBe(true);
  });

  it('the abolished holder is reported under BOTH ruling outcomes and planned report-only while the branch is unset', () => {
    const plan = buildPlan(snap, { runId: 'fixture-run' });
    expect(plan.abolishedOutcomes.branchA.perKey.vice_president).toEqual({
      holders: 1, target: 'national_vice_president',
    });
    expect(plan.abolishedOutcomes.branchB.perKey.vice_president).toEqual({ holders: 1 });
    const entry = plan.entries.find((e) => e.uid === 'abolished-holder');
    expect(entry?.actions.every((a) => a.type === 'report-only')).toBe(true);
  });

  it('with branch A recorded, the abolished holder plans a remap', () => {
    const plan = buildPlan(snap, { runId: 'fixture-run', abolishedBranch: 'A' });
    const entry = plan.entries.find((e) => e.uid === 'abolished-holder');
    const set = entry?.actions.find((a) => a.type === 'roles.set');
    if (set?.type === 'roles.set') expect(set.doc.role).toBe('national_vice_president');
    else throw new Error('expected a roles.set action under branch A');
  });

  it('the founder record is report-only and both variants are described', () => {
    const plan = buildPlan(snap, { runId: 'fixture-run' });
    const entry = plan.entries.find((e) => e.uid === FOUNDER_UID);
    expect(entry?.actions.every((a) => a.type === 'report-only')).toBe(true);
    expect(plan.founderVariants.A.resultingRolesDoc.role).toBe('founder_patron');
    expect(plan.founderVariants.A.resultingRolesDoc.additionalRoles).toEqual(['chief_technology_officer']);
    expect(plan.founderVariants.B.resultingRolesDoc.role).toBe('chief_technology_officer');
  });

  it('users with no chapterId are counted', () => {
    const plan = buildPlan(snap, { runId: 'fixture-run' });
    expect(plan.totals.usersWithNoChapterId).toBe(2); // bootstrap-user + abolished-holder
  });
});

describe('apply gate (T05, mandatory)', () => {
  it('refuses while the abolished branch is unset, naming the gate', () => {
    expect(() =>
      assertApplyAllowed({
        abolishedBranch: null,
        founderVariant: 'A',
        confirmApply: 'run-1',
        runId: 'run-1',
      }),
    ).toThrow(/APPLY REFUSED.*abolished-key ruling branch/);
  });

  it('refuses while the founder variant is unset', () => {
    expect(() =>
      assertApplyAllowed({
        abolishedBranch: 'A',
        founderVariant: null,
        confirmApply: 'run-1',
        runId: 'run-1',
      }),
    ).toThrow(/founder record variant/);
  });

  it('refuses on a mismatched confirmation', () => {
    expect(() =>
      assertApplyAllowed({
        abolishedBranch: 'B',
        founderVariant: 'B',
        confirmApply: 'run-2',
        runId: 'run-1',
      }),
    ).toThrow(/does not match/);
  });

  it('passes only when every gate is recorded', () => {
    expect(() =>
      assertApplyAllowed({
        abolishedBranch: 'A',
        founderVariant: 'A',
        confirmApply: 'run-1',
        runId: 'run-1',
      }),
    ).not.toThrow();
  });
});
