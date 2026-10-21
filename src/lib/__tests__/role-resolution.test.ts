/**
 * Phase 1 Workstream A - legacy map correction, abolished-key resolution,
 * superadmin retirement at the resolution layer, and XP derivation.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  resolveRole,
  resolveRoleForUid,
  normalizeToCanonical,
  normalizeRoleSlug,
  xpForRoles,
  xpOf,
  isCatalogRoleKey,
  ABOLISHED_KEYS,
} from '../role-catalog';
import { isFounderUid, FOUNDER_UID } from '@/config/founder';

const legacyFixture = JSON.parse(
  readFileSync(join(__dirname, '../../test-fixtures/phase1/legacy-tokens.json'), 'utf8'),
) as { block1: Record<string, string>; notMapped: string[]; abolished: string[] };

describe('legacy-map (Art. 12.1)', () => {
  it('every Block 1 row resolves to its catalog target', () => {
    for (const [former, target] of Object.entries(legacyFixture.block1)) {
      const result = resolveRole(former);
      expect(result.kind === 'catalog' || result.kind === 'legacy').toBe(true);
      if (result.kind === 'catalog' || result.kind === 'legacy') {
        expect(result.key).toBe(target);
      }
    }
  });

  it('treasurer resolves to chapter_treasurer, never a national key', () => {
    const result = resolveRole('treasurer');
    expect(result).toMatchObject({ key: 'chapter_treasurer' });
  });

  it('chair_projects, chair_events, chair_outreach, chair_recruitment resolve to chapter keys', () => {
    expect(resolveRole('chair_projects')).toMatchObject({ key: 'chapter_projects_chair' });
    expect(resolveRole('chair_events')).toMatchObject({ key: 'chapter_events_chair' });
    expect(resolveRole('chair_outreach')).toMatchObject({ key: 'chapter_outreach_chair' });
    expect(resolveRole('chair_recruitment')).toMatchObject({ key: 'chapter_recruitment_chair' });
  });

  it('general_secretary resolves to national_general_secretary', () => {
    expect(resolveRole('general_secretary')).toMatchObject({ key: 'national_general_secretary' });
  });

  it('the 6 previously missing mappings resolve', () => {
    expect(resolveRole('chair_ethics')).toMatchObject({ key: 'national_audit_compliance_chair' });
    expect(resolveRole('chair_sponsorship')).toMatchObject({ key: 'chapter_finance_chair' });
    expect(resolveRole('chair_alumni')).toMatchObject({ key: 'chapter_alumni_chair' });
    expect(resolveRole('ambassador_seds')).toMatchObject({ key: 'regional_coordinator' });
    expect(resolveRole('website_developer')).toMatchObject({ key: 'platform_developer' });
    expect(resolveRole('national_marketing')).toMatchObject({ key: 'national_marketing_director' });
  });

  it('national_vice_president is identity, not national_vp_operations', () => {
    expect(resolveRole('national_vice_president')).toEqual({
      kind: 'catalog',
      key: 'national_vice_president',
    });
  });

  it('member is identity, not team_member', () => {
    expect(resolveRole('member')).toEqual({ kind: 'catalog', key: 'member' });
  });

  it('advisor resolves to faculty_advisor', () => {
    expect(resolveRole('advisor')).toMatchObject({ key: 'faculty_advisor' });
  });

  it('explicitly not-mapped tokens resolve to the unknown sentinel', () => {
    for (const token of legacyFixture.notMapped) {
      expect(resolveRole(token).kind).toBe('unknown');
      expect(normalizeToCanonical(token)).toBeNull();
    }
  });

  it('empty and null input resolve to unknown, never guest or team_member', () => {
    expect(resolveRole('').kind).toBe('unknown');
    expect(resolveRole(null).kind).toBe('unknown');
    expect(resolveRole(undefined).kind).toBe('unknown');
  });

  it('slug variants normalize before resolution (case, hyphens, spaces)', () => {
    expect(normalizeRoleSlug(' Chair-Design ')).toBe('chair_design');
    expect(resolveRole('Chair Design')).toMatchObject({ key: 'chapter_design_chair' });
    expect(resolveRole('SUPERADMIN')).toMatchObject({ key: 'chief_technology_officer' });
  });
});

describe('abolished-resolution', () => {
  it('the abolished set is exactly the four Art. 12.3 keys', () => {
    expect([...ABOLISHED_KEYS].sort()).toEqual(
      ['chair_marketing', 'chair_projects', 'marketing_head', 'vice_president'].sort(),
    );
    expect(legacyFixture.abolished.sort()).toEqual([...ABOLISHED_KEYS].sort());
  });

  it('with ABOLISHED_KEYS_RELEASE = false (shipped default), abolished keys follow Block 1', () => {
    // The constant is false in this build; the release branch is covered by
    // construction in resolveRole and flips only on the recorded D2 ruling.
    expect(resolveRole('vice_president')).toMatchObject({ key: 'national_vice_president' });
    expect(resolveRole('chair_marketing')).toMatchObject({ key: 'national_marketing_director' });
    expect(resolveRole('marketing_head')).toMatchObject({ key: 'national_marketing_director' });
    expect(resolveRole('chair_projects')).toMatchObject({ key: 'chapter_projects_chair' });
  });

  it('abolished keys are not catalog keys and cannot be assigned as catalog roles', () => {
    for (const key of ABOLISHED_KEYS) {
      expect(isCatalogRoleKey(key)).toBe(false);
    }
  });
});

describe('superadmin retirement at resolution', () => {
  it('stored superadmin resolves to chief_technology_officer for read paths', () => {
    expect(resolveRole('superadmin')).toMatchObject({ key: 'chief_technology_officer' });
    expect(normalizeToCanonical('superadmin')).toBe('chief_technology_officer');
  });

  it('superadmin is not a catalog key', () => {
    expect(isCatalogRoleKey('superadmin')).toBe(false);
  });

  it('admin on the founder uid resolves to founder_patron; on any other uid it is unknown', () => {
    expect(resolveRoleForUid('admin', FOUNDER_UID, isFounderUid)).toEqual({
      kind: 'catalog',
      key: 'founder_patron',
    });
    expect(resolveRoleForUid('admin', 'some-other-uid', isFounderUid).kind).toBe('unknown');
  });
});

describe('xp-derivation', () => {
  it('xpForRoles returns the highest role XP, not a sum (founder_patron + member = 35)', () => {
    expect(xpForRoles(['founder_patron', 'member'])).toBe(35);
  });

  it('xpForRoles of a single chapter role equals its table XP', () => {
    expect(xpForRoles(['chapter_president'])).toBe(18);
    expect(xpOf('chapter_president')).toBe(18);
  });

  it('xpForRoles of no roles is 0 and never reads a points balance', () => {
    expect(xpForRoles([])).toBe(0);
  });

  it('xpForRoles tie on rank breaks by higher XP', () => {
    // governor_coopted and governor_member are both R4/28; president path:
    // national_general_secretary (R3/23) vs national_treasurer (R3/23) tie stays 23.
    expect(xpForRoles(['national_treasurer', 'national_general_secretary'])).toBe(23);
    expect(xpForRoles(['governor_coopted', 'chapter_president'])).toBe(28);
  });
});
