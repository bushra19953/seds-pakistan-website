/**
 * Render-order tests for the hierarchy fix (lead bylaws rank spec,
 * 2026-11-01, QUEUE.md P2 spec), on pure fixtures (zero live reads).
 *
 * F1 cases live here: catalog additionalRoles seats materialize as
 * entries, and a section's root is its lowest-level PRESENT entry
 * per the spec — never members[0] by position. The co-held-parent
 * deputy case lands with F4 (it needs the F4 edge rule); the full
 * spec-order assertions (bands, XP order) land with F2.
 */
import {
  buildPublicHierarchy,
  rootMemberIndex,
} from '../public-hierarchy';
import type { RawHierarchyUser } from '../public-hierarchy';

const FOUNDER_UID = 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';
const IST = 'seds-ist-chapter';

function user(partial: Partial<RawHierarchyUser> & { id: string }): RawHierarchyUser {
  return { displayName: 'Person', role: 'member_basic', ...partial };
}

function build(
  users: RawHierarchyUser[],
  defs = new Map<string, Record<string, unknown>>(),
  grants = new Map<string, unknown>()
) {
  return buildPublicHierarchy({
    users,
    chapters: [{ id: IST, name: 'IST Chapter' }],
    roleDefinitions: defs,
    additionalRolesByUid: grants,
  });
}

describe('hierarchy render order (F1)', () => {
  it('IST case: a chapter_president held only via additionalRoles is the section root, and the finance chair is not', () => {
    const grants = new Map<string, unknown>([
      [FOUNDER_UID, ['chapter_president']],
    ]);
    const payload = build(
      [
        // The Founder's president seat lives ONLY in additionalRoles;
        // the stored role is the member floor (the live defect).
        user({ id: FOUNDER_UID, displayName: 'The Founder', role: 'member_basic', chapterId: IST }),
        user({ id: 'u-finance', displayName: 'Finance Chair', role: 'chapter_finance_chair', chapterId: IST }),
        user({ id: 'u-treasurer', displayName: 'Treasurer', role: 'chapter_treasurer', chapterId: IST }),
        user({ id: 'u-recruit', displayName: 'Recruitment Chair', role: 'chapter_recruitment_chair', chapterId: IST }),
      ],
      new Map(),
      grants
    );
    const ist = payload.sections.find((s) => s.id === IST);
    expect(ist).toBeDefined();
    const president = ist!.members.find((m) => m.roleTitle === 'Chapter President');
    expect(president).toBeDefined();
    expect(president!.isCustomRole).toBe(false);
    expect(president!.level).toBe(3);
    const finance = ist!.members.find((m) => m.roleTitle === 'Chapter Finance Chair');
    expect(finance!.level).toBe(4);
    // The root rule: lowest-level present entry wins, whatever its
    // position in the feed — the president, not members[0] by luck.
    const root = ist!.members[rootMemberIndex(ist!.members)];
    expect(root.roleTitle).toBe('Chapter President');
    expect(root).not.toBe(finance);
  });

  it('materializes a president_national grant into the National section', () => {
    const grants = new Map<string, unknown>([['u-nat', ['president_national']]]);
    const payload = build(
      [user({ id: 'u-nat', displayName: 'Nat Prez', role: 'member_basic' })],
      new Map(),
      grants
    );
    const national = payload.sections.find((s) => s.id === 'national');
    expect(national?.members).toHaveLength(1);
    expect(national!.members[0].roleTitle).toBe('National President');
    expect(national!.members[0].isCustomRole).toBe(false);
    expect(national!.members[0].level).toBe(2);
  });

  it('dedupes a catalog grant that repeats the base holding, by slug and by title', () => {
    const grants = new Map<string, unknown>([
      ['u-same-slug', ['chapter_treasurer']],
      // Legacy alias for the same office: same resolved title.
      ['u-same-title', ['treasurer']],
    ]);
    const payload = build(
      [
        user({ id: 'u-same-slug', displayName: 'Same Slug', role: 'chapter_treasurer', chapterId: IST }),
        user({ id: 'u-same-title', displayName: 'Same Title', role: 'chapter_treasurer', chapterId: IST }),
      ],
      new Map(),
      grants
    );
    const ist = payload.sections.find((s) => s.id === IST);
    expect(ist?.members).toHaveLength(2);
    expect(ist!.members.every((m) => m.roleTitle === 'Chapter Treasurer')).toBe(true);
  });

  it('never merges a plain-member catalog grant, and never lists a plain-member base (F3 safety half of the merge)', () => {
    const grants = new Map<string, unknown>([
      ['u-grant-member', ['member', 'member_advisor']],
    ]);
    const payload = build(
      [
        user({ id: 'u-grant-member', displayName: 'Grant Member', role: 'member_basic', chapterId: IST }),
        user({ id: 'u-plain-member', displayName: 'Plain Member', role: 'member', chapterId: IST }),
        user({ id: 'u-plain-advisor', displayName: 'Plain Advisor', role: 'member_advisor', chapterId: IST }),
      ],
      new Map(),
      grants
    );
    expect(payload.sections).toEqual([]);
  });

  it('rootMemberIndex: empty is -1, ties keep feed order, lowest level wins from any position', () => {
    expect(rootMemberIndex([])).toBe(-1);
    expect(rootMemberIndex([{ level: 4 }, { level: 4 }])).toBe(0);
    expect(
      rootMemberIndex([{ level: 4 }, { level: 3 }, { level: 4 }])
    ).toBe(1);
    expect(
      rootMemberIndex([{ level: 6 }, { level: 5 }, { level: 4 }])
    ).toBe(2);
  });
});

describe('hierarchy render order (F2)', () => {
  const DESIGN_DEPUTY = 'custom_design_media_deputy_digital_web_assets';
  const FINANCE_DEPUTY = 'custom_finance_deputy_pipeline_tracking';

  function deputyDef(slug: string, name: string, parentRoleKey: string) {
    return {
      isCustom: true,
      slug,
      name,
      description: '',
      parentRoleKey,
      chapterId: IST,
      permissions: [],
      isActive: true,
      defaultTermDays: null,
    };
  }

  it('orders a full IST section by spec level, then XP desc, then name asc', () => {
    const defs = new Map<string, Record<string, unknown>>([
      [DESIGN_DEPUTY, deputyDef(DESIGN_DEPUTY, 'Design Media Deputy - Digital Web Assets', 'chapter_design_chair')],
      [FINANCE_DEPUTY, deputyDef(FINANCE_DEPUTY, 'Finance Deputy - Pipeline Tracking', 'chapter_finance_chair')],
    ]);
    const payload = build(
      [
        // Deliberately shuffled input order: the feed must sort it.
        user({ id: 'u-cube', displayName: 'Zed Cube', role: 'cubesat_team', chapterId: IST }),
        user({ id: 'u-dep-zed', displayName: 'Zed Deputy', role: DESIGN_DEPUTY, chapterId: IST }),
        user({ id: 'u-alumni', displayName: 'Al Alumni', role: 'chapter_alumni_chair', chapterId: IST }),
        user({ id: 'u-vp', displayName: 'Zed Vp', role: 'chapter_vice_president', chapterId: IST }),
        user({ id: 'u-sec', displayName: 'Amy Sec', role: 'chapter_secretary', chapterId: IST }),
        user({ id: 'u-treas', displayName: 'Yara Treas', role: 'chapter_treasurer', chapterId: IST }),
        user({ id: 'u-rep', displayName: 'Rep', role: 'chapter_representative', chapterId: IST }),
        user({ id: 'u-mkt', displayName: 'Zed Mkt', role: 'chapter_marketing_chair', chapterId: IST }),
        user({ id: 'u-proj', displayName: 'Amy Proj', role: 'chapter_projects_chair', chapterId: IST }),
        user({ id: 'u-events', displayName: 'Nina Events', role: 'chapter_events_chair', chapterId: IST }),
        user({ id: 'u-outreach', displayName: 'Omar Outreach', role: 'chapter_outreach_chair', chapterId: IST }),
        user({ id: 'u-recruit', displayName: 'Rita Recruit', role: 'chapter_recruitment_chair', chapterId: IST }),
        user({ id: 'u-finance', displayName: 'Faisal Finance', role: 'chapter_finance_chair', chapterId: IST }),
        user({ id: 'u-design', displayName: 'Dan Design', role: 'chapter_design_chair', chapterId: IST }),
        user({ id: 'u-prez', displayName: 'Prez', role: 'chapter_president', chapterId: IST }),
        user({ id: 'u-dep-amy', displayName: 'Amy Deputy', role: FINANCE_DEPUTY, chapterId: IST }),
        user({ id: 'u-faculty', displayName: 'Zed Faculty', role: 'faculty_advisor', chapterId: IST }),
        user({ id: 'u-parl', displayName: 'Amy Parl', role: 'parliamentarian', chapterId: IST }),
        user({ id: 'u-return', displayName: 'Mike Return', role: 'returning_officer', chapterId: IST }),
        user({ id: 'u-plat', displayName: 'Plat', role: 'platform_developer', chapterId: IST }),
        user({ id: 'u-lead', displayName: 'Lead', role: 'team_lead', chapterId: IST }),
        user({ id: 'u-rocket', displayName: 'Amy Rocket', role: 'rocketry_team', chapterId: IST }),
        user({ id: 'u-rover', displayName: 'Mike Rover', role: 'rover_team', chapterId: IST }),
      ],
      defs
    );
    const ist = payload.sections.find((s) => s.id === IST);
    expect(ist).toBeDefined();
    // L3 president; L4 chairs by XP desc (ties by name: Amy Sec
    // before Yara Treas at 15, Amy Proj before Zed Mkt at 12,
    // Faisal Finance before Rita Recruit at 10 — XP beats
    // alphabet: Zed Vp at 16 precedes Amy Sec at 15); L5 deputies
    // by name (no catalog XP); L6 units by XP desc, ties by name.
    expect(ist!.members.map((m) => m.id)).toEqual([
      'u-prez',
      'u-vp', 'u-sec', 'u-treas', 'u-rep', 'u-proj', 'u-mkt',
      'u-events', 'u-outreach', 'u-finance', 'u-recruit', 'u-design', 'u-alumni',
      'u-dep-amy', 'u-dep-zed',
      'u-parl', 'u-return', 'u-faculty', 'u-plat', 'u-lead',
      'u-rocket', 'u-rover', 'u-cube',
    ]);
    // Levels ride the feed in the same order.
    expect(ist!.members.map((m) => m.level)).toEqual([
      3,
      4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
      5, 5,
      6, 6, 6, 6, 6, 6, 6, 6,
    ]);
  });

  it('orders the National section by spec level, then XP desc, then name asc', () => {
    const payload = build([
      user({ id: 'u-cto', displayName: 'Mike Cto', role: 'chief_technology_officer' }),
      user({ id: 'u-mem', displayName: 'Zed Mem', role: 'national_membership_director' }),
      user({ id: 'u-audit', displayName: 'Amy Audit', role: 'national_audit_compliance_chair' }),
      user({ id: 'u-mkt', displayName: 'Zed Mkt', role: 'national_marketing_director' }),
      user({ id: 'u-proj', displayName: 'Amy Proj', role: 'national_projects_director' }),
      user({ id: 'u-vp', displayName: 'Zed Vp', role: 'national_vice_president' }),
      user({ id: 'u-gs', displayName: 'Amy Gs', role: 'national_general_secretary' }),
      user({ id: 'u-treas', displayName: 'Mike Treas', role: 'national_treasurer' }),
      user({ id: 'u-nat', displayName: 'Nat', role: 'president_national' }),
      user({ id: 'u-ed', displayName: 'Ed', role: 'executive_director' }),
      user({ id: 'u-govmem', displayName: 'Bob Govmem', role: 'governor_member' }),
      user({ id: 'u-coopt', displayName: 'Amy Coopt', role: 'governor_coopted' }),
      user({ id: 'u-govfound', displayName: 'Zed Gov', role: 'governor_founder' }),
      user({ id: FOUNDER_UID, displayName: 'The Founder', role: 'member_basic' }),
    ]);
    const national = payload.sections.find((s) => s.id === 'national');
    expect(national).toBeDefined();
    expect(national!.members.map((m) => m.id)).toEqual([
      FOUNDER_UID,
      'u-govfound', 'u-coopt', 'u-govmem',
      'u-ed', 'u-nat', 'u-gs', 'u-treas', 'u-vp', 'u-proj', 'u-mkt',
      'u-audit', 'u-cto', 'u-mem',
    ]);
    expect(national!.members.map((m) => m.level)).toEqual([
      0, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    ]);
  });
});

describe('hierarchy render order (F3)', () => {
  const VP_DEPUTY = 'custom_chapter_vp_deputy_technical_systems';
  const VP_DEPUTY_DEF = {
    isCustom: true,
    slug: VP_DEPUTY,
    name: 'Chapter VP Deputy - Technical Systems',
    description: '',
    parentRoleKey: 'chapter_vice_president',
    chapterId: IST,
    permissions: [],
    isActive: true,
    defaultTermDays: null,
  };

  it('excludes every level 7 and 8 key as a base holding', () => {
    const payload = build([
      user({ id: 'u-m', displayName: 'M', role: 'member', chapterId: IST }),
      user({ id: 'u-mo', displayName: 'Mo', role: 'member_officer', chapterId: IST }),
      user({ id: 'u-ma', displayName: 'Ma', role: 'member_advisor', chapterId: IST }),
      user({ id: 'u-mb', displayName: 'Mb', role: 'member_basic', chapterId: IST }),
    ]);
    expect(payload.sections).toEqual([]);
  });

  it('excludes every level 7 and 8 key as a grant', () => {
    const grants = new Map<string, unknown>([
      ['u-g', ['member', 'member_officer', 'member_advisor', 'member_basic']],
    ]);
    const payload = build(
      [user({ id: 'u-g', displayName: 'G', role: 'member_basic', chapterId: IST })],
      new Map(),
      grants
    );
    expect(payload.sections).toEqual([]);
  });

  it('excludes a test-named account holding a plain member role, but publishes its deputy grant (exclusion is role-based, never name-based)', () => {
    const defs = new Map<string, Record<string, unknown>>([[VP_DEPUTY, VP_DEPUTY_DEF]]);
    const grants = new Map<string, unknown>([['u-test-acct', [VP_DEPUTY]]]);
    const payload = build(
      [
        user({ id: 'u-test-acct', displayName: 'Test Account', role: 'member', chapterId: IST }),
        user({ id: 'u-test-user', displayName: 'Test User', role: 'member', chapterId: IST }),
      ],
      defs,
      grants
    );
    const ist = payload.sections.find((s) => s.id === IST);
    expect(ist?.members).toHaveLength(1);
    expect(ist!.members[0].id).toBe('u-test-acct');
    expect(ist!.members[0].roleTitle).toBe('Chapter VP Deputy - Technical Systems');
    expect(ist!.members[0].isCustomRole).toBe(true);
    // No plain-member entry exists for either test-named account.
    expect(ist!.members.some((m) => !m.isCustomRole)).toBe(false);
  });

  it('a plain-member base with a deputy grant yields only the deputy entry', () => {
    const defs = new Map<string, Record<string, unknown>>([[VP_DEPUTY, VP_DEPUTY_DEF]]);
    const grants = new Map<string, unknown>([['u-mixed', [VP_DEPUTY]]]);
    const payload = build(
      [user({ id: 'u-mixed', displayName: 'Mixed', role: 'member', chapterId: IST })],
      defs,
      grants
    );
    const ist = payload.sections.find((s) => s.id === IST);
    expect(ist?.members).toHaveLength(1);
    expect(ist!.members[0].roleTitle).toBe('Chapter VP Deputy - Technical Systems');
  });

  it('level 6 is the cutoff: faculty, team lead and units still appear', () => {
    const payload = build([
      user({ id: 'u-rover', displayName: 'Rover', role: 'rover_team', chapterId: IST }),
      user({ id: 'u-lead', displayName: 'Lead', role: 'team_lead', chapterId: IST }),
      user({ id: 'u-faculty', displayName: 'Faculty', role: 'faculty_advisor', chapterId: IST }),
    ]);
    const ist = payload.sections.find((s) => s.id === IST);
    expect(ist?.members.map((m) => m.id)).toEqual(['u-faculty', 'u-lead', 'u-rover']);
    expect(ist!.members.every((m) => m.level === 6)).toBe(true);
  });

  it('excludes member_officer arriving via displayRole', () => {
    const payload = build([
      user({ id: 'u-derived', displayName: 'Derived', role: 'member_basic', displayRole: 'member_officer', chapterId: IST }),
    ]);
    expect(payload.sections).toEqual([]);
  });
});
