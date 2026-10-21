/**
 * T1 (spec D.9): appointer map data test.
 *
 * - every one of the 40 Phase 1 catalog keys has an entry with non-empty
 *   appointingRoleKeys (a missing entry must fail CLOSED at runtime, so the
 *   map itself must be total - this test is the authoring-time assertion);
 * - exactly one defaultAppointer exists across the whole system and it is
 *   the founder_appointer SENTINEL (src/types/lifecycle.ts), which is not a
 *   catalog role and so has no entry: no map entry may claim it;
 * - regional_coordinator is Category C with appointer Board (the D.1
 *   exception, Art. 8.5) - pinned;
 * - founder_appointer is who appoints founder_patron (self-referential root);
 * - the Section D supplementary vocabulary never collides with catalog keys.
 */

import {
  APPOINTER_MAP,
  APPOINTER_MAP_KEYS,
  SECTION_D_SUPPLEMENTARY_APPOINTER_MAP,
  getAppointerEntry,
  getAppointerEntryIncludingSupplementary,
} from '@/lib/server/lifecycle-appointer-map';
import { BOARD_APPOINTER_KEY, FOUNDER_APPOINTER_KEY } from '@/types/lifecycle';

// The 40 keys of the Phase 1 catalog, in catalog order (interface contract
// section 1; src/lib/role-catalog.ts on the Phase 1 branch).
const CONTRACT_CATALOG_KEYS = [
  'founder_patron',
  'governor_founder',
  'governor_coopted',
  'governor_member',
  'executive_director',
  'president_national',
  'national_vice_president',
  'national_general_secretary',
  'national_treasurer',
  'national_marketing_director',
  'national_projects_director',
  'national_membership_director',
  'national_audit_compliance_chair',
  'chief_technology_officer',
  'chapter_president',
  'chapter_vice_president',
  'chapter_secretary',
  'chapter_treasurer',
  'chapter_representative',
  'regional_coordinator',
  'chapter_marketing_chair',
  'chapter_projects_chair',
  'chapter_events_chair',
  'chapter_outreach_chair',
  'chapter_recruitment_chair',
  'chapter_finance_chair',
  'chapter_design_chair',
  'chapter_alumni_chair',
  'faculty_advisor',
  'parliamentarian',
  'returning_officer',
  'platform_developer',
  'team_lead',
  'cubesat_team',
  'rocketry_team',
  'rover_team',
  'member',
  'member_officer',
  'member_advisor',
  'member_basic',
] as const;

describe('T1 appointer map completeness', () => {
  it('covers exactly the 40 catalog keys, in catalog order', () => {
    expect(APPOINTER_MAP).toHaveLength(40);
    expect(APPOINTER_MAP_KEYS).toEqual([...CONTRACT_CATALOG_KEYS]);
  });

  it('has no duplicate keys', () => {
    expect(new Set(APPOINTER_MAP_KEYS).size).toBe(40);
  });

  it('every catalog key has non-empty appointingRoleKeys', () => {
    for (const key of CONTRACT_CATALOG_KEYS) {
      const e = getAppointerEntry(key);
      expect(e).toBeDefined();
      expect(e!.appointingRoleKeys.length).toBeGreaterThan(0);
    }
    for (const e of APPOINTER_MAP) {
      expect(e.appointingRoleKeys.length).toBeGreaterThan(0);
    }
  });

  it('the only defaultAppointer is the founder_appointer sentinel (no entry claims it)', () => {
    for (const e of APPOINTER_MAP) {
      expect(e.defaultAppointer).toBe(false);
    }
    for (const e of SECTION_D_SUPPLEMENTARY_APPOINTER_MAP) {
      expect(e.defaultAppointer).toBe(false);
    }
    // The sentinel self-references: it is founder_patron's appointer.
    expect(getAppointerEntry('founder_patron')!.appointingRoleKeys).toEqual([
      FOUNDER_APPOINTER_KEY,
    ]);
  });

  it('regional_coordinator is Category C with appointer Board (D.1 exception pinned)', () => {
    const e = getAppointerEntry('regional_coordinator')!;
    expect(e.category).toBe('C');
    expect(e.appointingRoleKeys).toEqual([BOARD_APPOINTER_KEY]);
  });

  it('Category B entries require ratification and are Board-ratified', () => {
    const catB = APPOINTER_MAP.filter((e) => e.category === 'B');
    expect(catB).toHaveLength(10);
    for (const e of catB) {
      expect(e.ratificationRequired).toBe(true);
      expect(e.ratifierRoleKey).toBe(BOARD_APPOINTER_KEY);
      expect(e.minimumMembershipClassForFullPowers).toBe('Full');
    }
    // Non-B entries never require ratification.
    for (const e of APPOINTER_MAP.filter((x) => x.category !== 'B')) {
      expect(e.ratificationRequired).toBe(false);
      expect(e.ratifierRoleKey).toBeNull();
    }
  });

  it('founder_patron and governor_member have no appointive remover', () => {
    expect(getAppointerEntry('founder_patron')!.removerRoleKeys).toEqual([]);
    expect(getAppointerEntry('governor_member')!.removerRoleKeys).toEqual([]);
  });

  it('supplementary vocabulary does not collide with catalog keys and resolves D.8 seats', () => {
    const catalog = new Set<string>(APPOINTER_MAP_KEYS);
    for (const e of SECTION_D_SUPPLEMENTARY_APPOINTER_MAP) {
      expect(catalog.has(e.key)).toBe(false);
      expect(e.appointingRoleKeys.length).toBeGreaterThan(0);
    }
    // The Art. 7.2 seats used by vacancy derivation resolve.
    for (const seat of [
      'chapter_president',
      'chapter_vice_president',
      'chapter_general_secretary',
      'chapter_treasurer',
      'chapter_tech_lead',
    ]) {
      expect(getAppointerEntryIncludingSupplementary(seat)).toBeDefined();
    }
    expect(getAppointerEntryIncludingSupplementary('cadet')!.appointingRoleKeys).toEqual([
      'national_membership_director',
    ]);
    expect(getAppointerEntryIncludingSupplementary('no_such_role')).toBeUndefined();
  });
});
