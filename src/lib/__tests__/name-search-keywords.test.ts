/**
 * @jest-environment node
 *
 * Pins for the directory fixes (branch fix/directory-case-search):
 *  1. The name-search keywords scheme (option (c)): tokens plus
 *     prefixes, so directory name search is a bounded array-contains
 *     query instead of a windowed scan.
 *  2. The role-option invariant behind the CASE defect: every option
 *     value the directory dropdown can send equals its stored slug
 *     form (lowercase, slug-normalized, a catalog key). A future
 *     capitalized option ("Chapter_vice_president") fails here
 *     loudly, at the source, instead of returning 0 people live.
 *  3. The main signup write path maintains the index field.
 */

import {
  buildNameSearchKeywords,
  nameSearchKeywordForTerm,
  docHasNameKeyword,
  NAME_SEARCH_KEYWORDS_FIELD,
} from '@/lib/name-search-keywords';
import { ROLE_CATALOG, CATALOG_ROLE_KEYS, normalizeRoleSlug } from '@/lib/role-catalog';
import { getUnifiedRoleOptions } from '@/lib/unified-roles';
import { buildNewUserProfileData } from '@/lib/auth/ensure-user-profile';

describe('buildNameSearchKeywords', () => {
  it('indexes each token and its prefixes of length >= 2', () => {
    const kw = buildNameSearchKeywords('Muhammad Huzaifah Shujjah');
    for (const expected of [
      'muhammad', 'mu', 'muham',
      'huzaifah', 'hu', 'huza', 'huzaif',
      'shujjah', 'sh', 'shuj',
    ]) {
      expect(kw).toContain(expected);
    }
  });

  it('does NOT index infixes: "uzaif" is not a keyword of "Huzaifah"', () => {
    const kw = buildNameSearchKeywords('Huzaifah Shujjah');
    expect(kw).not.toContain('uzaifah');
    expect(kw).not.toContain('uzaif');
  });

  it('lowercases, splits on non-alphanumerics, dedupes, tolerates empty input', () => {
    expect(buildNameSearchKeywords('  Huzaifah   Huzaifah ')).toEqual(
      buildNameSearchKeywords('huzaifah'),
    );
    expect(buildNameSearchKeywords('')).toEqual([]);
    expect(buildNameSearchKeywords(null)).toEqual([]);
    expect(buildNameSearchKeywords(undefined)).toEqual([]);
    expect(buildNameSearchKeywords("Maryam Al-Sayed")).toContain('sayed');
  });
});

describe('nameSearchKeywordForTerm', () => {
  it('resolves a typed term to the stored keyword form', () => {
    expect(nameSearchKeywordForTerm('Huza')).toBe('huza');
    expect(nameSearchKeywordForTerm('huzaifah')).toBe('huzaifah');
  });

  it('refuses terms the index cannot serve', () => {
    expect(nameSearchKeywordForTerm('h')).toBeNull(); // below min prefix
    expect(nameSearchKeywordForTerm('vera@example.com')).toBeNull(); // email probe's job
    expect(nameSearchKeywordForTerm('')).toBeNull();
  });
});

describe('docHasNameKeyword', () => {
  it('only true index holders pass, whatever else the backend returned', () => {
    const kw = buildNameSearchKeywords('Huzaifah Shujjah');
    expect(docHasNameKeyword({ [NAME_SEARCH_KEYWORDS_FIELD]: kw }, 'huza')).toBe(true);
    expect(docHasNameKeyword({ displayName: 'Huzaifah Shujjah' }, 'huza')).toBe(false);
    expect(docHasNameKeyword(null, 'huza')).toBe(false);
  });
});

describe('directory role options: every value equals its stored slug', () => {
  it('option keys are slug-form catalog keys, labels stay humanized', async () => {
    // No chapterId: catalog-only options, firestore is never read.
    const options = await getUnifiedRoleOptions(null as any, 'some-non-founder-uid');
    expect(options.length).toBeGreaterThan(0);
    const catalog = new Set<string>(CATALOG_ROLE_KEYS as readonly string[]);
    for (const opt of options) {
      // The case invariant: value === stored slug form.
      expect(opt.key).toBe(opt.key.toLowerCase());
      expect(opt.key).toBe(normalizeRoleSlug(opt.key));
      expect(catalog.has(opt.key)).toBe(true);
      // Label is the humanized title carrying the slug, never the value.
      expect(opt.label).toContain(`(${opt.key})`);
    }
    // The defect's exact role: value is the lowercase stored slug,
    // label is the human title.
    const vp = options.find((o) => o.key === 'chapter_vice_president');
    expect(vp).toBeDefined();
    expect(vp!.label).toBe('Chapter Vice President (chapter_vice_president)');
    // Every catalog role is offered (founder_patron is founder-only).
    const offered = new Set(options.map((o) => o.key));
    for (const role of ROLE_CATALOG) {
      if (role.key === 'founder_patron') continue;
      expect(offered.has(role.key)).toBe(true);
    }
  });
});

describe('signup CREATE payloads must NOT carry the index field', () => {
  // The user-create Firestore rules carry a hasOnly allow-list that
  // does not include nameSearchKeywords: folding the field into a
  // create payload could deny the whole signup write. The signup
  // forms therefore write the index as a separate post-create merge
  // (owner updates have no allow-list), and the shared profile
  // builder used for creates stays allow-list clean - pinned here
  // so nobody re-adds it.
  it('buildNewUserProfileData has no nameSearchKeywords key', () => {
    const data = buildNewUserProfileData({
      uid: 'u-1',
      email: 'huzaifah@example.com',
      photoURL: null,
      displayName: 'Huzaifah Shujjah',
    } as any);
    expect(data.displayName).toBe('Huzaifah Shujjah');
    expect(Object.keys(data)).not.toContain(NAME_SEARCH_KEYWORDS_FIELD);
  });
});
