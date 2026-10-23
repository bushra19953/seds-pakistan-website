/**
 * DATA-MODEL plan section 8 - getUnifiedRoleOptions chapter behaviour
 * (plan section 4, contracts 4.2).
 *
 * Without a chapterId the output must be byte-identical to today's
 * catalog-only construction (both existing callers untouched, plan
 * C5). With a chapterId, the chapter's ACTIVE custom definitions are
 * appended in the existing label format and the combined list is
 * sorted by key; inactive and other-chapter definitions stay out.
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

import { getUnifiedRoleOptions } from '@/lib/unified-roles';
import { ROLE_CATALOG } from '@/lib/role-catalog';
import { FOUNDER_UID } from '@/config/founder';
import { invalidateRoleDefinitionsCache } from '@/lib/role-definitions';

const IST = 'seds-ist-chapter';
const LHR = 'seds-lhr-chapter';

function doc(id: string, data: Record<string, unknown>) {
  return { id, data: () => ({ slug: id, ...data }) };
}

function expectedCatalogOptions(uid?: string) {
  return ROLE_CATALOG.filter((r) => uid === FOUNDER_UID || r.key !== 'founder_patron')
    .map((r) => ({ key: r.key as string, label: `${r.title} (${r.key})` }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

const fakeFirestore = {} as never;

beforeEach(() => {
  mockDocs = [
    doc('custom_poster_team_lead', {
      name: 'Poster Team Lead',
      isCustom: true,
      parentRoleKey: 'chapter_design_chair',
      chapterId: IST,
      permissions: ['canManageTasks'],
      isActive: true,
    }),
    doc('custom_alpha_role', {
      name: 'Alpha Role',
      isCustom: true,
      parentRoleKey: 'chapter_events_chair',
      chapterId: IST,
      permissions: [],
    }),
    doc('custom_event_helper', {
      name: 'Event Helper',
      isCustom: true,
      parentRoleKey: 'chapter_events_chair',
      chapterId: LHR,
      permissions: [],
      isActive: false,
    }),
    doc('super-admin', { name: 'Super Admin', permissions: [] }),
  ];
  invalidateRoleDefinitionsCache();
});

describe('getUnifiedRoleOptions without a chapterId (unchanged behaviour)', () => {
  it('deep-equals the catalog-only construction for a non-founder', async () => {
    const options = await getUnifiedRoleOptions(fakeFirestore, 'some-user');
    expect(options).toEqual(expectedCatalogOptions('some-user'));
    expect(options.map((o) => o.key)).not.toContain('founder_patron');
    expect(options.map((o) => o.key)).not.toContain('custom_poster_team_lead');
  });

  it('keeps the founder_patron rule for the founder', async () => {
    const options = await getUnifiedRoleOptions(fakeFirestore, FOUNDER_UID);
    expect(options).toEqual(expectedCatalogOptions(FOUNDER_UID));
    expect(options.map((o) => o.key)).toContain('founder_patron');
  });
});

describe('getUnifiedRoleOptions with a chapterId (contracts 4.2)', () => {
  it('appends the chapter custom options in the pinned label format, combined-sorted', async () => {
    const options = await getUnifiedRoleOptions(fakeFirestore, 'some-user', IST);
    const expected = [
      ...expectedCatalogOptions('some-user'),
      { key: 'custom_alpha_role', label: 'Alpha Role (custom_alpha_role)' },
      { key: 'custom_poster_team_lead', label: 'Poster Team Lead (custom_poster_team_lead)' },
    ].sort((a, b) => a.key.localeCompare(b.key));
    expect(options).toEqual(expected);
  });

  it('keeps out inactive, other-chapter and junk definitions', async () => {
    const options = await getUnifiedRoleOptions(fakeFirestore, 'some-user', IST);
    const keys = options.map((o) => o.key);
    expect(keys).not.toContain('custom_event_helper'); // inactive + other chapter
    expect(keys).not.toContain('super-admin');
  });

  it('returns catalog-only output for a chapter whose only custom role is inactive', async () => {
    const options = await getUnifiedRoleOptions(fakeFirestore, 'some-user', LHR);
    expect(options).toEqual(expectedCatalogOptions('some-user'));
  });
});
