/**
 * T1 (RESOLUTION-AI plan s.6) - the pure custom-role core in
 * src/lib/custom-role.ts: slug test, the spec s.10 four-part definition
 * test, definition title order (assumption A2: title -> name -> label),
 * and the typed-shape converter. Plus T1.4, the invariant scan that
 * backs plan s.3.2's decisive-prefix claim: no catalog key and no legacy
 * key or value may start with `custom_`.
 */
import {
  CUSTOM_ROLE_PREFIX,
  isCustomRoleSlug,
  isCustomRoleDefinition,
  definitionTitle,
  toCustomRoleDefinition,
  type CustomRoleDefinitionLike,
} from '../custom-role';
import {
  CATALOG_ROLE_KEYS,
  LEGACY_TO_CATALOG,
  normalizeRoleSlug,
} from '../role-catalog';

const VALID_DEF: CustomRoleDefinitionLike = {
  isCustom: true,
  parentRoleKey: 'chapter_design_chair',
  chapterId: 'seds-ist-chapter',
  title: 'Poster Team Lead',
};

describe('isCustomRoleSlug', () => {
  it('accepts custom_-prefixed slugs', () => {
    expect(isCustomRoleSlug('custom_poster_team_lead')).toBe(true);
  });

  it('rejects the bare prefix alone', () => {
    expect(isCustomRoleSlug('custom_')).toBe(false);
    expect(isCustomRoleSlug('custom')).toBe(false);
  });

  it('normalises before testing (case and separators)', () => {
    expect(isCustomRoleSlug('CUSTOM_X')).toBe(true);
    expect(isCustomRoleSlug('Custom_Poster Team Lead')).toBe(true);
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

describe('isCustomRoleDefinition (spec s.10 four-part test)', () => {
  it('accepts a fully valid definition', () => {
    expect(isCustomRoleDefinition('custom_poster_team_lead', VALID_DEF)).toBe(true);
  });

  it('requires isCustom === true', () => {
    const { isCustom: _drop, ...noFlag } = VALID_DEF;
    expect(isCustomRoleDefinition('custom_poster_team_lead', noFlag)).toBe(false);
    expect(
      isCustomRoleDefinition('custom_poster_team_lead', { ...VALID_DEF, isCustom: false }),
    ).toBe(false);
    expect(
      isCustomRoleDefinition('custom_poster_team_lead', { ...VALID_DEF, isCustom: 'true' }),
    ).toBe(false);
  });

  it('requires parentRoleKey to be a catalog key (a legacy token FAILS)', () => {
    expect(
      isCustomRoleDefinition('custom_poster_team_lead', {
        ...VALID_DEF,
        parentRoleKey: 'chair_events',
      }),
    ).toBe(false);
    expect(
      isCustomRoleDefinition('custom_poster_team_lead', {
        ...VALID_DEF,
        parentRoleKey: 'custom_other_role',
      }),
    ).toBe(false);
    const { parentRoleKey: _drop, ...noParent } = VALID_DEF;
    expect(isCustomRoleDefinition('custom_poster_team_lead', noParent)).toBe(false);
  });

  it('requires a non-empty string chapterId', () => {
    expect(
      isCustomRoleDefinition('custom_poster_team_lead', { ...VALID_DEF, chapterId: '' }),
    ).toBe(false);
    expect(
      isCustomRoleDefinition('custom_poster_team_lead', { ...VALID_DEF, chapterId: '   ' }),
    ).toBe(false);
    expect(
      isCustomRoleDefinition('custom_poster_team_lead', { ...VALID_DEF, chapterId: 42 }),
    ).toBe(false);
    const { chapterId: _drop, ...noChapter } = VALID_DEF;
    expect(isCustomRoleDefinition('custom_poster_team_lead', noChapter)).toBe(false);
  });

  it('rejects junk slugs on the slug prong alone, however valid the data', () => {
    for (const slug of [
      'pakistan-president',
      'super_admin',
      'chair_design_media',
      'advisor_faculty_head',
    ]) {
      expect(isCustomRoleDefinition(slug, VALID_DEF)).toBe(false);
    }
  });

  it('rejects missing definition data and non-string slugs', () => {
    expect(isCustomRoleDefinition('custom_poster_team_lead', null)).toBe(false);
    expect(isCustomRoleDefinition('custom_poster_team_lead', undefined)).toBe(false);
    expect(isCustomRoleDefinition(null, VALID_DEF)).toBe(false);
  });
});

describe('definitionTitle (A2 order: title -> name -> label)', () => {
  it('prefers title, trimmed', () => {
    expect(
      definitionTitle({ title: '  Poster Lead  ', name: 'Name', label: 'Label' }),
    ).toBe('Poster Lead');
  });

  it('skips whitespace-only and non-string values', () => {
    expect(definitionTitle({ title: '   ', name: 'Name Wins', label: 'Label' })).toBe(
      'Name Wins',
    );
    expect(definitionTitle({ title: 42, name: 'Name Wins' })).toBe('Name Wins');
    expect(definitionTitle({ name: '', label: 'Label Wins' })).toBe('Label Wins');
  });

  it('returns null when no title field carries text', () => {
    expect(definitionTitle({})).toBeNull();
    expect(definitionTitle({ title: '', name: ' ', label: undefined })).toBeNull();
  });
});

describe('toCustomRoleDefinition', () => {
  it('produces the typed shape with the normalised slug', () => {
    expect(
      toCustomRoleDefinition('CUSTOM_Poster_Team_Lead', {
        ...VALID_DEF,
        description: 'Leads the poster team.',
      }),
    ).toEqual({
      slug: 'custom_poster_team_lead',
      title: 'Poster Team Lead',
      description: 'Leads the poster team.',
      parentRoleKey: 'chapter_design_chair',
      chapterId: 'seds-ist-chapter',
    });
  });

  it('reads description via description ?? responsibilities, strings only (A3)', () => {
    expect(
      toCustomRoleDefinition('custom_poster_team_lead', {
        ...VALID_DEF,
        responsibilities: 'Runs the poster crew.',
      })?.description,
    ).toBe('Runs the poster crew.');
    expect(
      toCustomRoleDefinition('custom_poster_team_lead', { ...VALID_DEF })?.description,
    ).toBe('');
    expect(
      toCustomRoleDefinition('custom_poster_team_lead', {
        ...VALID_DEF,
        description: 42,
        responsibilities: 'Runs the poster crew.',
      })?.description,
    ).toBe('');
  });

  it('carries a null title when the definition has none', () => {
    const { title: _drop, ...noTitle } = VALID_DEF;
    expect(toCustomRoleDefinition('custom_poster_team_lead', noTitle)?.title).toBeNull();
  });

  it('returns null for definitions that fail the four-part test', () => {
    const { chapterId: _drop, ...noChapter } = VALID_DEF;
    expect(toCustomRoleDefinition('custom_poster_team_lead', noChapter)).toBeNull();
    expect(toCustomRoleDefinition('pakistan-president', VALID_DEF)).toBeNull();
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
