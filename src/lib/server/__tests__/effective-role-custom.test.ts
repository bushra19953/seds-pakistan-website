/**
 * @jest-environment node
 *
 * T2 (RESOLUTION-AI plan s.6) - getEffectiveRole with custom roles.
 *
 * Two layers in one file:
 * 1. CHARACTERISATION: for catalog primaries, legacy primaries, and junk
 *    primaries (with no def, and with a junk def), the five pre-existing
 *    EffectiveRoleResult fields stay byte-identical to today's outputs
 *    in every read branch (plan s.0.1). These assertions pass against
 *    the pre-change implementation.
 * 2. NEW BEHAVIOR (plan s.3.2): a definition-backed custom primary or
 *    additional surfaces in the NEW fields customPrimary /
 *    customAdditionalRoles - carrying the definition's title, parent
 *    catalog key (reporting only, never an authority source) and the
 *    DEFINITION's chapterId - while `role`/`primary` stay null and the
 *    result's own chapterId still comes from the user/roles doc.
 *
 * The new fields are read through a locally widened result type: the
 * shape below is the plan s.3.2 contract, structurally stated here so
 * this suite compiles before and after the implementation lands.
 */
import { FOUNDER_UID } from '@/config/founder';
import { xpForRoles, type CatalogRoleKey } from '../../role-catalog';

type DocData = Record<string, unknown> | undefined;

const mockState = {
  mode: 'authoritative' as 'legacy' | 'dual' | 'authoritative',
  users: {} as Record<string, DocData>,
  roles: {} as Record<string, DocData>,
  roleDefinitions: {} as Record<string, DocData>,
  roleDefinitionReads: 0,
  dbNull: false,
};

function mockSnap(data: DocData) {
  return { exists: data !== undefined, id: '', data: () => data };
}

function mockDb() {
  return {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          if (name === 'users') return mockSnap(mockState.users[id]);
          if (name === 'roles') return mockSnap(mockState.roles[id]);
          if (name === 'roleDefinitions') {
            mockState.roleDefinitionReads += 1;
            return mockSnap(mockState.roleDefinitions[id]);
          }
          throw new Error(`unexpected collection ${name}`);
        },
      }),
    }),
  };
}

jest.mock('../firebase-admin', () => ({
  getDb: () => (mockState.dbNull ? null : mockDb()),
}));

jest.mock('../phase1-flags', () => ({
  getPhase1Flags: () => ({
    roleStoreWrite: false,
    roleStoreReadMode: mockState.mode,
    scopeResolverMode: 'shadow',
  }),
}));

import { getEffectiveRole, type EffectiveRoleResult } from '../effective-role';

interface CustomResolutionLike {
  slug: string;
  title: string | null;
  parentRoleKey: string;
  chapterId: string;
}

type ResultWithCustom = EffectiveRoleResult & {
  customPrimary: CustomResolutionLike | null;
  customAdditionalRoles: CustomResolutionLike[];
};

async function resolve(uid: string): Promise<ResultWithCustom> {
  return (await getEffectiveRole(uid)) as ResultWithCustom;
}

function fiveFields(r: ResultWithCustom) {
  return {
    role: r.role,
    primary: r.primary,
    additionalRoles: r.additionalRoles,
    chapterId: r.chapterId,
    source: r.source,
  };
}

const CHAPTER = 'seds-ist-chapter';
const CUSTOM_SLUG = 'custom_poster_team_lead';
const CUSTOM_DEF = {
  isCustom: true,
  parentRoleKey: 'chapter_design_chair',
  // Deliberately NOT the holder docs' chapter: plan s.3.3 keeps the
  // result chapterId coming from the user/roles doc; the definition's
  // chapter rides inside the custom resolution only.
  chapterId: 'seds-lahore-chapter',
  title: 'Poster Team Lead',
  description: 'Leads the poster team.',
};
const CUSTOM_RES: CustomResolutionLike = {
  slug: CUSTOM_SLUG,
  title: 'Poster Team Lead',
  parentRoleKey: 'chapter_design_chair',
  chapterId: 'seds-lahore-chapter',
};

beforeEach(() => {
  mockState.mode = 'authoritative';
  mockState.users = {};
  mockState.roles = {};
  mockState.roleDefinitions = {};
  mockState.roleDefinitionReads = 0;
  mockState.dbNull = false;
});

type BranchName = 'legacy' | 'dual' | 'auth-roles' | 'auth-fallback';
const BRANCHES: Array<{
  name: BranchName;
  mode: 'legacy' | 'dual' | 'authoritative';
  viaRoles: boolean;
}> = [
  { name: 'legacy', mode: 'legacy', viaRoles: false },
  { name: 'dual', mode: 'dual', viaRoles: false },
  { name: 'auth-roles', mode: 'authoritative', viaRoles: true },
  { name: 'auth-fallback', mode: 'authoritative', viaRoles: false },
];

async function runBranch(
  branch: (typeof BRANCHES)[number],
  uid: string,
  stored: DocData,
): Promise<ResultWithCustom> {
  mockState.users = {};
  mockState.roles = {};
  mockState.roleDefinitionReads = 0;
  mockState.mode = branch.mode;
  if (branch.viaRoles) {
    mockState.roles[uid] = stored;
    mockState.users[uid] = { chapterId: CHAPTER };
  } else {
    mockState.users[uid] = stored;
  }
  return resolve(uid);
}

describe('characterisation: the five existing fields never move (plan s.0.1)', () => {
  const CATALOG_EXPECTED: Record<BranchName, ReturnType<typeof fiveFields>> = {
    legacy: {
      role: 'chapter_design_chair',
      primary: 'chapter_design_chair',
      additionalRoles: [],
      chapterId: CHAPTER,
      source: 'mirror-fallback',
    },
    dual: {
      role: 'chapter_design_chair',
      primary: 'chapter_design_chair',
      additionalRoles: [],
      chapterId: CHAPTER,
      source: 'mirror-fallback',
    },
    'auth-roles': {
      role: 'chapter_design_chair',
      primary: 'chapter_design_chair',
      additionalRoles: [],
      chapterId: CHAPTER,
      source: 'roles',
    },
    'auth-fallback': {
      role: 'chapter_design_chair',
      primary: 'chapter_design_chair',
      additionalRoles: [],
      chapterId: CHAPTER,
      source: 'mirror-fallback',
    },
  };

  const JUNK_EXPECTED: Record<BranchName, ReturnType<typeof fiveFields>> = {
    legacy: { role: null, primary: null, additionalRoles: [], chapterId: CHAPTER, source: 'none' },
    dual: { role: null, primary: null, additionalRoles: [], chapterId: CHAPTER, source: 'none' },
    'auth-roles': {
      role: null,
      primary: null,
      additionalRoles: [],
      chapterId: CHAPTER,
      source: 'roles',
    },
    'auth-fallback': {
      role: null,
      primary: null,
      additionalRoles: [],
      chapterId: CHAPTER,
      source: 'none',
    },
  };

  async function expectMatrix(
    uid: string,
    stored: DocData,
    expected: Record<BranchName, ReturnType<typeof fiveFields>>,
  ) {
    for (const branch of BRANCHES) {
      const r = await runBranch(branch, uid, stored);
      expect(fiveFields(r)).toEqual(expected[branch.name]);
    }
  }

  it('catalog primary resolves identically in every branch', async () => {
    await expectMatrix(
      'uid-catalog',
      { role: 'chapter_design_chair', chapterId: CHAPTER },
      CATALOG_EXPECTED,
    );
  });

  it('legacy primary (chair_design) resolves identically in every branch', async () => {
    await expectMatrix(
      'uid-legacy',
      { role: 'chair_design', chapterId: CHAPTER },
      CATALOG_EXPECTED,
    );
  });

  it('junk primary with NO definition still resolves null in every branch', async () => {
    await expectMatrix('uid-junk', { role: 'lead_wizard', chapterId: CHAPTER }, JUNK_EXPECTED);
  });

  it('junk primary with a junk definition still resolves null in every branch', async () => {
    mockState.roleDefinitions['lead_wizard'] = {
      name: 'Lead Wizard',
      category: 'B',
      description: 'Made-up definition; no isCustom, no parent, no chapter.',
    };
    await expectMatrix('uid-junk-def', { role: 'lead_wizard', chapterId: CHAPTER }, JUNK_EXPECTED);
  });

  it("the Founder's stored 'admin' still resolves to founder_patron (authoritative)", async () => {
    mockState.roles[FOUNDER_UID] = { role: 'admin', chapterId: CHAPTER };
    mockState.users[FOUNDER_UID] = { chapterId: CHAPTER };
    const r = await resolve(FOUNDER_UID);
    expect(fiveFields(r)).toEqual({
      role: 'founder_patron',
      primary: 'founder_patron',
      additionalRoles: [],
      chapterId: CHAPTER,
      source: 'roles',
    });
    expect(mockState.roleDefinitionReads).toBe(0);
  });

  it('new fields stay null / [] for every non-custom fixture in every branch', async () => {
    mockState.roleDefinitions['lead_wizard'] = {
      name: 'Lead Wizard',
      category: 'B',
      description: 'Made-up definition; no isCustom, no parent, no chapter.',
    };
    const fixtures: Array<{ uid: string; stored: DocData }> = [
      { uid: 'uid-catalog', stored: { role: 'chapter_design_chair', chapterId: CHAPTER } },
      { uid: 'uid-legacy', stored: { role: 'chair_design', chapterId: CHAPTER } },
      { uid: 'uid-junk', stored: { role: 'lead_wizard', chapterId: CHAPTER } },
    ];
    for (const { uid, stored } of fixtures) {
      for (const branch of BRANCHES) {
        const r = await runBranch(branch, uid, stored);
        expect(r.customPrimary).toBeNull();
        expect(r.customAdditionalRoles).toEqual([]);
      }
    }
    // Founder fixture, authoritative roles-doc branch.
    mockState.mode = 'authoritative';
    mockState.users = { [FOUNDER_UID]: { chapterId: CHAPTER } };
    mockState.roles = { [FOUNDER_UID]: { role: 'admin', chapterId: CHAPTER } };
    const founderResult = await resolve(FOUNDER_UID);
    expect(founderResult.customPrimary).toBeNull();
    expect(founderResult.customAdditionalRoles).toEqual([]);
  });
});

describe('custom resolution (plan s.3.2)', () => {
  it('definition-backed custom primary: customPrimary carries title/parent/definition chapter, role stays null, XP 0', async () => {
    mockState.users['uid-custom'] = { chapterId: CHAPTER };
    mockState.roles['uid-custom'] = { role: CUSTOM_SLUG, chapterId: CHAPTER };
    mockState.roleDefinitions[CUSTOM_SLUG] = CUSTOM_DEF;

    const r = await resolve('uid-custom');
    expect(fiveFields(r)).toEqual({
      role: null,
      primary: null,
      additionalRoles: [],
      chapterId: CHAPTER, // from the roles doc, NOT the definition (plan s.3.3)
      source: 'roles',
    });
    expect(r.customPrimary).toEqual(CUSTOM_RES);
    expect(r.customAdditionalRoles).toEqual([]);
    expect(mockState.roleDefinitionReads).toBe(1);

    // XP 0 by construction (plan s.3.2.4): no catalog key is ever
    // produced for a custom-only holder, so xpForRoles sees nothing.
    const held = [r.role, r.primary, ...r.additionalRoles].filter(
      (k): k is CatalogRoleKey => k !== null,
    );
    expect(xpForRoles(held)).toBe(0);
  });

  it('definition-backed custom primary in the mirror (legacy) branch, stored with messy casing', async () => {
    mockState.mode = 'legacy';
    mockState.users['uid-custom'] = { role: 'Custom_Poster_Team_Lead', chapterId: CHAPTER };
    mockState.roleDefinitions[CUSTOM_SLUG] = CUSTOM_DEF;

    const r = await resolve('uid-custom');
    expect(fiveFields(r)).toEqual({
      role: null,
      primary: null,
      additionalRoles: [],
      chapterId: CHAPTER,
      source: 'none',
    });
    expect(r.customPrimary).toEqual(CUSTOM_RES);
    expect(r.customAdditionalRoles).toEqual([]);
  });

  it('custom primary whose def is missing isCustom stays dead', async () => {
    mockState.users['uid-custom'] = { chapterId: CHAPTER };
    mockState.roles['uid-custom'] = { role: CUSTOM_SLUG, chapterId: CHAPTER };
    mockState.roleDefinitions[CUSTOM_SLUG] = {
      parentRoleKey: 'chapter_design_chair',
      chapterId: CHAPTER,
      title: 'Poster Team Lead',
    };
    const r = await resolve('uid-custom');
    expect(r.primary).toBeNull();
    expect(r.customPrimary).toBeNull();
  });

  it('custom primary whose def names a LEGACY parent stays dead', async () => {
    mockState.users['uid-custom'] = { chapterId: CHAPTER };
    mockState.roles['uid-custom'] = { role: CUSTOM_SLUG, chapterId: CHAPTER };
    mockState.roleDefinitions[CUSTOM_SLUG] = {
      isCustom: true,
      parentRoleKey: 'chair_events',
      chapterId: CHAPTER,
      title: 'Poster Team Lead',
    };
    const r = await resolve('uid-custom');
    expect(r.customPrimary).toBeNull();
  });

  it('custom primary whose def has an empty chapterId stays dead', async () => {
    mockState.users['uid-custom'] = { chapterId: CHAPTER };
    mockState.roles['uid-custom'] = { role: CUSTOM_SLUG, chapterId: CHAPTER };
    mockState.roleDefinitions[CUSTOM_SLUG] = {
      isCustom: true,
      parentRoleKey: 'chapter_design_chair',
      chapterId: '',
      title: 'Poster Team Lead',
    };
    const r = await resolve('uid-custom');
    expect(r.customPrimary).toBeNull();
  });

  it('custom slug in additionalRoles (authoritative roles doc): customAdditionalRoles populated, catalog output unchanged', async () => {
    mockState.users['uid-mixed'] = { chapterId: CHAPTER };
    mockState.roles['uid-mixed'] = {
      role: 'chapter_design_chair',
      chapterId: CHAPTER,
      additionalRoles: [CUSTOM_SLUG, 'cubesat_team'],
    };
    mockState.roleDefinitions[CUSTOM_SLUG] = CUSTOM_DEF;

    const r = await resolve('uid-mixed');
    expect(fiveFields(r)).toEqual({
      role: 'chapter_design_chair',
      primary: 'chapter_design_chair',
      additionalRoles: ['cubesat_team'], // the custom slug never enters the catalog list
      chapterId: CHAPTER,
      source: 'roles',
    });
    expect(r.customPrimary).toBeNull();
    expect(r.customAdditionalRoles).toEqual([CUSTOM_RES]);
  });

  it('custom slug in additionalRoles (legacy mirror branch): populated from the users doc', async () => {
    mockState.mode = 'legacy';
    mockState.users['uid-mixed'] = {
      role: 'member',
      chapterId: CHAPTER,
      additionalRoles: [CUSTOM_SLUG],
    };
    mockState.roleDefinitions[CUSTOM_SLUG] = CUSTOM_DEF;

    const r = await resolve('uid-mixed');
    expect(fiveFields(r)).toEqual({
      role: 'member',
      primary: 'member',
      additionalRoles: [],
      chapterId: CHAPTER,
      source: 'mirror-fallback',
    });
    expect(r.customAdditionalRoles).toEqual([CUSTOM_RES]);
  });

  it('mirror-fallback branch (C6): catalog additionalRoles STAYS [] while custom extraction reads the users doc', async () => {
    mockState.mode = 'authoritative';
    // No roles doc at all: the fallback branch runs. Today it returns
    // additionalRoles [] unconditionally; plan C6 keeps that asymmetry
    // for catalog output and reads the mirror additionals ONLY for
    // custom extraction - so even the cubesat_team entry stays out of
    // the catalog list while the custom slug surfaces.
    mockState.users['uid-fallback'] = {
      role: 'member',
      chapterId: CHAPTER,
      additionalRoles: [CUSTOM_SLUG, 'cubesat_team'],
    };
    mockState.roleDefinitions[CUSTOM_SLUG] = CUSTOM_DEF;

    const r = await resolve('uid-fallback');
    expect(fiveFields(r)).toEqual({
      role: 'member',
      primary: 'member',
      additionalRoles: [],
      chapterId: CHAPTER,
      source: 'mirror-fallback',
    });
    expect(r.customAdditionalRoles).toEqual([CUSTOM_RES]);
  });

  it('the same custom slug as primary AND additional is reported once, as customPrimary', async () => {
    mockState.users['uid-both'] = { chapterId: CHAPTER };
    mockState.roles['uid-both'] = {
      role: CUSTOM_SLUG,
      chapterId: CHAPTER,
      additionalRoles: [CUSTOM_SLUG],
    };
    mockState.roleDefinitions[CUSTOM_SLUG] = CUSTOM_DEF;

    const r = await resolve('uid-both');
    expect(r.customPrimary).toEqual(CUSTOM_RES);
    expect(r.customAdditionalRoles).toEqual([]);
  });

  it('no-custom fixture: ZERO roleDefinitions reads in either mode (prefix test is pure and runs first)', async () => {
    mockState.users['uid-plain'] = { chapterId: CHAPTER };
    mockState.roles['uid-plain'] = {
      role: 'chapter_design_chair',
      chapterId: CHAPTER,
      additionalRoles: ['cubesat_team'],
    };
    await resolve('uid-plain');
    expect(mockState.roleDefinitionReads).toBe(0);

    mockState.mode = 'legacy';
    mockState.users['uid-plain'] = {
      role: 'chapter_design_chair',
      chapterId: CHAPTER,
      additionalRoles: ['cubesat_team'],
    };
    mockState.roleDefinitionReads = 0;
    await resolve('uid-plain');
    expect(mockState.roleDefinitionReads).toBe(0);
  });

  it('getDb() null: the early-return object also carries the new fields', async () => {
    mockState.dbNull = true;
    const r = await resolve('uid-anyone');
    expect(r).toEqual({
      role: null,
      primary: null,
      additionalRoles: [],
      chapterId: null,
      source: 'none',
      customPrimary: null,
      customAdditionalRoles: [],
    });
  });
});
