/**
 * Custom Roles Fix Program, consumers Surface 5: the two display
 * helpers in src/lib/roles.ts resolve custom roles per contracts 4.5.
 *
 * - custom slug + validated definition passed in the caller's
 *   definitions map -> the definition title from BOTH helpers
 *   (one-path ruling: the helpers take the map explicitly and never
 *   consult the sync registry cache; consumers' own surfaces read
 *   the cache in their own components and pass the map in);
 * - custom slug + NO definition at hand -> the humanised slug floor,
 *   never 'Guest', never the raw slug, never 'Basic Member';
 * - junk slugs and every non-custom token render exactly as today
 *   (SEC-10: an invalid or absent definition supplies no title).
 *
 * Kept in a separate file from role-display.test.ts so the Phase 1
 * suite stays byte-untouched.
 */
import {
  getRoleDisplayName,
  canonicalRoleTitle,
  type CustomRoleDefinitionsMap,
} from '../roles';
import type { CustomRoleDefinition } from '../custom-roles';

const POSTER_DEF: CustomRoleDefinition = {
  slug: 'custom_poster_team_lead',
  name: 'Poster Crew Lead',
  description: '',
  parentRoleKey: 'chapter_design_chair',
  chapterId: 'seds-ist-chapter',
  permissions: [],
  isActive: true,
  defaultTermDays: null,
};

// The raw stored-doc form of POSTER_DEF, keyed by normalised slug as
// a caller holding definitions passes it (contracts 1.2 shape; the
// `isCustom: true` field is what lets the doc pass the four-part
// test inside the helpers).
const POSTER_DEFS: CustomRoleDefinitionsMap = new Map([
  [
    POSTER_DEF.slug,
    {
      isCustom: true,
      name: POSTER_DEF.name,
      parentRoleKey: POSTER_DEF.parentRoleKey,
      chapterId: POSTER_DEF.chapterId,
      permissions: POSTER_DEF.permissions,
      isActive: POSTER_DEF.isActive,
    },
  ],
]);

describe('custom role titles in the display helpers (contracts 4.5)', () => {
  it('definition title wins in both helpers when the definition is passed in the map', () => {
    expect(getRoleDisplayName('custom_poster_team_lead', undefined, POSTER_DEFS)).toBe('Poster Crew Lead');
    expect(canonicalRoleTitle('custom_poster_team_lead', POSTER_DEFS)).toBe('Poster Crew Lead');
  });

  it('without a definition at hand, both helpers use the humanised slug floor', () => {
    // Nothing seeded: the floor is the humanised slug, which differs
    // from the definition title above - proving the two paths apart.
    expect(getRoleDisplayName('custom_poster_team_lead')).toBe('Poster Team Lead');
    expect(canonicalRoleTitle('custom_poster_team_lead')).toBe('Poster Team Lead');
  });

  it('a custom slug never renders as Guest, the raw slug, or Basic Member', () => {
    const name = getRoleDisplayName('custom_events_helper');
    const title = canonicalRoleTitle('custom_events_helper');
    expect(name).toBe('Events Helper');
    expect(title).toBe('Events Helper');
    expect(name).not.toBe('Guest');
    expect(title).not.toBe('custom_events_helper');
    expect(name).not.toBe('Basic Member');
  });

  it('junk slugs render exactly as today (SEC-10 lock)', () => {
    // The census junk slugs are legacy DISPLAY tokens (TA finding F1,
    // probe-verified): they resolve through LEGACY_TO_CATALOG to
    // catalog titles in both helpers, exactly as today. "Junk" is the
    // stored-definition axis (legacy-junk item), not display. No
    // custom definition may title them (SEC-10).
    expect(getRoleDisplayName('pakistan-president')).toBe('National President');
    expect(getRoleDisplayName('super-admin')).toBe('Chief Technology Officer');
    expect(canonicalRoleTitle('pakistan-president')).toBe('National President');
    expect(canonicalRoleTitle('chair-design-media')).toBe('Chapter Design and Media Chair');
  });

  it('catalog and legacy behaviour is unchanged with a definitions map supplied', () => {
    expect(getRoleDisplayName('member_basic', undefined, POSTER_DEFS)).toBe('Basic Member');
    expect(canonicalRoleTitle('member_basic', POSTER_DEFS)).toBe('Basic Member');
    expect(getRoleDisplayName('chair_events', undefined, POSTER_DEFS)).toBe('Chapter Events Chair');
    expect(canonicalRoleTitle('treasurer', POSTER_DEFS)).toBe('Chapter Treasurer');
    expect(getRoleDisplayName('totally_unknown_role', undefined, POSTER_DEFS)).toBe('Guest');
  });
});
