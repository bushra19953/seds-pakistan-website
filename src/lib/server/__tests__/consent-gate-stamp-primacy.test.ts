/**
 * @jest-environment node
 *
 * Cutover contracts for the consent-gate record-mode stamp
 * (identity census R-14/R-15, design G-ROLE-9): the stamp on
 * roles/{uid} and roleDefinitions/{slug} routes through the roles
 * family's primacy law.
 *  - OFF (no SUPA_SURFACES): Firestore only, zero adapter calls —
 *    byte-identical to the pre-cutover gate.
 *  - SURFACES on, PRIMARY off (step-one mirror discipline):
 *    Firestore stamp FIRST, then a best-effort adapter merge-set.
 *  - isSupaPrimary('roles'): adapter merge-set FIRST (primary leg),
 *    Firestore stamp after as best-effort reverse mirror — and a
 *    failing reverse mirror does NOT fail the gate.
 *  - Non-roles-family targets (chapters) never touch the adapter,
 *    in any flag state.
 * The gate collaborators are mocked as in consent-gate.test.ts;
 * record mode with no consentRequestId evaluates to 'missing'
 * without touching the lookup, then audits, tasks, and stamps.
 */

const state = {
  primary: false,
  surfaces: false,
  adapterFails: false,
  firestoreFails: false,
  order: [] as string[],
};

jest.mock('@/lib/server/consent-lookup', () => ({
  getDecidedConsent: jest.fn(async () => null),
  consumeConsent: jest.fn(async () => 'consumed'),
  listDecidedConsentCandidates: jest.fn(async () => []),
}));

jest.mock('@/lib/server/governance-settings', () => ({
  getConsentMatterSettings: jest.fn(async () => ({
    mode: 'record',
    validityDays: 90,
    source: 'doc',
  })),
}));

jest.mock('@/lib/server/governance-audit', () => ({
  writeGovernanceAuditOrThrow: jest.fn(async () => 'audit-id'),
  GovernanceAuditError: class GovernanceAuditError extends Error {},
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn(async () => undefined) },
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => null,
}));

jest.mock('@/lib/server/founder-gate', () => {
  const { FOUNDER_UID: FOUNDER } = require('@/lib/roles');
  return {
    isFounderUid: (uid: string | null | undefined) =>
      typeof uid === 'string' && uid.length > 0 && uid === FOUNDER,
  };
});

jest.mock('@/lib/server/permissions', () => ({
  resolveUserRole: jest.fn(),
}));

jest.mock('@/lib/server/consent-service', () => ({
  createFounderActConsent: jest.fn(),
}));

jest.mock('@/lib/supa', () => ({
  getSupaAdapter: () => ({
    setDoc: jest.fn(async (collection: string, id: string) => {
      state.order.push(`adapter:${collection}/${id}`);
      if (state.adapterFails) throw new Error('adapter down');
    }),
  }),
  isSupaPrimary: (surface: string) => surface === 'roles' && state.primary,
  useSupa: (surface: string) => surface === 'roles' && state.surfaces,
}));

import { assertConsentFor, type ConsentSubjectRef } from '@/lib/server/consent-gate';

function fakeDb(): any {
  return {
    collection: (name: string) => ({
      add: async () => ({ id: 'task-1' }),
      doc: (id: string) => ({
        set: async () => {
          state.order.push(`firestore:${name}/${id}`);
          if (state.firestoreFails) throw new Error('firestore down');
        },
      }),
    }),
  };
}

const USER_ROLE: ConsentSubjectRef = {
  type: 'user_role',
  targetUid: 'u-target',
  roleKey: 'president_national',
  action: 'appoint',
};
const ROLE_DEF: ConsentSubjectRef = {
  type: 'role_definition',
  slug: 'president_national',
  action: 'create',
};
const CHAPTER: ConsentSubjectRef = {
  type: 'chapter',
  chapterId: 'ist',
  action: 'admit',
};

async function runGate(subjectRef: ConsentSubjectRef) {
  return assertConsentFor({
    db: fakeDb(),
    actorUid: 'actor-1',
    matterKey: 'category_b_appointment' as never,
    subjectRef,
  });
}

beforeEach(() => {
  state.primary = false;
  state.surfaces = false;
  state.adapterFails = false;
  state.firestoreFails = false;
  state.order = [];
});

describe('consent-gate record-mode stamp primacy (R-14/R-15)', () => {
  it('OFF: Firestore only for roles/{uid}, zero adapter calls', async () => {
    const pass = await runGate(USER_ROLE);
    expect(pass.outcome).toBe('recorded');
    expect(state.order).toEqual(['firestore:roles/u-target']);
  });

  it('SURFACES on, PRIMARY off: Firestore first, adapter mirror second', async () => {
    state.surfaces = true;
    const pass = await runGate(USER_ROLE);
    expect(pass.outcome).toBe('recorded');
    expect(state.order).toEqual([
      'firestore:roles/u-target',
      'adapter:roles/u-target',
    ]);
  });

  it('PRIMARY: adapter first (primary leg), Firestore reverse mirror after', async () => {
    state.surfaces = true;
    state.primary = true;
    const pass = await runGate(USER_ROLE);
    expect(pass.outcome).toBe('recorded');
    expect(state.order).toEqual([
      'adapter:roles/u-target',
      'firestore:roles/u-target',
    ]);
  });

  it('PRIMARY + roleDefinitions/{slug} (R-15): adapter first, mirror after', async () => {
    state.surfaces = true;
    state.primary = true;
    await runGate(ROLE_DEF);
    expect(state.order).toEqual([
      'adapter:roleDefinitions/president_national',
      'firestore:roleDefinitions/president_national',
    ]);
  });

  it('PRIMARY + failing reverse mirror: gate still records (stamp never fails the gate)', async () => {
    state.surfaces = true;
    state.primary = true;
    state.firestoreFails = true;
    const pass = await runGate(USER_ROLE);
    expect(pass.outcome).toBe('recorded');
    expect(state.order).toEqual([
      'adapter:roles/u-target',
      'firestore:roles/u-target',
    ]);
  });

  it('PRIMARY + failing adapter leg: swallowed, Firestore mirror still attempted, gate records', async () => {
    state.surfaces = true;
    state.primary = true;
    state.adapterFails = true;
    const pass = await runGate(USER_ROLE);
    expect(pass.outcome).toBe('recorded');
    expect(state.order).toEqual([
      'adapter:roles/u-target',
      'firestore:roles/u-target',
    ]);
  });

  it('chapters stamp is NOT a roles-family target: Firestore only even under primacy', async () => {
    state.surfaces = true;
    state.primary = true;
    await runGate(CHAPTER);
    expect(state.order).toEqual(['firestore:chapters/ist']);
  });
});
