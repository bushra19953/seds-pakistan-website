/**
 * Phase 1 Workstream A - the single display function (spec A.6) and the
 * reserved-title guard for customTitle.
 */
import { getRoleDisplayName, canonicalRoleTitle } from '../roles';
import {
  FOUNDER_DISPLAY_TITLE,
  isReservedTitle,
  CUSTOM_TITLE_MAX_LENGTH,
} from '../role-catalog';
import { FOUNDER_UID } from '@/config/founder';

const OTHER_UID = 'not-the-founder-uid';

describe('display-name (single function, A.6)', () => {
  it('the Founder UID renders the founder display title regardless of stored role', () => {
    expect(getRoleDisplayName('admin', FOUNDER_UID)).toBe(FOUNDER_DISPLAY_TITLE);
    expect(getRoleDisplayName('superadmin', FOUNDER_UID)).toBe(FOUNDER_DISPLAY_TITLE);
    expect(getRoleDisplayName('member', FOUNDER_UID)).toBe(FOUNDER_DISPLAY_TITLE);
    expect(getRoleDisplayName('', FOUNDER_UID)).toBe(FOUNDER_DISPLAY_TITLE);
  });

  it('the founder display title is the one catalog constant', () => {
    expect(FOUNDER_DISPLAY_TITLE).toBe('Founder and Patron-in-Chief');
  });

  it('catalog keys render their catalog titles', () => {
    expect(getRoleDisplayName('president_national', OTHER_UID)).toBe('National President');
    expect(getRoleDisplayName('chapter_treasurer', OTHER_UID)).toBe('Chapter Treasurer');
    expect(getRoleDisplayName('member_basic', OTHER_UID)).toBe('Basic Member');
  });

  it('president_national on a non-founder renders National President, never Pakistan President or Chapter Advisor', () => {
    const title = getRoleDisplayName('president_national', OTHER_UID);
    expect(title).toBe('National President');
    expect(title).not.toBe('Pakistan President');
    expect(title).not.toBe('Chapter Advisor');
  });

  it('legacy tokens render their catalog target titles', () => {
    expect(getRoleDisplayName('superadmin', OTHER_UID)).toBe('Chief Technology Officer');
    expect(getRoleDisplayName('vice_president', OTHER_UID)).toBe('National Vice President');
    expect(getRoleDisplayName('treasurer', OTHER_UID)).toBe('Chapter Treasurer');
    expect(getRoleDisplayName('chair_marketing', OTHER_UID)).toBe('National Marketing Director');
  });

  it('admin on a non-founder renders Guest (founder handling is UID-scoped)', () => {
    expect(getRoleDisplayName('admin', OTHER_UID)).toBe('Guest');
  });

  it('unknown tokens, statuses-as-roles, empty and null input render Guest', () => {
    expect(getRoleDisplayName('national_vp_operations', OTHER_UID)).toBe('Guest');
    expect(getRoleDisplayName('team_member', OTHER_UID)).toBe('Guest');
    expect(getRoleDisplayName('', OTHER_UID)).toBe('Guest');
    expect(getRoleDisplayName(undefined as unknown as string, OTHER_UID)).toBe('Guest');
  });

  it('non-string role input renders Guest and never throws (junk-data guard)', () => {
    expect(() => getRoleDisplayName(42 as unknown as string, OTHER_UID)).not.toThrow();
    expect(getRoleDisplayName(42 as unknown as string, OTHER_UID)).toBe('Guest');
    expect(getRoleDisplayName({} as unknown as string, OTHER_UID)).toBe('Guest');
  });

  it('canonicalRoleTitle falls back to the raw token for unrecognized input', () => {
    expect(canonicalRoleTitle('president_national')).toBe('National President');
    expect(canonicalRoleTitle('')).toBe('Guest');
    expect(canonicalRoleTitle(null)).toBe('Guest');
  });
});

describe('reserved-titles (customTitle guard, A.6)', () => {
  it('catalog titles are reserved, compared case- and whitespace-insensitively', () => {
    expect(isReservedTitle('National President')).toBe(true);
    expect(isReservedTitle('national  president')).toBe(true);
    expect(isReservedTitle('Chapter Treasurer')).toBe(true);
    expect(isReservedTitle('Founder and Patron-in-Chief')).toBe(true);
  });

  it('office words are reserved', () => {
    expect(isReservedTitle('Founder')).toBe(true);
    expect(isReservedTitle('Governor')).toBe(true);
    expect(isReservedTitle('President')).toBe(true);
    expect(isReservedTitle('Pakistan President')).toBe(true);
    expect(isReservedTitle('Super Admin')).toBe(true);
  });

  it('a trailing parenthetical is stripped before comparison', () => {
    expect(isReservedTitle('National President (Acting)')).toBe(true);
  });

  it('patron / governor substrings are reserved', () => {
    expect(isReservedTitle('Honorary Patron')).toBe(true);
    expect(isReservedTitle('Deputy Governor Liaison')).toBe(true);
  });

  it('ordinary custom titles are not reserved', () => {
    expect(isReservedTitle('IST Chapter Lead, Outreach')).toBe(false);
    expect(isReservedTitle('CanSat Avionics Lead')).toBe(false);
    expect(isReservedTitle('')).toBe(false);
  });

  it('the unified customTitle max length is 80', () => {
    expect(CUSTOM_TITLE_MAX_LENGTH).toBe(80);
  });
});

/**
 * T3 (RESOLUTION-AI plan s.6 / s.4) - definition-backed custom role
 * titles. Both display functions gain an OPTIONAL caller-supplied
 * definitions map (normalised slug -> definition-like); without the map
 * the pre-existing suite above pins today's behavior byte-for-byte
 * (plan s.0.1). The map value type is structural, identical in shape to
 * CustomRoleDefinitionLike in src/lib/custom-role.ts, so this file does
 * not import that module; the widened call signatures are asserted
 * through the two typed aliases below.
 */
type DefLikeForTest = {
  isCustom?: unknown;
  parentRoleKey?: unknown;
  chapterId?: unknown;
  title?: unknown;
  name?: unknown;
  label?: unknown;
  description?: unknown;
  responsibilities?: unknown;
};
type DefMapForTest = ReadonlyMap<string, DefLikeForTest>;

const canonicalTitleWithDefs = canonicalRoleTitle as unknown as (
  role: string | null | undefined,
  definitions?: DefMapForTest,
) => string;
const displayNameWithDefs = getRoleDisplayName as unknown as (
  role: string,
  userUid?: string,
  definitions?: DefMapForTest,
) => string;

describe('definition-backed custom role titles (plan s.4)', () => {
  const CUSTOM_SLUG = 'custom_poster_team_lead';
  const VALID_DEF: DefLikeForTest = {
    isCustom: true,
    parentRoleKey: 'chapter_design_chair',
    chapterId: 'seds-ist-chapter',
    title: 'Poster Team Lead',
  };
  const defsWith = (slug: string, def: DefLikeForTest): DefMapForTest =>
    new Map([[slug, def]]);

  it('custom slug + valid def renders the definition title from BOTH functions', () => {
    const defs = defsWith(CUSTOM_SLUG, VALID_DEF);
    expect(canonicalTitleWithDefs(CUSTOM_SLUG, defs)).toBe('Poster Team Lead');
    expect(displayNameWithDefs(CUSTOM_SLUG, OTHER_UID, defs)).toBe('Poster Team Lead');
  });

  it('definition title falls back through name, then label (A2 order)', () => {
    const nameOnly = defsWith(CUSTOM_SLUG, { ...VALID_DEF, title: undefined, name: 'Poster Crew Name' });
    expect(canonicalTitleWithDefs(CUSTOM_SLUG, nameOnly)).toBe('Poster Crew Name');
    expect(displayNameWithDefs(CUSTOM_SLUG, OTHER_UID, nameOnly)).toBe('Poster Crew Name');

    const labelOnly = defsWith(CUSTOM_SLUG, {
      ...VALID_DEF,
      title: undefined,
      name: undefined,
      label: 'Poster Crew Label',
    });
    expect(canonicalTitleWithDefs(CUSTOM_SLUG, labelOnly)).toBe('Poster Crew Label');
    expect(displayNameWithDefs(CUSTOM_SLUG, OTHER_UID, labelOnly)).toBe('Poster Crew Label');
  });

  it("custom slug + def without any title field keeps today's fallback", () => {
    const noTitle: DefLikeForTest = {
      isCustom: true,
      parentRoleKey: 'chapter_design_chair',
      chapterId: 'seds-ist-chapter',
    };
    const defs = defsWith(CUSTOM_SLUG, noTitle);
    // canonicalRoleTitle falls back to the raw token; getRoleDisplayName to 'Guest'.
    expect(canonicalTitleWithDefs(CUSTOM_SLUG, defs)).toBe(CUSTOM_SLUG);
    expect(displayNameWithDefs(CUSTOM_SLUG, OTHER_UID, defs)).toBe('Guest');
  });

  it('a def that fails the four-part test supplies NO title (junk stays dead)', () => {
    const fakeDef = defsWith(CUSTOM_SLUG, { ...VALID_DEF, isCustom: false, title: 'Fake Title' });
    expect(canonicalTitleWithDefs(CUSTOM_SLUG, fakeDef)).toBe(CUSTOM_SLUG);
    expect(displayNameWithDefs(CUSTOM_SLUG, OTHER_UID, fakeDef)).toBe('Guest');

    // A fully valid def stored under a NON-custom slug is likewise inert:
    // the slug prong of the four-part test fails.
    const wrongSlug = defsWith('lead_wizard', VALID_DEF);
    expect(canonicalTitleWithDefs('lead_wizard', wrongSlug)).toBe('lead_wizard');
    expect(displayNameWithDefs('lead_wizard', OTHER_UID, wrongSlug)).toBe('Guest');
  });

  it('catalog and legacy tokens ignore the map and keep their catalog titles', () => {
    const defs = defsWith(CUSTOM_SLUG, VALID_DEF);
    expect(canonicalTitleWithDefs('chapter_design_chair', defs)).toBe(
      'Chapter Design and Media Chair',
    );
    expect(displayNameWithDefs('chapter_design_chair', OTHER_UID, defs)).toBe(
      'Chapter Design and Media Chair',
    );
    expect(canonicalTitleWithDefs('chair_design', defs)).toBe('Chapter Design and Media Chair');
    expect(displayNameWithDefs('chair_design', OTHER_UID, defs)).toBe(
      'Chapter Design and Media Chair',
    );
  });

  it('founder-uid calls are unchanged with a map present', () => {
    const defs = defsWith(CUSTOM_SLUG, VALID_DEF);
    expect(displayNameWithDefs('admin', FOUNDER_UID, defs)).toBe(FOUNDER_DISPLAY_TITLE);
    expect(displayNameWithDefs(CUSTOM_SLUG, FOUNDER_UID, defs)).toBe(FOUNDER_DISPLAY_TITLE);
  });
});
