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
 *  - plain members, departed/erased records and nameless records
 *    never appear; an appointed office-holder DOES appear even when
 *    their publicDirectoryOptIn flag is false (founder rules-of-power
 *    decision 2026-10-30: the flag governs the member directory,
 *    not the org chart);
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

function build(
  users: RawHierarchyUser[],
  defs = new Map<string, Record<string, unknown>>(),
  grants = new Map<string, unknown>()
) {
  return buildPublicHierarchy({
    users,
    chapters: [
      { id: LUMS, name: 'LUMS Chapter' },
      { id: IST, name: 'IST Chapter' },
      { id: 'seds-empty-chapter', name: 'Empty Chapter' },
    ],
    roleDefinitions: defs,
    additionalRolesByUid: grants,
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

  it('excludes plain members, departed/erased and nameless records', () => {
    const payload = build([
      user({ id: 'u-member', displayName: 'Plain Member', role: 'member_basic', chapterId: IST }),
      user({ id: 'u-departed', displayName: 'Gone Prez', role: 'chapter_president', chapterId: IST, memberStatus: 'departed' }),
      user({ id: 'u-erased', displayName: 'Erased Prez', role: 'chapter_president', chapterId: IST, memberStatus: 'erased' }),
      user({ id: 'u-noname', displayName: '   ', role: 'chapter_president', chapterId: IST }),
      user({ id: 'u-kept', displayName: 'Kept Prez', role: 'chapter_president', chapterId: IST }),
    ]);
    const all = payload.sections.flatMap((s) => s.members.map((m) => m.id));
    expect(all).toEqual(['u-kept']);
  });

  it('publishes an appointed office-holder whose publicDirectoryOptIn is false (founder decision 2026-10-30: the flag governs the member directory, not the org chart)', () => {
    const payload = build([
      user({ id: 'u-optout-prez', displayName: 'Opted Out Prez', role: 'chapter_president', chapterId: IST, publicDirectoryOptIn: false }),
    ]);
    const ist = payload.sections.find((s) => s.id === IST);
    expect(ist?.members.map((m) => m.id)).toEqual(['u-optout-prez']);
    expect(ist!.members[0].roleTitle).toBe('Chapter President');
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

  // ─── Custom-role GRANTS (roles/{uid}.additionalRoles) ─────────────
  // The AUTHORITY dialog's write path never puts a custom slug in the
  // users doc role field: the grant is appended to additionalRoles on
  // roles/{uid} and the primary stays the catalog role (member_basic
  // for most deputy appointees). The projection must merge those
  // grants or every deputy appointee is invisible — the exact
  // production defect of 2026-10-30 (16 deputy holders missing).

  it('publishes a grant holder whose stored role is the member floor (the production case)', () => {
    const defs = new Map([[DEPUTY_SLUG, DEPUTY_DEF]]);
    const grants = new Map<string, unknown>([['u-grantee', [DEPUTY_SLUG]]]);
    const payload = build(
      [
        user({
          id: 'u-grantee',
          displayName: 'The Grantee',
          role: 'member_basic',
          displayRole: 'member_basic',
          chapterId: IST,
          photoURL: 'https://example.com/grantee.png',
        }),
      ],
      defs,
      grants
    );
    const ist = payload.sections.find((s) => s.id === IST);
    expect(ist?.members).toHaveLength(1);
    const deputy = ist!.members[0];
    expect(deputy).toEqual({
      id: 'u-grantee',
      name: 'The Grantee',
      roleTitle: 'Chapter VP Deputy - Technical Systems',
      photoURL: 'https://example.com/grantee.png',
      profilePath: '/profile/unified/u-grantee',
      isCustomRole: true,
    });
    // The payload person object keeps exactly its 6 keys.
    expect(Object.keys(deputy).sort()).toEqual([
      'id',
      'isCustomRole',
      'name',
      'photoURL',
      'profilePath',
      'roleTitle',
    ]);
  });

  it('shows a person once per held role when a base role and a custom grant coexist', () => {
    const defs = new Map([[DEPUTY_SLUG, DEPUTY_DEF]]);
    const grants = new Map<string, unknown>([['u-dual', [DEPUTY_SLUG]]]);
    const payload = build(
      [
        user({
          id: 'u-dual',
          displayName: 'Dual Hat',
          role: 'chapter_treasurer',
          chapterId: IST,
        }),
      ],
      defs,
      grants
    );
    const ist = payload.sections.find((s) => s.id === IST);
    expect(ist?.members.map((m) => m.roleTitle)).toEqual([
      'Chapter Treasurer',
      'Chapter VP Deputy - Technical Systems',
    ]);
    expect(ist!.members[0].isCustomRole).toBe(false);
    expect(ist!.members[1].isCustomRole).toBe(true);
    expect(ist!.members.every((m) => m.id === 'u-dual')).toBe(true);
  });

  it('dedupes identical person+title pairs from grants', () => {
    const defs = new Map([[DEPUTY_SLUG, DEPUTY_DEF]]);
    // Base role IS the custom slug and the grant list repeats it
    // (twice): one entry, not three.
    const grants = new Map<string, unknown>([
      ['u-dup', [DEPUTY_SLUG, DEPUTY_SLUG]],
    ]);
    const payload = build(
      [user({ id: 'u-dup', displayName: 'Dup Deputy', role: DEPUTY_SLUG, chapterId: IST })],
      defs,
      grants
    );
    const all = payload.sections.flatMap((s) => s.members);
    expect(all).toHaveLength(1);
    expect(all[0].roleTitle).toBe('Chapter VP Deputy - Technical Systems');
  });

  it('applies the remaining gates to grant holders: departed and nameless never appear, but a directory opt-out does not hide an appointed deputy (founder decision 2026-10-30)', () => {
    const defs = new Map([[DEPUTY_SLUG, DEPUTY_DEF]]);
    const grants = new Map<string, unknown>([
      ['u-grant-optout', [DEPUTY_SLUG]],
      ['u-grant-departed', [DEPUTY_SLUG]],
      ['u-grant-noname', [DEPUTY_SLUG]],
    ]);
    const payload = build(
      [
        user({ id: 'u-grant-optout', displayName: 'Private Deputy', role: 'member_basic', chapterId: IST, publicDirectoryOptIn: false }),
        user({ id: 'u-grant-departed', displayName: 'Gone Deputy', role: 'member_basic', chapterId: IST, memberStatus: 'departed' }),
        user({ id: 'u-grant-noname', displayName: '  ', role: 'member_basic', chapterId: IST }),
      ],
      defs,
      grants
    );
    // The opted-out deputy IS published on the chart (the flag
    // governs the member directory only); the departed and nameless
    // grant holders stay off.
    const all = payload.sections.flatMap((s) => s.members);
    expect(all.map((m) => m.id)).toEqual(['u-grant-optout']);
    expect(all[0].roleTitle).toBe('Chapter VP Deputy - Technical Systems');
    expect(all[0].isCustomRole).toBe(true);
  });

  it('places a chapter-blank grant holder by the chapter on the role definition', () => {
    const defs = new Map([[DEPUTY_SLUG, DEPUTY_DEF]]);
    const grants = new Map<string, unknown>([['u-grant-blank', [DEPUTY_SLUG]]]);
    const payload = build(
      [user({ id: 'u-grant-blank', displayName: 'Blank Chapter Grantee', role: 'member_basic' })],
      defs,
      grants
    );
    expect(payload.sections.map((s) => s.id)).toEqual([IST]);
    expect(payload.sections[0].members[0].id).toBe('u-grant-blank');
  });

  it('still publishes a grant whose definition is missing, with a non-slug title', () => {
    const grants = new Map<string, unknown>([['u-grant-nodef', [DEPUTY_SLUG]]]);
    const payload = build(
      [user({ id: 'u-grant-nodef', displayName: 'No Def Grantee', role: 'member_basic', chapterId: IST })],
      new Map(),
      grants
    );
    const ist = payload.sections.find((s) => s.id === IST);
    expect(ist?.members).toHaveLength(1);
    expect(ist!.members[0].isCustomRole).toBe(true);
    expect(ist!.members[0].roleTitle).not.toContain('custom_');
    expect(ist!.members[0].roleTitle.length).toBeGreaterThan(0);
  });

  it('ignores non-custom entries and junk values in the grants array', () => {
    const grants = new Map<string, unknown>([
      ['u-junk', ['chapter_treasurer', 42, null, '', 'not a slug']],
    ]);
    const payload = build(
      [user({ id: 'u-junk', displayName: 'Junk Grants', role: 'member_basic', chapterId: IST })],
      new Map(),
      grants
    );
    // A catalog slug in additionalRoles is NOT merged as an extra
    // holding: catalog additionals already surface through the
    // effective role mirrored onto the user record. Only custom
    // grants — invisible everywhere else — are merged here.
    expect(payload.sections).toEqual([]);
  });

  // ─── Parent edges for the visual org chart ─────────────────────
  // An edge exists only where the data supports it: the deputy
  // definition names parentRoleKey chapter_vice_president, and
  // exactly one entry in the same section holds that role.

  it('derives a deputy -> chair edge from the definition parentRoleKey', () => {
    const defs = new Map([[DEPUTY_SLUG, DEPUTY_DEF]]);
    const grants = new Map<string, unknown>([['u-dep', [DEPUTY_SLUG]]]);
    const payload = build(
      [
        user({ id: 'u-chair', displayName: 'The Chair', role: 'chapter_vice_president', chapterId: IST }),
        user({ id: 'u-dep', displayName: 'The Deputy', role: 'member_basic', chapterId: IST }),
      ],
      defs,
      grants
    );
    const ist = payload.sections.find((s) => s.id === IST);
    expect(ist?.members.map((m) => m.id)).toEqual(['u-chair', 'u-dep']);
    // Member index 1 (the deputy) hangs under member index 0 (the VP).
    expect(ist?.parents).toEqual({ '1': 0 });
    // The person objects keep exactly their 6 keys.
    expect(Object.keys(ist!.members[1]).sort()).toEqual([
      'id',
      'isCustomRole',
      'name',
      'photoURL',
      'profilePath',
      'roleTitle',
    ]);
  });

  it('emits no edge when the parent role is co-held by two people', () => {
    const defs = new Map([[DEPUTY_SLUG, DEPUTY_DEF]]);
    const grants = new Map<string, unknown>([['u-dep', [DEPUTY_SLUG]]]);
    const payload = build(
      [
        user({ id: 'u-chair-a', displayName: 'Chair A', role: 'chapter_vice_president', chapterId: IST }),
        user({ id: 'u-chair-b', displayName: 'Chair B', role: 'chapter_vice_president', chapterId: IST }),
        user({ id: 'u-dep', displayName: 'The Deputy', role: 'member_basic', chapterId: IST }),
      ],
      defs,
      grants
    );
    const ist = payload.sections.find((s) => s.id === IST);
    expect(ist?.members).toHaveLength(3);
    // Attaching the deputy to either co-chair would invent a
    // reporting line; the chart band-places deputies with no edge.
    expect(ist?.parents).toBeUndefined();
  });

  it('emits no edge when the parent role is vacant in the section', () => {
    const defs = new Map([[DEPUTY_SLUG, DEPUTY_DEF]]);
    const grants = new Map<string, unknown>([['u-dep', [DEPUTY_SLUG]]]);
    const payload = build(
      [user({ id: 'u-dep', displayName: 'The Deputy', role: 'member_basic', chapterId: IST })],
      defs,
      grants
    );
    const ist = payload.sections.find((s) => s.id === IST);
    expect(ist?.members).toHaveLength(1);
    expect(ist?.parents).toBeUndefined();
  });

  it('emits no edge when the parent holder sits in another chapter', () => {
    const defs = new Map([[DEPUTY_SLUG, DEPUTY_DEF]]);
    const grants = new Map<string, unknown>([['u-dep', [DEPUTY_SLUG]]]);
    const payload = build(
      [
        user({ id: 'u-chair', displayName: 'The Chair', role: 'chapter_vice_president', chapterId: LUMS }),
        user({ id: 'u-dep', displayName: 'The Deputy', role: 'member_basic', chapterId: IST }),
      ],
      defs,
      grants
    );
    const ist = payload.sections.find((s) => s.id === IST);
    expect(ist?.members.map((m) => m.id)).toEqual(['u-dep']);
    expect(ist?.parents).toBeUndefined();
    const lums = payload.sections.find((s) => s.id === LUMS);
    expect(lums?.parents).toBeUndefined();
  });
});
