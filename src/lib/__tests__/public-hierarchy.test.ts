/**
 * buildPublicHierarchy — the public org-chart projection behind
 * GET /api/public/hierarchy and /hierarchy (founder order 2026-10-30).
 *
 * Proven here, on pure fixtures (zero live reads):
 *  - national-scope roles form the National section, first;
 *  - chapter role-holders group chapter-wise, IST Chapter first,
 *    then by chapter name, officers before other role-holders;
 *  - custom deputy roles appear under their chapter with the
 *    registry definition's title (never the raw slug), including a
 *    chapter-blank holder placed by the definition's own chapter;
 *  - plain members, departed/erased records, nameless records and
 *    explicit public opt-outs never appear;
 *  - chapters with no role-holders produce no section;
 *  - the payload is contact-free by construction: a source user
 *    carrying email / phone-shaped values cannot smuggle them in,
 *    because the projection's input type has no such fields and the
 *    output is scanned for email/phone patterns here.
 */
import { buildPublicHierarchy } from '../public-hierarchy';
import type { RawHierarchyUser } from '../public-hierarchy';

const FOUNDER_UID = 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';
const IST = 'seds-ist-chapter';
const LUMS = 'seds-lums-chapter';

const DEPUTY_SLUG = 'custom_chapter_vp_deputy_technical_systems';
const DEPUTY_DEF = {
  isCustom: true,
  slug: DEPUTY_SLUG,
  name: 'Chapter VP Deputy - Technical Systems',
  description: 'Deputy to the Chapter VP for technical systems.',
  parentRoleKey: 'chapter_vice_president',
  chapterId: IST,
  permissions: [],
  isActive: true,
  defaultTermDays: null,
};

function user(partial: Partial<RawHierarchyUser> & { id: string }): RawHierarchyUser {
  return { displayName: 'Person', role: 'member_basic', ...partial };
}

function build(users: RawHierarchyUser[], defs = new Map<string, Record<string, unknown>>()) {
  return buildPublicHierarchy({
    users,
    chapters: [
      { id: LUMS, name: 'LUMS Chapter' },
      { id: IST, name: 'IST Chapter' },
      { id: 'seds-empty-chapter', name: 'Empty Chapter' },
    ],
    roleDefinitions: defs,
  });
}

describe('buildPublicHierarchy', () => {
  it('puts the National section first, with founder and national officers by rank', () => {
    const payload = build([
      user({ id: 'u-ist-prez', displayName: 'Ist Prez', role: 'chapter_president', chapterId: IST }),
      user({ id: 'u-nat-prez', displayName: 'Nat Prez', role: 'president_national' }),
      user({ id: FOUNDER_UID, displayName: 'The Founder', role: 'member_basic', chapterId: IST }),
    ]);
    expect(payload.sections.map((s) => s.id)).toEqual(['national', IST]);
    const national = payload.sections[0];
    expect(national.name).toBe('National');
    // Founder (R5) outranks the National President (R3) even though the
    // founder's stored role string is the member floor.
    expect(national.members.map((m) => m.id)).toEqual([FOUNDER_UID, 'u-nat-prez']);
    expect(national.members[0].roleTitle).toBe('Founder and Patron-in-Chief');
    expect(national.members[1].roleTitle).toBe('National President');
    expect(national.members[0].profilePath).toBe(`/profile/unified/${FOUNDER_UID}`);
  });

  it('groups chapter holders chapter-wise, IST first, officers before other holders', () => {
    const payload = build([
      user({ id: 'u-lums-prez', displayName: 'Lums Prez', role: 'chapter_president', chapterId: LUMS }),
      user({ id: 'u-ist-team', displayName: 'Ist Rover', role: 'rover_team', chapterId: IST }),
      user({ id: 'u-ist-treasurer', displayName: 'Ist Treasurer', role: 'chapter_treasurer', chapterId: IST }),
      user({ id: 'u-ist-prez', displayName: 'Ist Prez', role: 'chapter_president', chapterId: IST }),
    ]);
    expect(payload.sections.map((s) => s.id)).toEqual([IST, LUMS]);
    const ist = payload.sections[0];
    expect(ist.name).toBe('IST Chapter');
    expect(ist.members.map((m) => m.id)).toEqual([
      'u-ist-prez',
      'u-ist-treasurer',
      'u-ist-team',
    ]);
    expect(ist.members[0].roleTitle).toBe('Chapter President');
    expect(ist.members[1].roleTitle).toBe('Chapter Treasurer');
  });

  it('includes custom deputy roles with the registry title, never the raw slug', () => {
    const defs = new Map([[DEPUTY_SLUG, DEPUTY_DEF]]);
    const payload = build(
      [
        user({
          id: 'u-deputy',
          displayName: 'The Deputy',
          role: DEPUTY_SLUG,
          chapterId: IST,
          photoURL: 'https://example.com/deputy.png',
        }),
      ],
      defs
    );
    const ist = payload.sections.find((s) => s.id === IST);
    expect(ist?.members).toHaveLength(1);
    const deputy = ist!.members[0];
    expect(deputy.roleTitle).toBe('Chapter VP Deputy - Technical Systems');
    expect(deputy.roleTitle).not.toContain('custom_');
    expect(deputy.isCustomRole).toBe(true);
    expect(deputy.photoURL).toBe('https://example.com/deputy.png');
    expect(deputy.profilePath).toBe('/profile/unified/u-deputy');
  });

  it('places a chapter-blank deputy by the chapter stored on the role definition', () => {
    const defs = new Map([[DEPUTY_SLUG, DEPUTY_DEF]]);
    const payload = build(
      [user({ id: 'u-deputy-blank', displayName: 'Blank Chapter Deputy', role: DEPUTY_SLUG })],
      defs
    );
    expect(payload.sections.map((s) => s.id)).toEqual([IST]);
    expect(payload.sections[0].members[0].id).toBe('u-deputy-blank');
  });

  it('falls back to the humanised slug when a custom definition is missing', () => {
    const payload = build([
      user({ id: 'u-nodef', displayName: 'No Def Deputy', role: DEPUTY_SLUG, chapterId: IST }),
    ]);
    const ist = payload.sections.find((s) => s.id === IST);
    expect(ist?.members).toHaveLength(1);
    expect(ist!.members[0].roleTitle).not.toContain('custom_');
    expect(ist!.members[0].roleTitle.length).toBeGreaterThan(0);
  });

  it('excludes plain members, departed/erased, nameless records and explicit opt-outs', () => {
    const payload = build([
      user({ id: 'u-member', displayName: 'Plain Member', role: 'member_basic', chapterId: IST }),
      user({ id: 'u-departed', displayName: 'Gone Prez', role: 'chapter_president', chapterId: IST, memberStatus: 'departed' }),
      user({ id: 'u-erased', displayName: 'Erased Prez', role: 'chapter_president', chapterId: IST, memberStatus: 'erased' }),
      user({ id: 'u-noname', displayName: '   ', role: 'chapter_president', chapterId: IST }),
      user({ id: 'u-optout', displayName: 'Private Prez', role: 'chapter_president', chapterId: IST, publicDirectoryOptIn: false }),
      user({ id: 'u-kept', displayName: 'Kept Prez', role: 'chapter_president', chapterId: IST }),
    ]);
    const all = payload.sections.flatMap((s) => s.members.map((m) => m.id));
    expect(all).toEqual(['u-kept']);
  });

  it('omits chapters with no role-holders entirely', () => {
    const payload = build([
      user({ id: 'u-ist-prez', displayName: 'Ist Prez', role: 'chapter_president', chapterId: IST }),
    ]);
    expect(payload.sections.map((s) => s.id)).toEqual([IST]);
    expect(payload.sections.some((s) => s.name === 'Empty Chapter')).toBe(false);
    expect(payload.sections.some((s) => s.id === LUMS)).toBe(false);
  });

  it('puts chapter-scoped holders with no chapter anywhere in the closing unassigned section', () => {
    const payload = build([
      user({ id: 'u-lost', displayName: 'Lost Treasurer', role: 'chapter_treasurer' }),
      user({ id: 'u-ist-prez', displayName: 'Ist Prez', role: 'chapter_president', chapterId: IST }),
    ]);
    expect(payload.sections.map((s) => s.id)).toEqual([IST, 'unassigned']);
    expect(payload.sections[1].name).toBe('Chapter not yet assigned');
    expect(payload.sections[1].members[0].roleTitle).toBe('Chapter Treasurer');
  });

  it('prefers displayRole over role, exactly like the admin hierarchy feed', () => {
    const payload = build([
      user({
        id: 'u-mirror',
        displayName: 'Mirror Person',
        role: 'member_basic',
        displayRole: 'chapter_secretary',
        chapterId: IST,
      }),
    ]);
    const ist = payload.sections.find((s) => s.id === IST);
    expect(ist?.members).toHaveLength(1);
    expect(ist!.members[0].roleTitle).toBe('Chapter Secretary');
  });

  it('produces a contact-free payload even from polluted source records', () => {
    const polluted = user({
      id: 'u-polluted',
      displayName: 'Polluted Prez',
      role: 'chapter_president',
      chapterId: IST,
      // Contact-shaped values riding on fields the projection reads:
      // a photo URL is the only URL-shaped field, and it must be the
      // ONLY string carried through besides names and titles.
      photoURL: 'https://example.com/avatar.png',
    }) as RawHierarchyUser & Record<string, unknown>;
    polluted.email = 'secret.person@example.com';
    polluted.phoneNumber = '+92 300 1234567';
    polluted.whatsapp = '03001234567';

    const payload = build([polluted]);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/); // no email-shaped string
    expect(serialized).not.toMatch(/\+?\d[\d\s-]{7,}\d/); // no phone-shaped string
    expect(serialized).not.toContain('secret.person');
    expect(serialized).not.toContain('whatsapp');
    expect(serialized).not.toContain('email');
    const person = payload.sections[0].members[0];
    expect(Object.keys(person).sort()).toEqual([
      'id',
      'isCustomRole',
      'name',
      'photoURL',
      'profilePath',
      'roleTitle',
    ]);
  });

  it('returns empty sections for an empty source', () => {
    expect(build([])).toEqual({ sections: [] });
  });
});
