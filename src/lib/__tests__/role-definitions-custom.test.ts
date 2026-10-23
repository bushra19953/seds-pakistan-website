/**
 * DATA-MODEL plan section 8 - client adapter tests for
 * src/lib/role-definitions.ts (plan section 2).
 *
 * The cached mapper must carry the contracts 1.2 custom fields through
 * its whitelist (tolerating junk values without throwing), and
 * getCustomRoleDefinitions (contracts 4.2 client adapter) must return
 * only four-part-test custom definitions: chapter-filtered, inactive
 * excluded unless asked, junk never returned, sorted by slug.
 */

let mockDocs: Array<{ id: string; data: () => Record<string, unknown> }> = [];

jest.mock('firebase/firestore', () => ({
  collection: jest.fn((_db: unknown, name: string) => ({ _collection: name })),
  doc: jest.fn(() => ({})),
  getDocs: jest.fn(async () => ({ docs: mockDocs })),
  serverTimestamp: jest.fn(() => ({})),
}));

jest.mock('@/lib/client/firestore-wrapper', () => ({
  setDoc: jest.fn(async () => undefined),
}));

import {
  getAllRoleDefinitionsCached,
  getCustomRoleDefinitions,
  invalidateRoleDefinitionsCache,
} from '@/lib/role-definitions';

const IST = 'seds-ist-chapter';
const LHR = 'seds-lhr-chapter';

function doc(id: string, data: Record<string, unknown>) {
  return { id, data: () => ({ slug: id, ...data }) };
}

const POSTER_LEAD = doc('custom_poster_team_lead', {
  name: 'Poster Team Lead',
  label: 'Poster Team Lead',
  description: 'Runs the poster team',
  isCustom: true,
  parentRoleKey: 'chapter_design_chair',
  chapterId: IST,
  permissions: ['canManageTasks'],
  isActive: true,
  defaultTermDays: 90,
});

const ALPHA_ROLE = doc('custom_alpha_role', {
  name: 'Alpha Role',
  isCustom: true,
  parentRoleKey: 'chapter_events_chair',
  chapterId: IST,
  permissions: [],
});

const EVENT_HELPER_INACTIVE = doc('custom_event_helper', {
  name: 'Event Helper',
  isCustom: true,
  parentRoleKey: 'chapter_events_chair',
  chapterId: LHR,
  permissions: [],
  isActive: false,
});

const JUNK_DOC = doc('super-admin', {
  name: 'Super Admin',
  permissions: [],
});

const CATALOG_DOC = doc('member', {
  name: 'Full Member',
  description: 'Catalog member definition',
});

const BROKEN_FIELDS_DOC = doc('custom_broken_fields', {
  name: 'Broken Fields',
  isCustom: 'yes', // string, not boolean true
  parentRoleKey: 42,
  chapterId: [IST],
  permissions: 'canManageTasks', // string, not an array
  defaultTermDays: 'soon',
});

const fakeFirestore = {} as never;

beforeEach(() => {
  mockDocs = [POSTER_LEAD, ALPHA_ROLE, EVENT_HELPER_INACTIVE, JUNK_DOC, CATALOG_DOC, BROKEN_FIELDS_DOC];
  invalidateRoleDefinitionsCache();
});

describe('getAllRoleDefinitionsCached mapper (plan 2.2)', () => {
  it('preserves the custom fields on a valid custom definition', async () => {
    const rows = await getAllRoleDefinitionsCached(fakeFirestore);
    const row = rows.find((r) => r.role === 'custom_poster_team_lead');
    expect(row).toBeDefined();
    expect(row?.isCustom).toBe(true);
    expect(row?.parentRoleKey).toBe('chapter_design_chair');
    expect(row?.chapterId).toBe(IST);
    expect(row?.permissions).toEqual(['canManageTasks']);
    expect(row?.defaultTermDays).toBe(90);
    expect(row?.name).toBe('Poster Team Lead');
  });

  it('tolerates junk field values without throwing and does not preserve them', async () => {
    const rows = await getAllRoleDefinitionsCached(fakeFirestore);
    const row = rows.find((r) => r.role === 'custom_broken_fields');
    expect(row).toBeDefined();
    expect(row?.isCustom).not.toBe(true);
    expect(row?.parentRoleKey).toBeUndefined();
    expect(row?.chapterId).toBeUndefined();
    expect(row?.permissions ?? []).toEqual([]);
    expect(row?.defaultTermDays ?? null).toBeNull();
  });
});

describe('getCustomRoleDefinitions (contracts 4.2 client adapter)', () => {
  it('returns only valid active custom definitions, sorted by slug', async () => {
    const defs = await getCustomRoleDefinitions(fakeFirestore);
    expect(defs.map((d) => d.slug)).toEqual(['custom_alpha_role', 'custom_poster_team_lead']);
  });

  it('maps the full definition shape', async () => {
    const defs = await getCustomRoleDefinitions(fakeFirestore, { chapterId: IST });
    const poster = defs.find((d) => d.slug === 'custom_poster_team_lead');
    expect(poster).toEqual({
      slug: 'custom_poster_team_lead',
      name: 'Poster Team Lead',
      description: 'Runs the poster team',
      parentRoleKey: 'chapter_design_chair',
      chapterId: IST,
      permissions: ['canManageTasks'],
      isActive: true,
      defaultTermDays: 90,
    });
  });

  it('filters by chapter', async () => {
    const ist = await getCustomRoleDefinitions(fakeFirestore, { chapterId: IST });
    expect(ist.map((d) => d.slug)).toEqual(['custom_alpha_role', 'custom_poster_team_lead']);
  });

  it('excludes inactive definitions by default, even in their own chapter', async () => {
    const lhr = await getCustomRoleDefinitions(fakeFirestore, { chapterId: LHR });
    expect(lhr).toEqual([]);
  });

  it('includes inactive definitions only with includeInactive', async () => {
    const lhr = await getCustomRoleDefinitions(fakeFirestore, {
      chapterId: LHR,
      includeInactive: true,
    });
    expect(lhr.map((d) => d.slug)).toEqual(['custom_event_helper']);
    expect(lhr[0].isActive).toBe(false);

    const all = await getCustomRoleDefinitions(fakeFirestore, { includeInactive: true });
    expect(all.map((d) => d.slug)).toEqual([
      'custom_alpha_role',
      'custom_event_helper',
      'custom_poster_team_lead',
    ]);
  });

  it('never returns junk, catalog or malformed docs', async () => {
    const defs = await getCustomRoleDefinitions(fakeFirestore, { includeInactive: true });
    const slugs = defs.map((d) => d.slug);
    expect(slugs).not.toContain('super-admin');
    expect(slugs).not.toContain('member');
    expect(slugs).not.toContain('custom_broken_fields');
  });
});
