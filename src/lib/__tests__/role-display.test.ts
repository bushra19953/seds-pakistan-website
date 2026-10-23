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
import { __setCustomRoleDefinitionsForTests } from '../custom-role-sync';

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
 * T3 (RESOLUTION-AI plan s.6 / s.4, reconciled against contracts.md
 * s.4.5 - contracts win) - definition-backed custom role titles. Both
 * display functions gain an OPTIONAL caller-supplied definitions map
 * (normalised slug -> stored definition doc). The title order is
 * contracts s.4.5: founder, catalog, custom-with-definition (the
 * definition's `name` - K3: `name` is the title of record, `label`
 * its mirror; read tolerance is name, then label; there is NO `title`
 * field anywhere), legacy, custom-without-definition (the HUMANISED
 * slug, prefix stripped - the shared customRoleTitle behavior), then
 * today's behavior for everything else. A custom slug NEVER renders
 * as its raw slug, never as 'Guest', never as 'Basic Member' - with
 * or without a map. Non-custom slugs are untouched: the pre-existing
 * suite above pins their behavior byte-for-byte (plan s.0.1). The map
 * value type is structural (the stored doc shape, contracts s.1.2),
 * so this file does not import the registry modules; the widened call
 * signatures are asserted through the two typed aliases below.
 */
type DefLikeForTest = {
  isCustom?: unknown;
  parentRoleKey?: unknown;
  chapterId?: unknown;
  name?: unknown;
  label?: unknown;
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

describe('definition-backed custom role titles (contracts s.4.5)', () => {
  const CUSTOM_SLUG = 'custom_poster_team_lead';
  // A second slug whose humanised form ('Cansat Media Crew') cannot be
  // confused with any definition name used below.
  const HUMAN_SLUG = 'custom_cansat_media_crew';
  const VALID_DEF: DefLikeForTest = {
    isCustom: true,
    parentRoleKey: 'chapter_design_chair',
    chapterId: 'seds-ist-chapter',
    name: 'Poster Team Lead',
    label: 'Poster Team Lead',
  };
  const defsWith = (slug: string, def: DefLikeForTest): DefMapForTest =>
    new Map([[slug, def]]);

  it('custom slug + valid def renders the definition `name` from BOTH functions (K3)', () => {
    const defs = defsWith(CUSTOM_SLUG, VALID_DEF);
    expect(canonicalTitleWithDefs(CUSTOM_SLUG, defs)).toBe('Poster Team Lead');
    expect(displayNameWithDefs(CUSTOM_SLUG, OTHER_UID, defs)).toBe('Poster Team Lead');
  });

  it('K3: `name` is the title of record and is never overridden by `label`', () => {
    const defs = defsWith(HUMAN_SLUG, { ...VALID_DEF, name: 'Real Name', label: 'Mirror Label' });
    expect(canonicalTitleWithDefs(HUMAN_SLUG, defs)).toBe('Real Name');
    expect(displayNameWithDefs(HUMAN_SLUG, OTHER_UID, defs)).toBe('Real Name');
  });

  it('K3 read tolerance: a missing `name` falls back to the `label` mirror', () => {
    const labelOnly = defsWith(HUMAN_SLUG, { ...VALID_DEF, name: undefined, label: 'Label Title' });
    expect(canonicalTitleWithDefs(HUMAN_SLUG, labelOnly)).toBe('Label Title');
    expect(displayNameWithDefs(HUMAN_SLUG, OTHER_UID, labelOnly)).toBe('Label Title');
  });

  it('there is NO `title` leg: a def carrying only a `title` field renders the humanised slug', () => {
    // Parent ruling (K3): read tolerance is name, then label, then
    // humanised slug. A stored doc whose only title-ish field is the
    // pre-contracts `title` must NOT render it.
    const titleOnly: DefLikeForTest = Object.assign({}, VALID_DEF, {
      name: undefined,
      label: undefined,
      title: 'Legacy Title Field',
    });
    const defs = defsWith(HUMAN_SLUG, titleOnly);
    expect(canonicalTitleWithDefs(HUMAN_SLUG, defs)).toBe('Cansat Media Crew');
    expect(displayNameWithDefs(HUMAN_SLUG, OTHER_UID, defs)).toBe('Cansat Media Crew');
  });

  it('a valid def with NO name and NO label renders the humanised slug from BOTH functions', () => {
    const bare: DefLikeForTest = {
      isCustom: true,
      parentRoleKey: 'chapter_design_chair',
      chapterId: 'seds-ist-chapter',
    };
    const defs = defsWith(HUMAN_SLUG, bare);
    expect(canonicalTitleWithDefs(HUMAN_SLUG, defs)).toBe('Cansat Media Crew');
    expect(displayNameWithDefs(HUMAN_SLUG, OTHER_UID, defs)).toBe('Cansat Media Crew');
  });

  it('DEVIATION PIN D2 (contracts s.4.5 step 5 vs roles.ts as landed): a custom slug with NO definitions map at all renders the humanised slug - never raw, never Guest', () => {
    // Contracts s.4.5 step 5 + the NEVER sentence: "Sync display
    // helpers that cannot fetch a definition use step 5" (the
    // humanised floor). Plan s.4.3 said mapless calls stay
    // byte-identical to today; contracts win (gate ruling), and the
    // landed roles.ts follows the plan here - its
    // customDefinitionTitle returns null without a map, so the slug
    // renders RAW from canonicalRoleTitle and 'Guest' from
    // getRoleDisplayName. These assertions state the contracts and
    // stay red until roles.ts applies the humanised floor for
    // custom slugs. Reported as deviation D2 in test-status.md.
    expect(canonicalTitleWithDefs(HUMAN_SLUG)).toBe('Cansat Media Crew');
    expect(displayNameWithDefs(HUMAN_SLUG, OTHER_UID)).toBe('Cansat Media Crew');
    expect(canonicalTitleWithDefs(CUSTOM_SLUG)).toBe('Poster Team Lead');
    expect(displayNameWithDefs(CUSTOM_SLUG, OTHER_UID)).toBe('Poster Team Lead');
  });

  it('DEVIATION PIN D2 (contracts s.4.5 step 5): a def that fails the four-part test supplies NO title, and the slug humanises instead of rendering raw/Guest (junk stays dead)', () => {
    const fakeDef = defsWith(HUMAN_SLUG, { ...VALID_DEF, isCustom: false, name: 'Fake Title' });
    expect(canonicalTitleWithDefs(HUMAN_SLUG, fakeDef)).toBe('Cansat Media Crew');
    expect(displayNameWithDefs(HUMAN_SLUG, OTHER_UID, fakeDef)).toBe('Cansat Media Crew');

    // A fully valid def stored under a NON-custom slug is likewise
    // inert, and the non-custom slug keeps TODAY's behavior exactly:
    // the slug prong of the four-part test fails, and only custom_
    // slugs carry the humanised guarantee.
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

describe('custom role slugs (Custom Roles consumers, Surface 5; contracts.md Section 4.5)', () => {
  afterEach(() => {
    // Never leak a seeded definition into the floor tests or other
    // suites sharing this worker.
    __setCustomRoleDefinitionsForTests(null);
  });


  // The sync helpers never have a definition at hand, so a custom slug
  // resolves at contracts 4.5 step 5: the HUMANISED slug (prefix
  // stripped, underscores to spaces, title-cased - the customRoleTitle
  // floor in src/lib/custom-roles.ts). A custom slug NEVER renders as
  // its raw slug, never as 'Guest', never as 'Basic Member'. Async
  // surfaces (hierarchy, PDF, pickers) reach step 3 (the definition
  // name) through the adapters instead; those are covered by the
  // hierarchy and PDF suites.
  it('getRoleDisplayName humanises a custom slug instead of returning Guest', () => {
    expect(getRoleDisplayName('custom_poster_team_lead', OTHER_UID)).toBe('Poster Team Lead');
    expect(getRoleDisplayName('custom_events_helper', OTHER_UID)).toBe('Events Helper');
  });

  it('canonicalRoleTitle humanises a custom slug instead of returning the raw token', () => {
    expect(canonicalRoleTitle('custom_poster_team_lead')).toBe('Poster Team Lead');
    expect(canonicalRoleTitle('custom_events_helper')).toBe('Events Helper');
  });

  it('the founder display still wins over the custom floor (contracts 4.5 step 1)', () => {
    expect(getRoleDisplayName('custom_poster_team_lead', FOUNDER_UID)).toBe(FOUNDER_DISPLAY_TITLE);
  });

  it('with a validated definition in the sync cache, both helpers return the definition name (contracts 4.5 step 3)', () => {
    __setCustomRoleDefinitionsForTests([
      {
        slug: 'custom_poster_team_lead',
        name: 'Poster Squad Lead',
        description: '',
        parentRoleKey: 'chapter_design_chair',
        chapterId: 'seds-ist-chapter',
        permissions: [],
        isActive: true,
        defaultTermDays: null,
      },
    ]);
    // 'Poster Squad Lead' differs from the humanised floor ('Poster
    // Team Lead'), proving the definition path apart from the floor.
    expect(getRoleDisplayName('custom_poster_team_lead', OTHER_UID)).toBe('Poster Squad Lead');
    expect(canonicalRoleTitle('custom_poster_team_lead')).toBe('Poster Squad Lead');
  });

  it('census junk slugs are legacy display tokens and keep their catalog titles (SEC-10 lock)', () => {
    // Finding (probe-verified 2026-10-23): the four junk DEFINITION doc
    // ids from the Oct 23 census are all Block-2 legacy tokens in
    // LEGACY_TO_CATALOG (role-catalog.ts:330-346), so at display time
    // they have always resolved to catalog titles - "junk" describes
    // the stored docs, not display resolution. The custom branch must
    // not leak to any non-custom_ token: these render exactly as
    // before the program, and a genuinely unknown token still floors
    // to 'Guest' / the raw token.
    expect(getRoleDisplayName('pakistan_president', OTHER_UID)).toBe('National President');
    expect(getRoleDisplayName('pakistan-president', OTHER_UID)).toBe('National President');
    expect(canonicalRoleTitle('pakistan_president')).toBe('National President');
    expect(getRoleDisplayName('chair_design_media', OTHER_UID)).toBe('Chapter Design and Media Chair');
    expect(getRoleDisplayName('advisor_faculty_head', OTHER_UID)).toBe('Faculty Advisor');
    expect(getRoleDisplayName('super_admin', OTHER_UID)).toBe('Chief Technology Officer');
    expect(getRoleDisplayName('team_member', OTHER_UID)).toBe('Guest');
    expect(canonicalRoleTitle('team_member')).toBe('team_member');
  });
});
