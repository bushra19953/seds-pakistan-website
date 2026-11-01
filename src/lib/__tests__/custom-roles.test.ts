/**
 * DATA-MODEL plan section 8 - pure core tests for src/lib/custom-roles.ts.
 *
 * Surface pinned by globals/contracts.md section 4.2: slug grammar
 * (section 1.1 a-d), the four-part definition test (spec section 10),
 * title resolution (section 4.5 steps 3/5) and the grant-status
 * derivation (section 2.2). The core imports only ./role-catalog, so
 * these tests need no mocks.
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
} from '@/lib/custom-roles';

const SLUG = 'custom_poster_team_lead';
const CHAPTER = 'seds-ist-chapter';

describe('CUSTOM_ROLE_PREFIX / reserved keys (contracts 1.1, 1.5, 4.2)', () => {
  it('prefix is custom_', () => {
    expect(CUSTOM_ROLE_PREFIX).toBe('custom_');
  });

  it('reserved keys are exactly the two Reserved Powers', () => {
    expect([...RESERVED_PERMISSION_KEYS_FOR_CUSTOM_ROLES].sort()).toEqual(
      ['canManagePermissions', 'canManageRoles'].sort(),
    );
  });
});

describe('isCustomRoleSlug (plan 1.1 - cheap partition test)', () => {
  it('accepts a prefixed slug with a non-empty remainder', () => {
    expect(isCustomRoleSlug('custom_poster_team_lead')).toBe(true);
    expect(isCustomRoleSlug('custom_x')).toBe(true);
  });

  it('rejects the bare prefix, non-custom slugs and non-strings', () => {
    expect(isCustomRoleSlug('custom_')).toBe(false);
    expect(isCustomRoleSlug('poster_team_lead')).toBe(false);
    expect(isCustomRoleSlug('chapter_design_chair')).toBe(false);
    expect(isCustomRoleSlug('')).toBe(false);
    expect(isCustomRoleSlug(null)).toBe(false);
    expect(isCustomRoleSlug(undefined)).toBe(false);
    expect(isCustomRoleSlug(42)).toBe(false);
  });
});

describe('buildCustomRoleSlug (contracts 1.1 - the client builds the slug)', () => {
  it('prefixes the normalised display name', () => {
    expect(buildCustomRoleSlug('Poster Team Lead')).toBe('custom_poster_team_lead');
  });
});

describe('validateCustomSlug (contracts 1.1 a-d)', () => {
  it('accepts a lawful custom slug', () => {
    expect(validateCustomSlug('custom_poster_team_lead')).toEqual({ ok: true });
  });

  it('rejects the bare prefix (empty remainder)', () => {
    const r = validateCustomSlug('custom_');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
  });

  it.each(['Custom_X', 'custom_x_', 'custom__x'])(
    'rejects the non-normalised slug %s',
    (slug) => {
      expect(validateCustomSlug(slug).ok).toBe(false);
    },
  );

  it.each([
    'custom_chapter_design_chair', // remainder is a catalog key
    'custom_president_national', // remainder is a catalog key
    'custom_vice_president', // remainder is abolished (Art. 12.3)
    'custom_superadmin', // remainder is a legacy token
    'custom_chair_events', // remainder is a legacy token
  ])('rejects the squatting slug %s', (slug) => {
    const r = validateCustomSlug(slug);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
  });
});

describe('validateCustomSlug reserved stems (ADDENDUM R6, possessive exception)', () => {
  it.each([
    "President's Executive Apprentice", // straight apostrophe
    'President’s Executive Apprentice', // curly apostrophe slugifies identically
    "Founder's Circle Lead",
  ])('accepts the possessive display name %s', (name) => {
    expect(validateCustomSlug(buildCustomRoleSlug(name))).toEqual({ ok: true });
  });

  it('accepts the possessive slug forms directly', () => {
    expect(validateCustomSlug('custom_president_s_executive_apprentice')).toEqual({ ok: true });
    expect(validateCustomSlug('custom_founder_s_circle_lead')).toEqual({ ok: true });
  });

  it.each(['President', 'Founder'])('rejects the bare-stem display name %s', (name) => {
    expect(validateCustomSlug(buildCustomRoleSlug(name)).ok).toBe(false);
  });

  it.each(['President of Chapters', 'Superadmin Assistant'])(
    'rejects the bare-stem display name %s under the reserved-stem clause',
    (name) => {
      const r = validateCustomSlug(buildCustomRoleSlug(name));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('reserved stem');
    },
  );

  it('rejects the bare-stem slug custom_president_assistant (the original R6 case)', () => {
    const r = validateCustomSlug('custom_president_assistant');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('reserved stem');
  });

  it('accepts a normal title with no reserved stem', () => {
    expect(
      validateCustomSlug(buildCustomRoleSlug('Chapter Governance and Review Coordinator')),
    ).toEqual({ ok: true });
  });
});

describe('toCustomRoleDefinition (contracts 4.2 - the four-part test)', () => {
  const validDoc: Record<string, unknown> = {
    isCustom: true,
    name: 'Poster Team Lead',
    label: 'Poster Team Lead',
    description: 'Runs the poster team',
    parentRoleKey: 'chapter_design_chair',
    chapterId: CHAPTER,
    permissions: ['canManageTasks', 'canViewAnalytics'],
    isActive: true,
    defaultTermDays: 90,
  };

  it('maps a full valid doc', () => {
    const def = toCustomRoleDefinition(SLUG, validDoc);
    expect(def).not.toBeNull();
    expect(def).toEqual({
      slug: SLUG,
      name: 'Poster Team Lead',
      description: 'Runs the poster team',
      parentRoleKey: 'chapter_design_chair',
      chapterId: CHAPTER,
      permissions: ['canManageTasks', 'canViewAnalytics'],
      isActive: true,
      defaultTermDays: 90,
    });
  });

  it('takes the title from `name`, falling back to the `label` mirror, never `title`', () => {
    const fromLabel = toCustomRoleDefinition(SLUG, {
      ...validDoc,
      name: '',
      label: 'Label Title',
      title: 'Wrong Field',
    });
    expect(fromLabel?.name).toBe('Label Title');

    const noName = toCustomRoleDefinition(SLUG, {
      ...validDoc,
      name: undefined,
      label: undefined,
      title: 'Wrong Field',
    });
    expect(noName?.name).toBe('');
  });

  it('falls back to `responsibilities` for the description', () => {
    const def = toCustomRoleDefinition(SLUG, {
      ...validDoc,
      description: undefined,
      responsibilities: 'Legacy responsibilities text',
    });
    expect(def?.description).toBe('Legacy responsibilities text');
  });

  it('keeps only string permission entries, verbatim (K1 stored field)', () => {
    const def = toCustomRoleDefinition(SLUG, {
      ...validDoc,
      permissions: ['canManageTasks', 42, null, 'canViewAnalytics', { k: 1 }],
    });
    expect(def?.permissions).toEqual(['canManageTasks', 'canViewAnalytics']);
  });

  it('defaults isActive to true and honours an explicit false', () => {
    const absent = toCustomRoleDefinition(SLUG, { ...validDoc, isActive: undefined });
    expect(absent?.isActive).toBe(true);
    const off = toCustomRoleDefinition(SLUG, { ...validDoc, isActive: false });
    expect(off?.isActive).toBe(false);
  });

  it.each([
    ['zero', 0],
    ['negative', -3],
    ['fractional', 2.5],
    ['string', '90'],
    ['absent', undefined],
    ['null', null],
  ])('coerces a %s defaultTermDays to null (contracts 1.4)', (_label, value) => {
    const def = toCustomRoleDefinition(SLUG, { ...validDoc, defaultTermDays: value });
    expect(def?.defaultTermDays).toBeNull();
  });

  it('keeps a positive-integer defaultTermDays', () => {
    const def = toCustomRoleDefinition(SLUG, { ...validDoc, defaultTermDays: 45 });
    expect(def?.defaultTermDays).toBe(45);
  });

  it('returns null when the data is missing entirely', () => {
    expect(toCustomRoleDefinition(SLUG, undefined)).toBeNull();
  });

  it('returns null when isCustom is missing or not exactly true', () => {
    const { isCustom: _dropped, ...noFlag } = validDoc;
    expect(toCustomRoleDefinition(SLUG, noFlag)).toBeNull();
    expect(toCustomRoleDefinition(SLUG, { ...validDoc, isCustom: 'true' })).toBeNull();
    expect(toCustomRoleDefinition(SLUG, { ...validDoc, isCustom: false })).toBeNull();
  });

  it.each([
    ['legacy token', 'chair_events'],
    ['custom slug', 'custom_other_role'],
    ['junk slug', 'pakistan-president'],
    ['missing', undefined],
    ['non-string', 42],
  ])('returns null for a %s parentRoleKey', (_label, parentRoleKey) => {
    expect(toCustomRoleDefinition(SLUG, { ...validDoc, parentRoleKey })).toBeNull();
  });

  it('returns null for an empty or missing chapterId', () => {
    expect(toCustomRoleDefinition(SLUG, { ...validDoc, chapterId: '' })).toBeNull();
    expect(toCustomRoleDefinition(SLUG, { ...validDoc, chapterId: undefined })).toBeNull();
  });

  it.each(['pakistan-president', 'super-admin', 'chair-design-media', 'advisor-faculty-head'])(
    'returns null for the junk slug %s even with an otherwise valid doc',
    (junkSlug) => {
      expect(toCustomRoleDefinition(junkSlug, validDoc)).toBeNull();
    },
  );

  it('returns null for a catalog slug even with an otherwise valid doc', () => {
    expect(toCustomRoleDefinition('chapter_design_chair', validDoc)).toBeNull();
  });
});

describe('customRoleTitle (contracts 4.5 steps 3 and 5)', () => {
  const def = toCustomRoleDefinition(SLUG, {
    isCustom: true,
    name: 'Poster Team Lead',
    parentRoleKey: 'chapter_design_chair',
    chapterId: CHAPTER,
    permissions: [],
  });

  it('prefers the definition name', () => {
    expect(def).not.toBeNull();
    expect(customRoleTitle(def, SLUG)).toBe('Poster Team Lead');
  });

  it('humanises the slug when no definition is at hand', () => {
    expect(customRoleTitle(null, SLUG)).toBe('Poster Team Lead');
  });

  it('humanises the slug when the definition name is blank', () => {
    expect(customRoleTitle({ name: '   ' }, SLUG)).toBe('Poster Team Lead');
  });

  it('never returns the raw slug, Guest or Basic Member', () => {
    const title = customRoleTitle(null, SLUG);
    expect(title).not.toBe(SLUG);
    expect(title).not.toBe('Guest');
    expect(title).not.toBe('Basic Member');
  });
});

describe('customGrantStatus (contracts 2.2 derivation; plan C9 window)', () => {
  const NOW = new Date('2026-10-23T00:00:00.000Z');
  const DAY = 24 * 60 * 60 * 1000;
  const at = (ms: number) => new Date(NOW.getTime() + ms);

  it('is none when the doc carries no expiry fields', () => {
    expect(customGrantStatus({}, SLUG, NOW)).toBe('none');
    expect(customGrantStatus({ expiresAt: null, expiresRoleKey: SLUG }, SLUG, NOW)).toBe('none');
  });

  it('is none when the expiry belongs to a different role', () => {
    expect(
      customGrantStatus({ expiresAt: at(-DAY), expiresRoleKey: 'custom_other_role' }, SLUG, NOW),
    ).toBe('none');
  });

  it('is active when expiry is more than 30 days out', () => {
    expect(customGrantStatus({ expiresAt: at(31 * DAY), expiresRoleKey: SLUG }, SLUG, NOW)).toBe(
      'active',
    );
    expect(customGrantStatus({ expiresAt: at(90 * DAY), expiresRoleKey: SLUG }, SLUG, NOW)).toBe(
      'active',
    );
  });

  it('is expiring at or below 30 days out', () => {
    expect(customGrantStatus({ expiresAt: at(30 * DAY), expiresRoleKey: SLUG }, SLUG, NOW)).toBe(
      'expiring',
    );
    expect(customGrantStatus({ expiresAt: at(7 * DAY), expiresRoleKey: SLUG }, SLUG, NOW)).toBe(
      'expiring',
    );
  });

  it('is expired once now reaches the instant (exclusive end)', () => {
    expect(customGrantStatus({ expiresAt: at(-DAY), expiresRoleKey: SLUG }, SLUG, NOW)).toBe(
      'expired',
    );
    expect(customGrantStatus({ expiresAt: at(0), expiresRoleKey: SLUG }, SLUG, NOW)).toBe(
      'expired',
    );
  });

  it('accepts a millis number and an ISO string', () => {
    const target = at(10 * DAY);
    expect(
      customGrantStatus({ expiresAt: target.getTime(), expiresRoleKey: SLUG }, SLUG, NOW),
    ).toBe('expiring');
    expect(
      customGrantStatus({ expiresAt: target.toISOString(), expiresRoleKey: SLUG }, SLUG, NOW),
    ).toBe('expiring');
  });

  it('resolves Firestore Timestamp-like values ({ seconds }, { _seconds }, toDate())', () => {
    const target = at(10 * DAY);
    const seconds = Math.floor(target.getTime() / 1000);
    expect(customGrantStatus({ expiresAt: { seconds }, expiresRoleKey: SLUG }, SLUG, NOW)).toBe(
      'expiring',
    );
    expect(
      customGrantStatus({ expiresAt: { _seconds: seconds }, expiresRoleKey: SLUG }, SLUG, NOW),
    ).toBe('expiring');
    expect(
      customGrantStatus({ expiresAt: { toDate: () => target }, expiresRoleKey: SLUG }, SLUG, NOW),
    ).toBe('expiring');
  });

  it('treats a present but unparseable expiresAt as expired (plan 1.6: never silently alive)', () => {
    expect(
      customGrantStatus({ expiresAt: 'not-a-date', expiresRoleKey: SLUG }, SLUG, NOW),
    ).toBe('expired');
  });
});
