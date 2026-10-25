/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION — ROLES+PERMISSIONS cluster contract tests (group 3:
 * flag states). Adapter contract (feat/supa-adapter @ 85e657f):
 * src/lib/supa exposes getDoc/listDocs/countDocs/setDoc/updateDoc/deleteDoc
 * over fs_<collection> jsonb tables + useSupa(surface), default OFF,
 * Firestore fallback on error, byte-identical response shapes. The roles
 * surface name is 'roles' (feat/supa-roles-3, 7ed7e33).
 *
 * Three layers:
 * A. ALWAYS RUNS (base tree): with no Supabase client configured, the
 *    resolution core's answers are IDENTICAL for every SUPA_SURFACES /
 *    NEXT_PUBLIC_SUPA_SURFACES value — unset, 'roles', '*'. On the base
 *    tree nothing reads the flag yet; after the adapter+seams merge this
 *    still holds because an ON flag with no configured client must fall
 *    back to Firestore (adapter flags.ts contract).
 * B. CONDITIONAL (feat/supa-roles-1 seam, commits ae4ac39 + 6941879):
 *    src/lib/server/supa-roles-seam — flag OFF -> null (Firestore path),
 *    flag ON + mocked adapter -> Supabase rows, flag ON + adapter error
 *    -> null (fallback), mirrors never throw. Activates automatically
 *    when the seam module is present on the tree under test; on the base
 *    tree a single PENDING test records the dependency.
 * C. CONDITIONAL (feat/supa-roles-3 client seam, commit 7ed7e33):
 *    src/lib/supa-roles-client-seam flag parsing (rolesSupaEnabled /
 *    parseSupaClientSurfaces). Same activation rule as B.
 *
 * ZERO live reads: every backend below is an in-memory mock.
 */

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  admin: { firestore: { FieldValue: { serverTimestamp: () => 'ts', delete: () => 'del' } } },
}));

import { hasServerPermission, resolveCanonicalRole } from '../permissions';
import { resetIdentityCache } from '../identity-cache';

// Minimal Firestore fake (doc gets only).
type DocData = Record<string, unknown>;
class FakeDb {
  store = new Map<string, Map<string, DocData>>();
  seed(col: string, id: string, data: DocData) {
    if (!this.store.has(col)) this.store.set(col, new Map());
    this.store.get(col)!.set(id, { ...data });
  }
  collection(name: string) {
    const self = this;
    return {
      doc: (id: string) => ({
        get: async () => {
          const data = self.store.get(name)?.get(id);
          return { exists: data !== undefined, id, data: () => (data ? { ...data } : undefined) };
        },
      }),
    };
  }
}

let fake: FakeDb;
const ENV_KEYS = ['SUPA_SURFACES', 'NEXT_PUBLIC_SUPA_SURFACES', 'SUPA_ALL', 'NEXT_PUBLIC_SUPA_ALL', 'SUPA_ROLES', 'SUPA_ROLEDEFINITIONS'];
let savedEnv: Record<string, string | undefined> = {};

function seedFixtures() {
  fake.seed('roles', 'officer-1', { role: 'chapter_president', chapterId: 'seds-ist-chapter' });
  fake.seed('users', 'officer-1', { isBanned: false, chapterId: 'seds-ist-chapter' });
  fake.seed('roleDefinitions', 'chapter_president', { permissions: ['canManageTasks'] });
  fake.seed('permissions', 'chapter_president', { canManageEvents: true });
}

async function battery() {
  return {
    granted: await hasServerPermission('chapter_president', 'canManageTasks'),
    // Definition array is authoritative: permissions-tier grant must NOT leak.
    leaked: await hasServerPermission('chapter_president', 'canManageEvents'),
    canonical: await resolveCanonicalRole(fake as never, 'officer-1'),
    blanket: await hasServerPermission('founder_patron', 'canManageRoles'),
    staticFallback: await hasServerPermission('returning_officer', 'canRunElections'),
  };
}
const EXPECTED = {
  granted: true,
  leaked: false,
  canonical: 'chapter_president',
  blanket: true,
  staticFallback: true,
};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  resetIdentityCache();
  fake = new FakeDb();
  mockDbHolder.db = fake;
  seedFixtures();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// A. Flag-state equivalence on the Firestore path (always runs)
// ---------------------------------------------------------------------------

describe('A. resolution answers are flag-invariant with no Supabase client configured', () => {
  it.each([
    ['flag unset (default OFF)', {}],
    ['SUPA_SURFACES=roles (ON, unconfigured)', { SUPA_SURFACES: 'roles' }],
    ['SUPA_SURFACES=* (ON, unconfigured)', { SUPA_SURFACES: '*' }],
    ['SUPA_SURFACES=ROLES (case variant)', { SUPA_SURFACES: 'ROLES' }],
    ['NEXT_PUBLIC_SUPA_SURFACES=roles', { NEXT_PUBLIC_SUPA_SURFACES: 'roles' }],
    ['SUPA_ALL=1 (roles-1 env fallback vocabulary)', { SUPA_ALL: '1' }],
  ])('%s: identical answers', async (_label, env) => {
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    resetIdentityCache();
    await expect(battery()).resolves.toEqual(EXPECTED);
  });

  it('flag ON + Firestore error still falls back to static config (adapter fallback contract)', async () => {
    process.env.SUPA_SURFACES = 'roles';
    const throwingDb = {
      collection: () => ({
        doc: () => ({
          get: async () => {
            throw new Error('RESOURCE_EXHAUSTED: fake');
          },
        }),
      }),
    };
    mockDbHolder.db = throwingDb;
    await expect(hasServerPermission('returning_officer', 'canRunElections')).resolves.toBe(true);
    await expect(hasServerPermission('chapter_president', 'canManageTasks')).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B. Server seam (feat/supa-roles-1) — conditional
// ---------------------------------------------------------------------------

const seamPath = '../supa-roles-seam';
let seam: Record<string, any> | null = null;
try {
  // Variable specifier: the module does not exist on the base tree.
  seam = require(seamPath);
} catch {
  seam = null;
}

describe('B. server seam supa-roles-seam (feat/supa-roles-1)', () => {
  if (!seam) {
    it('PENDING: seam module not on this branch — depends on feat/supa-roles-1 (ae4ac39, 6941879) + feat/supa-adapter (85e657f)', () => {
      expect(seam).toBeNull();
    });
    return;
  }

  const rows = [{ id: 'chapter_president', data: { permissions: ['canManageTasks'] } }];
  const makeAdapter = (over: Record<string, unknown> = {}) => ({
    useSupa: jest.fn(() => true),
    getDoc: jest.fn(async () => ({ exists: true, data: { permissions: ['canManageTasks'] } })),
    listDocs: jest.fn(async () => rows),
    setDoc: jest.fn(async () => undefined),
    updateDoc: jest.fn(async () => undefined),
    deleteDoc: jest.fn(async () => undefined),
    ...over,
  });

  afterEach(() => seam!.__setSupaAdapterForTests(null));

  it('flag OFF: supaGetDoc/supaListDocs return null (Firestore fallback signal), mirrors return false and never call the adapter', async () => {
    const adapter = makeAdapter({ useSupa: jest.fn(() => false) });
    seam!.__setSupaAdapterForTests(adapter);
    await expect(seam!.supaEnabledFor('roleDefinitions')).resolves.toBe(false);
    await expect(seam!.supaGetDoc('roleDefinitions', 'chapter_president')).resolves.toBeNull();
    await expect(seam!.supaListDocs('roleDefinitions')).resolves.toBeNull();
    await expect(seam!.supaMirrorSet('roleDefinitions', 'x', {})).resolves.toBe(false);
    expect(adapter.getDoc).not.toHaveBeenCalled();
    expect(adapter.setDoc).not.toHaveBeenCalled();
  });

  it('flag ON (Supabase mocked): docs and lists come from the adapter, shapes normalized', async () => {
    const adapter = makeAdapter();
    seam!.__setSupaAdapterForTests(adapter);
    await expect(seam!.supaEnabledFor('roleDefinitions')).resolves.toBe(true);
    await expect(seam!.supaGetDoc('roleDefinitions', 'chapter_president')).resolves.toEqual({
      exists: true,
      data: { permissions: ['canManageTasks'] },
    });
    await expect(seam!.supaListDocs('roleDefinitions')).resolves.toEqual(rows);
    await expect(seam!.supaMirrorSet('roleDefinitions', 'x', { a: 1 })).resolves.toBe(true);
    expect(adapter.setDoc).toHaveBeenCalledWith('roleDefinitions', 'x', { a: 1 });
  });

  it('flag ON: a genuinely missing doc is {exists:false}, NOT the null fallback signal', async () => {
    seam!.__setSupaAdapterForTests(makeAdapter({ getDoc: jest.fn(async () => ({ exists: false })) }));
    await expect(seam!.supaGetDoc('roleDefinitions', 'nope')).resolves.toEqual({
      exists: false,
      data: undefined,
    });
  });

  it('flag ON + Supabase error: reads fall back (null) and mirrors swallow errors (false, never throw)', async () => {
    const boom = jest.fn(async () => {
      throw new Error('supabase down');
    });
    seam!.__setSupaAdapterForTests(
      makeAdapter({ getDoc: boom, listDocs: boom, setDoc: boom, deleteDoc: boom }),
    );
    await expect(seam!.supaGetDoc('roleDefinitions', 'x')).resolves.toBeNull();
    await expect(seam!.supaListDocs('roleDefinitions')).resolves.toBeNull();
    await expect(seam!.supaMirrorSet('roleDefinitions', 'x', {})).resolves.toBe(false);
    await expect(seam!.supaMirrorDelete('roleDefinitions', 'x')).resolves.toBe(false);
  });

  it('no adapter at all: enabled is false in every state (default OFF)', async () => {
    seam!.__setSupaAdapterForTests(null);
    await expect(seam!.supaGetDoc('roles', 'officer-1')).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C. Client seam (feat/supa-roles-3) — conditional
// ---------------------------------------------------------------------------

const clientSeamPath = '../../supa-roles-client-seam';
let clientSeam: Record<string, any> | null = null;
try {
  clientSeam = require(clientSeamPath);
} catch {
  clientSeam = null;
}

describe('C. client seam flag parsing (feat/supa-roles-3)', () => {
  if (!clientSeam) {
    it('PENDING: client seam not on this branch — depends on feat/supa-roles-3 (7ed7e33)', () => {
      expect(clientSeam).toBeNull();
    });
    return;
  }

  it('ROLES_SUPA_SURFACE is exactly "roles"', () => {
    expect(clientSeam!.ROLES_SUPA_SURFACE).toBe('roles');
  });

  it('rolesSupaEnabled: unset/empty/other-surface OFF; roles, ROLES and * ON', () => {
    expect(clientSeam!.rolesSupaEnabled(undefined)).toBe(false);
    expect(clientSeam!.rolesSupaEnabled('')).toBe(false);
    expect(clientSeam!.rolesSupaEnabled('directory')).toBe(false);
    expect(clientSeam!.rolesSupaEnabled('roles')).toBe(true);
    expect(clientSeam!.rolesSupaEnabled('ROLES')).toBe(true);
    expect(clientSeam!.rolesSupaEnabled('directory, roles')).toBe(true);
    expect(clientSeam!.rolesSupaEnabled('*')).toBe(true);
  });

  it('parseSupaClientSurfaces trims, lowercases and drops empties', () => {
    expect([...clientSeam!.parseSupaClientSurfaces(' Roles, ,DIRECTORY ')]).toEqual([
      'roles',
      'directory',
    ]);
    expect(clientSeam!.parseSupaClientSurfaces(undefined).size).toBe(0);
  });
});
