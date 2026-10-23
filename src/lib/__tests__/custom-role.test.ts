/**
 * T1 (RESOLUTION-AI plan s.6, reconciled against contracts.md s.4.2 -
 * contracts win) - the shared pure core in src/lib/custom-roles.ts
 * (the module of record; data-model owns it). NOT the plan's original
 * src/lib/custom-role.ts path (merge-planner conflict C-11).
 *
 * Surface pinned here, per contracts s.4.2: CUSTOM_ROLE_PREFIX,
 * RESERVED_PERMISSION_KEYS_FOR_CUSTOM_ROLES, isCustomRoleSlug,
 * buildCustomRoleSlug, validateCustomSlug (s.1.1 incl. anti-squat),
 * toCustomRoleDefinition (s.1.2 shape; K3: `name` is the title of
 * record, `label` its byte-identical mirror - read tolerance is name,
 * then label; there is NO `title` field anywhere), customRoleTitle
 * (s.4.5), customGrantStatus (s.2.2 read-time derivation).
 * Plus T1.4, the invariant scan backing the decisive-prefix claim.
 */
import {
  CUSTOM_ROLE_PREFIX,
  RESERVED_PERMISSION_KEYS_FOR_CUSTOM_ROLES,
  isCustomRoleSlug,
  buildCustomRoleSlug,
  validateCustomSlug,
  toCustomRoleDefinition,
  customRoleTitle,
  customGrantStatus,
} from '../custom-roles';
import {
  CATALOG_ROLE_KEYS,
  LEGACY_TO_CATALOG,
  normalizeRoleSlug,
} from '../role-catalog';

const SLUG = 'custom_poster_team_lead';

/** A stored custom definition doc, contracts s.1.2 shape. */
const VALID_STORED: Record<string, unknown> = {
  isCustom: true,
  name: 'Poster Team Lead',
  label: 'Poster Team Lead',
  parentRoleKey: 'chapter_design_chair',
  chapterId: 'seds-ist-chapter',
  description: 'Leads the poster team.',
  permissions: ['canManageTasks'],
  isActive: true,
  defaultTermDays: 90,
};

describe('isCustomRoleSlug (raw prefix guard)', () => {
  it('accepts custom_-prefixed slugs', () => {
    expect(isCustomRoleSlug(SLUG)).toBe(true);
  });

  it('rejects the bare prefix alone', () => {
    expect(isCustomRoleSlug('custom_')).toBe(false);
    expect(isCustomRoleSlug('custom')).toBe(false);
  });

  it('does NOT normalise: uppercase is not a lawful slug form (validateCustomSlug owns that rule)', () => {
    expect(isCustomRoleSlug('CUSTOM_X')).toBe(false);
    expect(isCustomRoleSlug('Custom_Poster Team Lead')).toBe(false);
  });

  it('rejects catalog slugs and junk slugs', () => {
    expect(isCustomRoleSlug('member')).toBe(false);
    expect(isCustomRoleSlug('chapter_design_chair')).toBe(false);
    expect(isCustomRoleSlug('pakistan-president')).toBe(false);
    expect(isCustomRoleSlug('super-admin')).toBe(false);
    expect(isCustomRoleSlug('chair-design-media')).toBe(false);
    expect(isCustomRoleSlug('advisor-faculty-head')).toBe(false);
  });

  it('rejects empty and non-string input', () => {
    expect(isCustomRoleSlug('')).toBe(false);
    expect(isCustomRoleSlug(null)).toBe(false);
    expect(isCustomRoleSlug(undefined)).toBe(false);
    expect(isCustomRoleSlug(42)).toBe(false);
  });
});

describe('buildCustomRoleSlug (contracts s.1.1)', () => {
  it("builds 'custom_' + normalizeRoleSlug(displayName)", () => {
    expect(buildCustomRoleSlug('Poster Team Lead')).toBe('custom_poster_team_lead');
    expect(buildCustomRoleSlug('Design & Media Crew')).toBe('custom_design_media_crew');
  });
});

describe('validateCustomSlug (contracts s.1.1, incl. anti-squat)', () => {
  it('accepts a lawful custom slug', () => {
    expect(validateCustomSlug(SLUG)).toEqual({ ok: true });
  });

  it('rejects the bare prefix and non-prefixed slugs', () => {
    expect(validateCustomSlug('custom_').ok).toBe(false);
    expect(validateCustomSlug('poster_team_lead').ok).toBe(false);
    expect(validateCustomSlug('member').ok).toBe(false);
  });

  it('rejects slugs that are not already in normalised form', () => {
    expect(validateCustomSlug('custom_Poster_Team_Lead').ok).toBe(false);
    expect(validateCustomSlug('custom_poster team').ok).toBe(false);
  });

  it('rejects squatting remainders: a custom slug may never echo a catalog key, legacy token or abolished key', () => {
    for (const squat of [
      'custom_chapter_design_chair', // remainder IS a catalog key
      'custom_president_national', // remainder IS a catalog key
      'custom_vice_president', // remainder is a legacy token / abolished key
      'custom_superadmin', // remainder is a legacy token
    ]) {
      expect(validateCustomSlug(squat).ok).toBe(false);
    }
  });

  it('DEVIATION PIN (contracts s.1.1 vs record): custom_admin is named invalid by the contracts', () => {
    // Contracts s.1.1 lists custom_admin among the invalid squats, but
    // the record's anti-squat check cannot see it: 'admin' is
    // deliberately absent from LEGACY_TO_CATALOG (founder-UID handling,
    // role-catalog.ts) and from ABOLISHED_KEYS, so the remainder
    // resolves to null and is not abolished. As of this run the record
    // returns { ok: true } here. This test asserts the CONTRACTS and
    // stays red until data-model closes the gap (e.g. an explicit
    // founder-token remainder ban in validateCustomSlug). Reported as
    // deviation D1 in test-status.md.
    expect(validateCustomSlug('custom_admin').ok).toBe(false);
  });
});

describe('toCustomRoleDefinition (contracts s.1.2 / s.4.2)', () => {
  it('converts a valid stored doc into the contracts shape', () => {
    expect(toCustomRoleDefinition(SLUG, VALID_STORED)).toEqual({
      slug: SLUG,
      name: 'Poster Team Lead',
      description: 'Leads the poster team.',
      parentRoleKey: 'chapter_design_chair',
      chapterId: 'seds-ist-chapter',
      permissions: ['canManageTasks'],
      isActive: true,
      defaultTermDays: 90,
    });
  });

  it('K3: `name` is the title of record and is never overridden by `label`', () => {
    const def = toCustomRoleDefinition(SLUG, {
      ...VALID_STORED,
      name: 'Real Name',
      label: 'Mirror Label',
    });
    expect(def?.name).toBe('Real Name');
  });

  it('K3 read tolerance: a missing `name` falls back to the `label` mirror', () => {
    const { name: _n, ...noName } = VALID_STORED;
    expect(toCustomRoleDefinition(SLUG, noName)?.name).toBe('Poster Team Lead');
    // Unpinned edge, recorded in test-status.md: a whitespace-only name
    // is returned verbatim by the converter (the record checks !== ''),
    // and customRoleTitle then treats it as empty and humanises.
    // Contracts do not specify trim semantics for the stored name read.
  });

  it('description falls back to `responsibilities` (the generator\u2019s long-standing read)', () => {
    const { description: _d, ...noDesc } = VALID_STORED;
    expect(
      toCustomRoleDefinition(SLUG, { ...noDesc, responsibilities: 'Runs the poster crew.' })
        ?.description,
    ).toBe('Runs the poster crew.');
    expect(
      toCustomRoleDefinition(SLUG, {
        ...VALID_STORED,
        description: 42,
        responsibilities: 'Runs the poster crew.',
      })?.description,
    ).toBe('Runs the poster crew.');
    expect(toCustomRoleDefinition(SLUG, noDesc)?.description).toBe('');
  });

  it('there is NO `title` field: a doc carrying only `title` converts with an empty name', () => {
    const { name: _n, label: _l, ...rest } = VALID_STORED;
    const def = toCustomRoleDefinition(SLUG, { ...rest, title: 'Title Only' });
    expect(def?.name).toBe('');
  });

  it('applies the s.1.2 defaults: permissions [], isActive true, defaultTermDays null, description empty', () => {
    expect(
      toCustomRoleDefinition(SLUG, {
        isCustom: true,
        parentRoleKey: 'chapter_design_chair',
        chapterId: 'seds-ist-chapter',
      }),
    ).toEqual({
      slug: SLUG,
      name: '',
      description: '',
      parentRoleKey: 'chapter_design_chair',
      chapterId: 'seds-ist-chapter',
      permissions: [],
      isActive: true,
      defaultTermDays: null,
    });
  });

  it('defaultTermDays must be a positive integer (s.1.4), else null', () => {
    for (const bad of [0, -5, 1.5, '90']) {
      expect(
        toCustomRoleDefinition(SLUG, { ...VALID_STORED, defaultTermDays: bad })?.defaultTermDays,
      ).toBeNull();
    }
  });

  it('permissions is filtered to strings; a non-array yields []', () => {
    expect(
      toCustomRoleDefinition(SLUG, {
        ...VALID_STORED,
        permissions: ['canManageTasks', 42, 'canViewAdmin'],
      })?.permissions,
    ).toEqual(['canManageTasks', 'canViewAdmin']);
    expect(
      toCustomRoleDefinition(SLUG, { ...VALID_STORED, permissions: 'canManageTasks' })?.permissions,
    ).toEqual([]);
  });

  it('a retired definition (isActive false) still converts - retirement is a consumer filter, not a shape failure', () => {
    expect(toCustomRoleDefinition(SLUG, { ...VALID_STORED, isActive: false })?.isActive).toBe(
      false,
    );
  });

  it('a non-normalised slug converts to null: normalisation is a validity rule, not a cleanup', () => {
    expect(toCustomRoleDefinition('CUSTOM_Poster_Team_Lead', VALID_STORED)).toBeNull();
  });

  it('returns null when isCustom is not exactly true', () => {
    const { isCustom: _i, ...noFlag } = VALID_STORED;
    expect(toCustomRoleDefinition(SLUG, noFlag)).toBeNull();
    expect(toCustomRoleDefinition(SLUG, { ...VALID_STORED, isCustom: false })).toBeNull();
    expect(toCustomRoleDefinition(SLUG, { ...VALID_STORED, isCustom: 'true' })).toBeNull();
  });

  it('returns null when the parent is not a catalog key (a legacy token FAILS)', () => {
    expect(
      toCustomRoleDefinition(SLUG, { ...VALID_STORED, parentRoleKey: 'chair_events' }),
    ).toBeNull();
    expect(
      toCustomRoleDefinition(SLUG, { ...VALID_STORED, parentRoleKey: 'custom_other_role' }),
    ).toBeNull();
    const { parentRoleKey: _p, ...noParent } = VALID_STORED;
    expect(toCustomRoleDefinition(SLUG, noParent)).toBeNull();
  });

  it('returns null when chapterId is missing, empty or non-string', () => {
    expect(toCustomRoleDefinition(SLUG, { ...VALID_STORED, chapterId: '' })).toBeNull();
    expect(toCustomRoleDefinition(SLUG, { ...VALID_STORED, chapterId: 42 })).toBeNull();
    const { chapterId: _c, ...noChapter } = VALID_STORED;
    expect(toCustomRoleDefinition(SLUG, noChapter)).toBeNull();
    // Unpinned edge, recorded in test-status.md: a whitespace-only
    // chapterId is accepted by the record (it checks === ''), while
    // contracts s.1.2 say only "non-empty". If G3 rules non-blank,
    // this becomes a null assertion and a one-line record fix.
  });

  it('returns null for junk slugs on the slug prong alone, however valid the data', () => {
    for (const slug of [
      'pakistan-president',
      'super_admin',
      'chair_design_media',
      'advisor_faculty_head',
    ]) {
      expect(toCustomRoleDefinition(slug, VALID_STORED)).toBeNull();
    }
  });

  it('returns null for missing data', () => {
    expect(toCustomRoleDefinition(SLUG, undefined)).toBeNull();
    expect(toCustomRoleDefinition(SLUG, null as unknown as Record<string, unknown>)).toBeNull();
  });
});

describe('customRoleTitle (contracts s.4.5)', () => {
  it("renders the definition's name when a definition is at hand", () => {
    expect(customRoleTitle({ name: 'Poster Team Lead' }, SLUG)).toBe('Poster Team Lead');
  });

  it('renders the HUMANISED slug (prefix stripped) when no definition is at hand - never the raw slug', () => {
    expect(customRoleTitle(null, SLUG)).toBe('Poster Team Lead');
    expect(customRoleTitle(null, 'custom_cansat_media_crew')).toBe('Cansat Media Crew');
  });

  it('renders the humanised slug when the definition carries no name', () => {
    expect(customRoleTitle({ name: '' }, SLUG)).toBe('Poster Team Lead');
    expect(customRoleTitle({ name: '   ' }, SLUG)).toBe('Poster Team Lead');
  });

  it('the bare prefix still never renders raw: it falls back to a generic title', () => {
    expect(customRoleTitle(null, 'custom_')).toBe('Custom Role');
  });
});

describe('customGrantStatus (contracts s.2.2: read-time derivation is the record)', () => {
  const NOW = new Date('2026-10-23T00:00:00.000Z');
  const DAY = 24 * 60 * 60 * 1000;
  const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

  it("'none' when the doc carries no pending expiry for this slug", () => {
    expect(customGrantStatus({}, SLUG, NOW)).toBe('none');
    expect(customGrantStatus({ expiresAt: at(DAY) }, SLUG, NOW)).toBe('none');
    expect(
      customGrantStatus({ expiresAt: at(DAY), expiresRoleKey: 'custom_other_role' }, SLUG, NOW),
    ).toBe('none');
    expect(customGrantStatus({ expiresAt: null, expiresRoleKey: SLUG }, SLUG, NOW)).toBe('none');
  });

  it("'expired' when now >= expiresAt (exclusive instant, governors semantics)", () => {
    expect(customGrantStatus({ expiresAt: at(-3600000), expiresRoleKey: SLUG }, SLUG, NOW)).toBe(
      'expired',
    );
    expect(customGrantStatus({ expiresAt: at(0), expiresRoleKey: SLUG }, SLUG, NOW)).toBe(
      'expired',
    );
  });

  it("fails closed: a present-but-unparseable expiresAt for this slug reads 'expired', never 'none'", () => {
    expect(
      customGrantStatus({ expiresAt: 'not-a-date', expiresRoleKey: SLUG }, SLUG, NOW),
    ).toBe('expired');
  });

  it('reads Firestore-Timestamp-shaped and ISO-string instants', () => {
    const pastSeconds = Math.floor(at(-3600000).getTime() / 1000);
    const tsLike = {
      seconds: pastSeconds,
      nanoseconds: 0,
      toDate: () => new Date(pastSeconds * 1000),
    };
    expect(customGrantStatus({ expiresAt: tsLike, expiresRoleKey: SLUG }, SLUG, NOW)).toBe(
      'expired',
    );
    expect(
      customGrantStatus(
        { expiresAt: at(-3600000).toISOString(), expiresRoleKey: SLUG },
        SLUG,
        NOW,
      ),
    ).toBe('expired');
  });

  it("'expiring' inside the 30-day window (governors T-30 stage)", () => {
    expect(customGrantStatus({ expiresAt: at(3600000), expiresRoleKey: SLUG }, SLUG, NOW)).toBe(
      'expiring',
    );
    expect(customGrantStatus({ expiresAt: at(7 * DAY), expiresRoleKey: SLUG }, SLUG, NOW)).toBe(
      'expiring',
    );
    expect(customGrantStatus({ expiresAt: at(30 * DAY), expiresRoleKey: SLUG }, SLUG, NOW)).toBe(
      'expiring',
    );
  });

  it("'active' beyond the 30-day window", () => {
    expect(customGrantStatus({ expiresAt: at(31 * DAY), expiresRoleKey: SLUG }, SLUG, NOW)).toBe(
      'active',
    );
    expect(customGrantStatus({ expiresAt: at(90 * DAY), expiresRoleKey: SLUG }, SLUG, NOW)).toBe(
      'active',
    );
  });
});

describe('reserved permission keys (contracts s.1.5)', () => {
  it('the ban list is exactly canManagePermissions + canManageRoles', () => {
    expect(RESERVED_PERMISSION_KEYS_FOR_CUSTOM_ROLES).toEqual([
      'canManagePermissions',
      'canManageRoles',
    ]);
  });
});

describe('T1.4 invariant scan: the custom_ prefix is decisive', () => {
  it('the prefix constant is custom_', () => {
    expect(CUSTOM_ROLE_PREFIX).toBe('custom_');
  });

  it('no catalog key starts with custom_', () => {
    for (const key of CATALOG_ROLE_KEYS) {
      expect(normalizeRoleSlug(key).startsWith(CUSTOM_ROLE_PREFIX)).toBe(false);
    }
  });

  it('no LEGACY_TO_CATALOG key or value starts with custom_', () => {
    for (const key of Object.keys(LEGACY_TO_CATALOG)) {
      expect(normalizeRoleSlug(key).startsWith(CUSTOM_ROLE_PREFIX)).toBe(false);
    }
    for (const value of Object.values(LEGACY_TO_CATALOG)) {
      expect(normalizeRoleSlug(value).startsWith(CUSTOM_ROLE_PREFIX)).toBe(false);
    }
  });
});
