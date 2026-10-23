/**
 * ASSIGN-PATH (Custom Roles Fix Program) - picker options tests for
 * src/lib/unified-roles.ts (plan sections 6 + 9, client suite 2).
 *
 * getCustomRoleOptions(firestore) reads roleDefinitions docs with
 * isCustom == true and keeps only docs passing the spec section 10
 * test client-side (isCustom === true, parentRoleKey a catalog key,
 * chapterId non-empty), excludes isActive === false, and labels each
 * option with the definition title (name || label || title || slug).
 *
 * The firestore mock returns ALL fixture docs from getDocs regardless
 * of the query constraints, so the client-side section 10 filtering is
 * what these tests measure; query/where are pass-through captures.
 *
 * getCustomRoleOptions is reached through a loose facade so the suite
 * compiles before the export exists and runs unchanged after.
 */

jest.mock('firebase/firestore', () => ({
  collection: jest.fn((_db: unknown, name: string) => ({ _collection: name })),
  query: jest.fn((ref: unknown, ...constraints: unknown[]) => ({ ref, constraints })),
  where: jest.fn((field: string, op: string, value: unknown) => ({ field, op, value })),
  getDocs: jest.fn(),
}));

import { getDocs } from 'firebase/firestore';
import { getUnifiedRoleOptions } from '../unified-roles';
import * as unifiedRoles from '../unified-roles';
import { isCatalogRoleKey } from '../role-catalog';

const FAKE_FS = {} as never;

type OptionsFn = (firestore: never) => Promise<Array<Record<string, unknown>>>;
const getCustomRoleOptions = (unifiedRoles as unknown as Record<string, OptionsFn>)
  .getCustomRoleOptions;

interface DefFixture {
  id: string;
  data: Record<string, unknown>;
}

function validDef(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    isCustom: true,
    parentRoleKey: 'chapter_design_chair',
    chapterId: 'seds-ist-chapter',
    permissions: [],
    isActive: true,
    ...overrides,
  };
}

const FIXTURES: DefFixture[] = [
  {
    id: 'custom_poster_team_lead',
    data: validDef({ name: 'Poster Team Lead', label: 'Poster Team Lead' }),
  },
  {
    id: 'custom_alpha_helper',
    data: validDef({
      name: 'Alpha Helper',
      parentRoleKey: 'chapter_events_chair',
      chapterId: 'seds-other-chapter',
    }),
  },
  {
    id: 'custom_label_only',
    data: validDef({ label: 'Label Only Title' }),
  },
  {
    id: 'custom_title_only',
    data: validDef({ title: 'Title Field Only' }),
  },
  // Excluded: retired definition.
  {
    id: 'custom_retired',
    data: validDef({ name: 'Retired Role', isActive: false }),
  },
  // Excluded: parentRoleKey is a legacy token, not a catalog key.
  {
    id: 'custom_bad_parent',
    data: validDef({ name: 'Bad Parent', parentRoleKey: 'chair_events' }),
  },
  // Excluded: chapterId empty.
  {
    id: 'custom_no_chapter',
    data: validDef({ name: 'No Chapter', chapterId: '' }),
  },
  // Excluded: isCustom flag missing (a hand-written custom_ doc).
  {
    id: 'custom_not_flagged',
    data: {
      parentRoleKey: 'chapter_design_chair',
      chapterId: 'seds-ist-chapter',
      isActive: true,
    },
  },
  // Excluded: an ordinary catalog definition doc, no isCustom flag.
  {
    id: 'member',
    data: { name: 'Full Member', isActive: true },
  },
  // Excluded: a junk legacy definition (invariant 10).
  {
    id: 'chair-design-media',
    data: { name: 'Chair Design Media', isActive: true },
  },
];

beforeEach(() => {
  (getDocs as jest.Mock).mockReset();
  (getDocs as jest.Mock).mockImplementation(async () => ({
    docs: FIXTURES.map((f) => ({ id: f.id, data: () => f.data })),
  }));
});

describe('getCustomRoleOptions', () => {
  it('is exported from unified-roles', () => {
    expect(typeof getCustomRoleOptions).toBe('function');
  });

  it('returns only section-10-valid, active custom definitions, sorted by key', async () => {
    const options = await getCustomRoleOptions(FAKE_FS);
    expect(options.map((o) => o.key)).toEqual([
      'custom_alpha_helper',
      'custom_label_only',
      'custom_poster_team_lead',
      'custom_title_only',
    ]);
  });

  it('labels use the definition title (name || label || title) in the unified label format', async () => {
    const options = await getCustomRoleOptions(FAKE_FS);
    const byKey = new Map(options.map((o) => [o.key, o]));
    expect(byKey.get('custom_poster_team_lead')?.label).toBe(
      'Poster Team Lead (custom_poster_team_lead)',
    );
    expect(byKey.get('custom_label_only')?.label).toBe(
      'Label Only Title (custom_label_only)',
    );
    expect(byKey.get('custom_title_only')?.label).toBe(
      'Title Field Only (custom_title_only)',
    );
  });

  it('options carry isCustom, chapterId and parentRoleKey for the users-table chapter filter', async () => {
    const options = await getCustomRoleOptions(FAKE_FS);
    const byKey = new Map(options.map((o) => [o.key, o]));
    expect(byKey.get('custom_poster_team_lead')).toMatchObject({
      isCustom: true,
      chapterId: 'seds-ist-chapter',
      parentRoleKey: 'chapter_design_chair',
    });
    expect(byKey.get('custom_alpha_helper')).toMatchObject({
      isCustom: true,
      chapterId: 'seds-other-chapter',
      parentRoleKey: 'chapter_events_chair',
    });
  });
});

describe('getUnifiedRoleOptions (regression pin: catalog only, unchanged)', () => {
  it('returns no custom entries and keeps the catalog label format', async () => {
    const options = await getUnifiedRoleOptions(FAKE_FS);
    expect(options.length).toBeGreaterThan(0);
    for (const opt of options) {
      expect(String(opt.key).startsWith('custom_')).toBe(false);
      expect(isCatalogRoleKey(opt.key)).toBe(true);
    }
    expect(options).toContainEqual({ key: 'member', label: 'Full Member (member)' });
    // founder_patron stays hidden for a non-founder caller (no uid).
    expect(options.map((o) => o.key)).not.toContain('founder_patron');
  });
});
