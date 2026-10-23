/**
 * @jest-environment node
 *
 * T4 (RESOLUTION-AI plan s.6 / s.5) - the AI task generator's team
 * registry, extracted to src/lib/server/team-registry.ts.
 *
 * Pins:
 * - Extraction characterisation: with no custom definitions and no
 *   additionalRoles steering cases, the registry deep-equals today's
 *   route-local builder output, plus the additive `additionalRoles: []`
 *   on every entry (plan s.5.2 / s.0.1).
 * - Steering (plan s.5.3.3): a user whose primary fails ONLY the role
 *   test (empty / 'member' / 'none') enters the registry when an
 *   additional role is steerable: a catalog key other than 'member'
 *   and 'member_basic', or a slug backed by a validated custom
 *   definition. Junk additionals never steer; a custom slug with no
 *   valid definition never steers.
 * - Custom definitions in the defs list carry title / parentRole /
 *   chapterId; non-custom entries stay byte-identical ({ role,
 *   description } only). With a chapter filter, other-chapter custom
 *   definitions are excluded; non-custom definitions never are.
 * - Client-trust guard (Oct 4 lesson): the registry is built
 *   server-side from Firestore only. The module exports no function
 *   that accepts client-sent subordinate/definition arrays, and a
 *   client-shaped extra argument cannot inject a non-holder.
 */
type DocData = Record<string, unknown> | undefined;
type DocEntry = { id: string; data: DocData };

const mockState = {
  roles: [] as DocEntry[],
  users: [] as DocEntry[],
  roleDefinitions: [] as DocEntry[],
};

function snapOf(docs: DocEntry[]) {
  return {
    forEach: (cb: (d: { id: string; data: () => DocData }) => void) =>
      docs.forEach((d) => cb({ id: d.id, data: () => d.data })),
  };
}

jest.mock('../firebase-admin', () => ({
  getDb: () => ({
    collection: (name: string) => ({
      get: async () => {
        if (name === 'roles') return snapOf(mockState.roles);
        if (name === 'users') return snapOf(mockState.users);
        if (name === 'roleDefinitions') return snapOf(mockState.roleDefinitions);
        throw new Error(`unexpected collection ${name}`);
      },
    }),
  }),
}));

import { buildTeamRegistry } from '../team-registry';
import * as teamRegistry from '../team-registry';

const IST = 'seds-ist-chapter';
const CUSTOM_SLUG = 'custom_poster_team_lead';
const CUSTOM_DEF_DOC: DocEntry = {
  id: CUSTOM_SLUG,
  data: {
    isCustom: true,
    parentRoleKey: 'chapter_design_chair',
    chapterId: IST,
    title: 'Poster Team Lead',
    description: 'Leads the IST poster team.',
  },
};
const CUSTOM_DEF_ENTRY = {
  role: CUSTOM_SLUG,
  description: 'Leads the IST poster team.',
  title: 'Poster Team Lead',
  parentRole: 'chapter_design_chair',
  chapterId: IST,
};

beforeEach(() => {
  mockState.roles = [];
  mockState.users = [];
  mockState.roleDefinitions = [];
});

describe('no-custom fixture: extraction is byte-identical plus additive fields', () => {
  it('registry output deep-equals today\u2019s builder output (additionalRoles [] added)', async () => {
    mockState.roles = [{ id: 'u1', data: { role: 'chapter_design_chair', additionalRoles: [] } }];
    mockState.users = [
      {
        id: 'u1',
        data: {
          displayName: 'Ayesha Khan',
          email: 'ayesha@example.com',
          role: 'member',
          chapterId: IST,
        },
      },
      { id: 'u2', data: { displayName: '', email: 'bilal@example.com', role: 'cubesat_team' } },
      { id: 'u3', data: { displayName: 'Member Only', role: 'member' } },
      { id: 'u4', data: { displayName: 'No Role', role: '' } },
    ];
    mockState.roleDefinitions = [
      { id: 'chapter_design_chair', data: { description: 'Runs chapter design and media.' } },
      { id: 'cubesat_team', data: { responsibilities: 'Builds CubeSats.' } },
    ];

    const registry = await buildTeamRegistry();

    expect(registry.subordinates).toEqual([
      { uid: 'u1', name: 'Ayesha Khan', role: 'chapter_design_chair', additionalRoles: [] },
      { uid: 'u2', name: 'bilal@example.com', role: 'cubesat_team', additionalRoles: [] },
    ]);
    // Non-custom definition entries carry NO extra keys (plan s.5.3.5):
    // description still resolves through the responsibilities fallback.
    expect(registry.roleDefinitions).toEqual([
      { role: 'chapter_design_chair', description: 'Runs chapter design and media.' },
      { role: 'cubesat_team', description: 'Builds CubeSats.' },
    ]);
    expect(registry.rolesByUid).toEqual(new Map([['u1', 'chapter_design_chair']]));
  });
});

describe('additionalRoles steering (plan s.5.3.1 / s.5.3.3)', () => {
  it("'member' primary + catalog additional: included, additionals sorted, primary excluded from the list", async () => {
    mockState.roles = [
      {
        id: 'u5',
        data: { role: 'member', additionalRoles: ['rocketry_team', 'cubesat_team', 'member'] },
      },
    ];
    mockState.users = [{ id: 'u5', data: { displayName: 'Crew Member', role: 'member' } }];

    const registry = await buildTeamRegistry();
    expect(registry.subordinates).toEqual([
      { uid: 'u5', name: 'Crew Member', role: 'member', additionalRoles: ['cubesat_team', 'rocketry_team'] },
    ]);
  });

  it("'member' primary + validated custom additional: included", async () => {
    mockState.roles = [{ id: 'u6', data: { role: 'member', additionalRoles: [CUSTOM_SLUG] } }];
    mockState.users = [{ id: 'u6', data: { displayName: 'Poster Helper', role: 'member' } }];
    mockState.roleDefinitions = [CUSTOM_DEF_DOC];

    const registry = await buildTeamRegistry();
    expect(registry.subordinates).toEqual([
      { uid: 'u6', name: 'Poster Helper', role: 'member', additionalRoles: [CUSTOM_SLUG] },
    ]);
    expect(registry.roleDefinitions).toEqual([CUSTOM_DEF_ENTRY]);
  });

  it("'member' primary + junk additional only: NOT included", async () => {
    mockState.roles = [{ id: 'u7', data: { role: 'member', additionalRoles: ['lead_wizard'] } }];
    mockState.users = [{ id: 'u7', data: { displayName: 'Hopeful Wizard', role: 'member' } }];

    const registry = await buildTeamRegistry();
    expect(registry.subordinates).toEqual([]);
  });

  it("'member' primary + custom slug with NO valid definition: NOT included (the slug alone never steers)", async () => {
    mockState.roles = [{ id: 'u8', data: { role: 'member', additionalRoles: ['custom_ghost_role'] } }];
    mockState.users = [{ id: 'u8', data: { displayName: 'Ghost Holder', role: 'member' } }];
    // No roleDefinitions doc for custom_ghost_role at all.
    const registry = await buildTeamRegistry();
    expect(registry.subordinates).toEqual([]);
  });

  it("'member' primary + 'member_basic' additional only: NOT included (member_basic never steers)", async () => {
    mockState.roles = [{ id: 'u9', data: { role: 'member', additionalRoles: ['member_basic'] } }];
    mockState.users = [{ id: 'u9', data: { displayName: 'Basic Only', role: 'member' } }];

    const registry = await buildTeamRegistry();
    expect(registry.subordinates).toEqual([]);
  });

  it('no roles doc: additionals fall back to the users doc (roles-first / users-fallback)', async () => {
    mockState.users = [
      {
        id: 'u10',
        data: { displayName: 'Fallback Crew', role: 'member', additionalRoles: ['cubesat_team'] },
      },
    ];

    const registry = await buildTeamRegistry();
    expect(registry.subordinates).toEqual([
      { uid: 'u10', name: 'Fallback Crew', role: 'member', additionalRoles: ['cubesat_team'] },
    ]);
  });

  it("a primary holder's additionals ride along as information; the primary stays in `role`", async () => {
    mockState.roles = [
      {
        id: 'u11',
        data: { role: 'chapter_events_chair', additionalRoles: ['cubesat_team', 'chapter_events_chair'] },
      },
    ];
    mockState.users = [{ id: 'u11', data: { displayName: 'Events Chair', role: 'member' } }];

    const registry = await buildTeamRegistry();
    expect(registry.subordinates).toEqual([
      {
        uid: 'u11',
        name: 'Events Chair',
        role: 'chapter_events_chair',
        additionalRoles: ['cubesat_team'],
      },
    ]);
  });
});

describe('custom primary holder + definitions list (plan s.5.3.5)', () => {
  it('custom primary holder is included as today; the def entry carries title/parentRole/chapterId', async () => {
    mockState.roles = [{ id: 'u12', data: { role: CUSTOM_SLUG } }];
    mockState.users = [{ id: 'u12', data: { displayName: 'Poster Lead Person', role: 'member' } }];
    mockState.roleDefinitions = [CUSTOM_DEF_DOC];

    const registry = await buildTeamRegistry();
    expect(registry.subordinates).toEqual([
      { uid: 'u12', name: 'Poster Lead Person', role: CUSTOM_SLUG, additionalRoles: [] },
    ]);
    expect(registry.roleDefinitions).toEqual([CUSTOM_DEF_ENTRY]);
  });
});

describe('chapter filtering of custom definitions (plan s.5.3.5)', () => {
  it('other-chapter custom def excluded, same-chapter custom def included, non-custom defs never filtered', async () => {
    mockState.users = [{ id: 'u1', data: { displayName: 'Ayesha Khan', role: 'cubesat_team' } }];
    mockState.roleDefinitions = [
      { id: 'chapter_design_chair', data: { description: 'Runs chapter design and media.' } },
      CUSTOM_DEF_DOC,
      {
        id: 'custom_lahore_media',
        data: {
          isCustom: true,
          parentRoleKey: 'chapter_design_chair',
          chapterId: 'seds-lahore-chapter',
          title: 'Lahore Media Lead',
          description: 'Leads Lahore media.',
        },
      },
    ];

    const registry = await buildTeamRegistry(IST);
    expect(registry.roleDefinitions).toEqual([
      { role: 'chapter_design_chair', description: 'Runs chapter design and media.' },
      CUSTOM_DEF_ENTRY,
    ]);
  });
});

describe('client-trust guard: the registry is server-built only (Oct 4 lesson)', () => {
  it('the module exports exactly the registry builder and the caller-role resolver', () => {
    expect(Object.keys(teamRegistry).sort()).toEqual(['buildTeamRegistry', 'resolveCallerRole']);
  });

  it('buildTeamRegistry takes only an optional chapterId - no array parameters', () => {
    expect(buildTeamRegistry.length).toBeLessThanOrEqual(1);
  });

  it('a client-sent registry entry pointing at a non-holder cannot enter the registry', async () => {
    mockState.users = [{ id: 'u1', data: { displayName: 'Ayesha Khan', role: 'cubesat_team' } }];

    const plain = await buildTeamRegistry();
    // A tampered caller stuffing a fabricated subordinate list into a
    // second argument must change nothing: the builder reads Firestore
    // and only Firestore, so 'mallory' - who holds no role anywhere -
    // is not in the registry and sanitizeAssignees will drop any step
    // the model tries to assign to them.
    const tampered = await (buildTeamRegistry as unknown as (
      chapterId?: string,
      clientPayload?: unknown,
    ) => ReturnType<typeof buildTeamRegistry>)(undefined, {
      subordinates: [{ uid: 'mallory', name: 'Mallory', role: 'chapter_design_chair' }],
      roleDefinitions: [{ role: 'chapter_design_chair', description: 'forged' }],
    });

    expect(tampered.subordinates).toEqual(plain.subordinates);
    expect(tampered.subordinates.map((u) => u.uid)).not.toContain('mallory');
  });
});
