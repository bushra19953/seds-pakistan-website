/**
 * LEGACY-JUNK item (Custom Roles Fix Program), plan section 9.1.
 *
 * Pins the slug classification contract of src/lib/role-slug-classification.ts:
 * every slug in the plan's section 3 classification table is asserted, the
 * tables are DERIVED from the live catalog maps (imported, never re-typed),
 * so a future catalog key or legacy alias is classified by the same loops
 * and can never silently fall into the junk family.
 *
 * Classification ground truth (plan sections 2-3, ruling C2):
 * - exact catalog keys -> 'catalog'
 * - exact LEGACY_TO_CATALOG keys -> 'legacy' (target asserted), except the
 *   self-map entries that are themselves catalog keys (member,
 *   president_national, national_vice_president), which the precedence
 *   order classifies 'catalog' first
 * - the four ABOLISHED_KEYS -> 'legacy' + abolishedPending while
 *   ABOLISHED_KEYS_RELEASE is false
 * - 'admin' -> 'founder_token'
 * - the four census junk doc ids (hyphenated spellings in the permissions
 *   store only) and every non-canonical spelling of a resolving slug ->
 *   'junk'; junk fails exactly like 'unknown' everywhere
 */
import {
  ROLE_CATALOG,
  LEGACY_TO_CATALOG,
  ABOLISHED_KEYS,
  ABOLISHED_KEYS_RELEASE,
  isCatalogRoleKey,
  normalizeRoleSlug,
} from '../role-catalog';
import {
  classifyRoleSlug,
  failsLikeUnknown,
  isJunkSlug,
  JUNK_LIVE_SLUGS,
  CUSTOM_SLUG_PREFIX,
  CUSTOM_SLUG_GRAMMAR,
} from '../role-slug-classification';

const EXPECTED_JUNK = [
  'advisor-faculty-head',
  'chair-design-media',
  'pakistan-president',
  'super-admin',
];

describe('classification: catalog family (table derived from the live catalog)', () => {
  it('every ROLE_CATALOG key classifies catalog, never junk', () => {
    // The loop reads ROLE_CATALOG at runtime: a future catalog key added to
    // role-catalog.ts is asserted by this same test with no edit here, and
    // can never be classified junk (plan 9.1 mechanical completeness).
    expect(ROLE_CATALOG.length).toBeGreaterThan(0);
    for (const role of ROLE_CATALOG) {
      const c = classifyRoleSlug(role.key);
      expect({ key: role.key, family: c.family }).toEqual({ key: role.key, family: 'catalog' });
      expect(c.normalized).toBe(role.key);
      expect(isJunkSlug(role.key)).toBe(false);
      expect(failsLikeUnknown(c.family)).toBe(false);
    }
  });

  it('catalog keys appear in neither the junk set nor as legacy-only tokens', () => {
    for (const role of ROLE_CATALOG) {
      expect(JUNK_LIVE_SLUGS).not.toContain(role.key);
    }
  });
});

describe('classification: legacy family (table derived from the live legacy map)', () => {
  it('every LEGACY_TO_CATALOG key resolves legacy (or catalog for self-maps) with the map target', () => {
    const keys = Object.keys(LEGACY_TO_CATALOG);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const c = classifyRoleSlug(key);
      if (isCatalogRoleKey(key)) {
        // Self-map entries (member, president_national,
        // national_vice_president): catalog precedence wins (plan section 2
        // step order: catalog is tested before legacy).
        expect({ key, family: c.family }).toEqual({ key, family: 'catalog' });
      } else {
        expect({ key, family: c.family }).toEqual({ key, family: 'legacy' });
        expect(c.legacyTarget).toBe(LEGACY_TO_CATALOG[key]);
        expect(failsLikeUnknown(c.family)).toBe(false);
      }
    }
  });

  it('no LEGACY_TO_CATALOG key is ever classified junk', () => {
    for (const key of Object.keys(LEGACY_TO_CATALOG)) {
      expect(classifyRoleSlug(key).family).not.toBe('junk');
      expect(isJunkSlug(key)).toBe(false);
    }
  });

  it('the four ABOLISHED_KEYS classify legacy with abolishedPending while the release flag is off', () => {
    // Pins ruling C4 + the current flag state. This assertion on the flag
    // itself is deliberate: flipping ABOLISHED_KEYS_RELEASE must fail here
    // loudly and force a conscious update of the plan, not drift silently.
    expect(ABOLISHED_KEYS_RELEASE).toBe(false);
    expect([...ABOLISHED_KEYS].sort()).toEqual(
      ['chair_marketing', 'chair_projects', 'marketing_head', 'vice_president'].sort(),
    );
    for (const key of ABOLISHED_KEYS) {
      const c = classifyRoleSlug(key);
      expect({ key, family: c.family }).toEqual({ key, family: 'legacy' });
      expect(c.abolishedPending).toBe(true);
      expect(c.legacyTarget).toBe(LEGACY_TO_CATALOG[key]);
    }
  });

  it('non-abolished legacy keys carry no abolishedPending flag', () => {
    for (const key of ['treasurer', 'chair_events', 'ambassador_seds', 'superadmin']) {
      const c = classifyRoleSlug(key);
      expect(c.family).toBe('legacy');
      expect(c.abolishedPending).toBeFalsy();
    }
  });
});

describe('classification: founder token', () => {
  it("'admin' classifies founder_token, never junk, never unknown", () => {
    const c = classifyRoleSlug('admin');
    expect(c.family).toBe('founder_token');
    expect(failsLikeUnknown(c.family)).toBe(false);
    expect(isJunkSlug('admin')).toBe(false);
  });

  it("a case variant of the founder token is not the token: 'Admin' classifies unknown", () => {
    // The founder token resolves only as the exact string 'admin' through
    // resolveRoleForUid; 'Admin' normalises to a token that resolves to
    // nothing, so it is unknown, not junk (junk requires a resolving
    // normalisation).
    expect(classifyRoleSlug('Admin').family).toBe('unknown');
    expect(classifyRoleSlug('ADMIN').family).toBe('unknown');
  });
});

describe('classification: junk family (census set, plan section 3.4)', () => {
  it('JUNK_LIVE_SLUGS is exactly the four census junk ids, sorted', () => {
    expect([...JUNK_LIVE_SLUGS]).toEqual([...EXPECTED_JUNK].sort());
    expect([...JUNK_LIVE_SLUGS]).toEqual([...JUNK_LIVE_SLUGS].sort());
  });

  it('each junk id classifies junk and fails like unknown', () => {
    for (const slug of EXPECTED_JUNK) {
      const c = classifyRoleSlug(slug);
      expect({ slug, family: c.family }).toEqual({ slug, family: 'junk' });
      expect(isJunkSlug(slug)).toBe(true);
      expect(failsLikeUnknown(c.family)).toBe(true);
      expect(c.normalized).toBe(normalizeRoleSlug(slug));
    }
  });

  it('no junk id is a catalog key or a LEGACY_TO_CATALOG key (mechanical)', () => {
    for (const slug of JUNK_LIVE_SLUGS) {
      expect(isCatalogRoleKey(slug)).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(LEGACY_TO_CATALOG, slug)).toBe(false);
    }
  });

  it('each junk id is the non-canonical spelling of a resolving legacy alias (the section 3.4 table)', () => {
    const expectedTargets: Record<string, string> = {
      'super-admin': 'super_admin',
      'pakistan-president': 'pakistan_president',
      'chair-design-media': 'chair_design_media',
      'advisor-faculty-head': 'advisor_faculty_head',
    };
    for (const [junk, alias] of Object.entries(expectedTargets)) {
      expect(normalizeRoleSlug(junk)).toBe(alias);
      // The normalised alias itself is a legacy key (ruling C2): the junk
      // verdict binds the hyphenated doc id, never the alias.
      expect(classifyRoleSlug(alias).family).toBe('legacy');
      expect(classifyRoleSlug(alias).legacyTarget).toBe(LEGACY_TO_CATALOG[alias]);
    }
  });
});

describe('classification: spelling rules and normalisation attacks (ruling C2)', () => {
  it("exact Block 2 key 'super_admin' is legacy, NOT junk", () => {
    const c = classifyRoleSlug('super_admin');
    expect(c.family).toBe('legacy');
    expect(c.legacyTarget).toBe('chief_technology_officer');
    expect(isJunkSlug('super_admin')).toBe(false);
  });

  it("hyphenated 'super-admin' is junk while its underscore twin is legacy", () => {
    expect(classifyRoleSlug('super-admin').family).toBe('junk');
    expect(classifyRoleSlug('super_admin').family).toBe('legacy');
  });

  it.each([
    'Super-Admin',
    'SUPER-ADMIN',
    'Super_Admin',
    'SUPER_ADMIN',
    ' super-admin ',
    'super--admin',
    'super__admin',
    'super admin',
    'Chair-Design-Media',
    'CHAIR-DESIGN-MEDIA',
    'chair design media',
    'Chair_Design',
    'Pakistan-President',
    'PAKISTAN-PRESIDENT',
    ' pakistan-president',
    'Advisor-Faculty-Head',
    'ADVISOR-FACULTY-HEAD',
    'advisor faculty head',
  ])('non-canonical spelling %j classifies junk (normalisation cannot launder it)', (raw) => {
    const c = classifyRoleSlug(raw);
    expect({ raw, family: c.family }).toEqual({ raw, family: 'junk' });
    expect(isJunkSlug(raw)).toBe(true);
    expect(failsLikeUnknown(c.family)).toBe(true);
  });

  it.each(['President_National', 'PRESIDENT NATIONAL', 'Chapter Design Chair', ' MEMBER '])(
    'non-canonical spelling %j of a catalog key classifies junk, not catalog',
    (raw) => {
      expect(classifyRoleSlug(raw).family).toBe('junk');
    },
  );
});

describe('classification: unknown family', () => {
  it.each(['media_lead', 'poster_team_lead', 'invented_role_xyz', ''])(
    'invented slug %j classifies unknown',
    (raw) => {
      const c = classifyRoleSlug(raw);
      expect(c.family).toBe('unknown');
      expect(failsLikeUnknown(c.family)).toBe(true);
      expect(isJunkSlug(raw)).toBe(false);
    },
  );

  it('whitespace-only, null and undefined classify unknown', () => {
    expect(classifyRoleSlug('   ').family).toBe('unknown');
    expect(classifyRoleSlug(null).family).toBe('unknown');
    expect(classifyRoleSlug(undefined).family).toBe('unknown');
  });

  it('junk and unknown are indistinguishable to failsLikeUnknown', () => {
    for (const slug of [...EXPECTED_JUNK, 'media_lead', 'poster_team_lead']) {
      expect(failsLikeUnknown(classifyRoleSlug(slug).family)).toBe(true);
    }
  });
});

describe('classification: failsLikeUnknown verdict table', () => {
  it('is true exactly for junk, unknown and abolished', () => {
    expect(failsLikeUnknown('junk')).toBe(true);
    expect(failsLikeUnknown('unknown')).toBe(true);
    expect(failsLikeUnknown('abolished')).toBe(true);
    expect(failsLikeUnknown('catalog')).toBe(false);
    expect(failsLikeUnknown('legacy')).toBe(false);
    expect(failsLikeUnknown('founder_token')).toBe(false);
    expect(failsLikeUnknown('custom')).toBe(false);
  });
});

describe('classification: custom shape (family is a claim, not legitimacy)', () => {
  it('the prefix constant and grammar are the SEC-09 shapes', () => {
    expect(CUSTOM_SLUG_PREFIX).toBe('custom_');
    expect(CUSTOM_SLUG_GRAMMAR.test('custom_poster_team_lead')).toBe(true);
    expect(CUSTOM_SLUG_GRAMMAR.test('custom_')).toBe(false);
  });

  it("'custom_poster_team_lead' classifies custom with a valid shape", () => {
    const c = classifyRoleSlug('custom_poster_team_lead');
    expect(c.family).toBe('custom');
    expect(c.customShapeValid).toBe(true);
    expect(failsLikeUnknown(c.family)).toBe(false);
  });

  it("bare 'custom_' classifies custom with an invalid shape", () => {
    const c = classifyRoleSlug('custom_');
    expect(c.family).toBe('custom');
    expect(c.customShapeValid).toBe(false);
  });

  it("'custom_Poster': the lowercase prefix claims the custom family, the grammar rejects the shape", () => {
    // Plan section 2 step 1 + 5.1 step 2: a raw string starting with
    // 'custom_' claims family 'custom' and reports shape validity
    // separately; 'custom_Poster' does start with the lowercase prefix,
    // so it is a malformed custom claim, not an unknown slug. (Plan 9.1's
    // parenthetical appears to describe 'Custom_Poster' - capital C -
    // which is pinned as unknown in the next test.)
    const c = classifyRoleSlug('custom_Poster');
    expect(c.family).toBe('custom');
    expect(c.customShapeValid).toBe(false);
  });

  it("'Custom_Poster' is NOT a custom claim (prefix is case-sensitive) and classifies unknown", () => {
    // Does not start with the lowercase prefix, and its normalised form
    // 'custom_poster' resolves to no catalog or legacy role, so the
    // spelling rule cannot make it junk either: unknown (plan 9.1).
    const c = classifyRoleSlug('Custom_Poster');
    expect(c.family).toBe('unknown');
    expect(failsLikeUnknown(c.family)).toBe(true);
  });
});
