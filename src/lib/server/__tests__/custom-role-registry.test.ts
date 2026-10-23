/**
 * DATA-MODEL plan section 8 - server adapter tests for
 * src/lib/server/custom-role-registry.ts (plan section 3, contracts 4.2).
 *
 * Fake Admin db follows the consent-gate test pattern
 * (src/lib/server/__tests__/fake-firestore.ts). Per plan C10 the server
 * list returns definitions regardless of isActive; callers filter.
 */

import { createFakeDb, type FakeDb } from './fake-firestore';
import {
  getCustomRoleDefinition,
  listCustomRoleDefinitions,
} from '@/lib/server/custom-role-registry';

const IST = 'seds-ist-chapter';
const LHR = 'seds-lhr-chapter';

async function seed(db: FakeDb, slug: string, data: Record<string, unknown>) {
  await db.collection('roleDefinitions').doc(slug).set({ slug, ...data });
}

async function seededDb(): Promise<FakeDb> {
  const db = createFakeDb();
  await seed(db, 'custom_poster_team_lead', {
    name: 'Poster Team Lead',
    description: 'Runs the poster team',
    isCustom: true,
    parentRoleKey: 'chapter_design_chair',
    chapterId: IST,
    permissions: ['canManageTasks'],
    isActive: true,
    defaultTermDays: 90,
  });
  await seed(db, 'custom_alpha_role', {
    name: 'Alpha Role',
    isCustom: true,
    parentRoleKey: 'chapter_events_chair',
    chapterId: IST,
    permissions: [],
  });
  await seed(db, 'custom_event_helper', {
    name: 'Event Helper',
    isCustom: true,
    parentRoleKey: 'chapter_events_chair',
    chapterId: LHR,
    permissions: [],
    isActive: false,
  });
  await seed(db, 'custom_broken_fields', {
    name: 'Broken Fields',
    isCustom: 'yes',
    parentRoleKey: 'chapter_design_chair',
    chapterId: IST,
    permissions: [],
  });
  await seed(db, 'super-admin', { name: 'Super Admin', permissions: [] });
  await seed(db, 'member', { name: 'Full Member', description: 'Catalog definition' });
  return db;
}

describe('getCustomRoleDefinition', () => {
  it('returns the mapped definition for a valid custom doc', async () => {
    const db = await seededDb();
    const def = await getCustomRoleDefinition(db as never, 'custom_poster_team_lead');
    expect(def).toEqual({
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

  it('returns null for a missing doc', async () => {
    const db = await seededDb();
    await expect(
      getCustomRoleDefinition(db as never, 'custom_does_not_exist'),
    ).resolves.toBeNull();
  });

  it('returns null for a malformed doc (isCustom not exactly true)', async () => {
    const db = await seededDb();
    await expect(
      getCustomRoleDefinition(db as never, 'custom_broken_fields'),
    ).resolves.toBeNull();
  });

  it('returns null for junk and catalog docs', async () => {
    const db = await seededDb();
    await expect(getCustomRoleDefinition(db as never, 'super-admin')).resolves.toBeNull();
    await expect(getCustomRoleDefinition(db as never, 'member')).resolves.toBeNull();
  });
});

describe('listCustomRoleDefinitions', () => {
  it('lists every valid custom definition (inactive included), sorted by slug', async () => {
    const db = await seededDb();
    const defs = await listCustomRoleDefinitions(db as never);
    expect(defs.map((d) => d.slug)).toEqual([
      'custom_alpha_role',
      'custom_event_helper',
      'custom_poster_team_lead',
    ]);
    const helper = defs.find((d) => d.slug === 'custom_event_helper');
    expect(helper?.isActive).toBe(false);
  });

  it('filters by chapter when a chapterId is given', async () => {
    const db = await seededDb();
    const ist = await listCustomRoleDefinitions(db as never, IST);
    expect(ist.map((d) => d.slug)).toEqual(['custom_alpha_role', 'custom_poster_team_lead']);
    const lhr = await listCustomRoleDefinitions(db as never, LHR);
    expect(lhr.map((d) => d.slug)).toEqual(['custom_event_helper']);
  });

  it('returns an empty list for a chapter with no custom roles', async () => {
    const db = await seededDb();
    await expect(listCustomRoleDefinitions(db as never, 'seds-khi-chapter')).resolves.toEqual([]);
  });
});
