/**
 * @jest-environment node
 *
 * AUTH IDENTITY RE-HOME — the identity bundle's users half is
 * seam-first, exactly like its roles half.
 *
 * Bug pinned: loadIdentityBundle (src/lib/server/permissions.ts) read
 * roles/{uid} through supaGetDoc (Supabase-first, Firestore fallback
 * on seam-null) but read users/{uid} UNCONDITIONALLY from Firestore.
 * Under a Firestore read-quota outage that get threw, the bundle load
 * rejected, verifyAuthentication folded it to unauthenticated, and
 * every authenticated route answered 401.
 *
 * Fix pinned: the users half is restructured into the same async-IIFE
 * shape as the roles half — supaGetDoc('users', uid) first (the
 * flipped users surface), Firestore users get only when the seam
 * returns null. The bundle projection is byte-identical.
 *
 * ZERO live reads: Firestore is the CountingDb fake below (house
 * harness, mirroring supa-roles-resolution-core.test.ts); Supabase is
 * the injected seam adapter (__setSupaAdapterForTests), whose getDoc
 * returns { exists, data } and whose useSupa returns true.
 */

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  admin: {
    firestore: {
      FieldValue: { serverTimestamp: () => 'ts', delete: () => 'del' },
    },
  },
}));

import { getIdentityBundleCached, resolveIdentityForAuth } from '../permissions';
import { resetIdentityCache, type IdentityBundle } from '../identity-cache';
import { __setSupaAdapterForTests, type SupaAdapter } from '../supa-roles-seam';

// ---------------------------------------------------------------------------
// Counting in-memory Firestore fake (doc gets only — the core's read surface)
// ---------------------------------------------------------------------------

type DocData = Record<string, unknown>;

class CountingDb {
  store = new Map<string, Map<string, DocData>>();
  counts = new Map<string, number>();
  throwOnGet = false;

  seed(col: string, id: string, data: DocData) {
    if (!this.store.has(col)) this.store.set(col, new Map());
    this.store.get(col)!.set(id, { ...data });
  }
  docGets(col?: string, id?: string): number {
    if (col && id) return this.counts.get(`${col}/${id}`) ?? 0;
    let n = 0;
    for (const [k, v] of this.counts) if (!col || k.startsWith(`${col}/`)) n += v;
    return n;
  }
  collection(name: string) {
    const self = this;
    return {
      doc: (id: string) => ({
        get: async () => {
          self.counts.set(`${name}/${id}`, (self.counts.get(`${name}/${id}`) ?? 0) + 1);
          if (self.throwOnGet) throw new Error('RESOURCE_EXHAUSTED: fake');
          const data = self.store.get(name)?.get(id);
          return {
            exists: data !== undefined,
            id,
            data: () => (data ? { ...data } : undefined),
          };
        },
      }),
    };
  }
}

// ---------------------------------------------------------------------------
// Injected Supabase adapter fake (the seam's { exists, data } shape)
// ---------------------------------------------------------------------------

type DocMap = Record<string, Record<string, DocData>>;

function makeAdapter(docs: DocMap): SupaAdapter {
  return {
    useSupa: () => true,
    getDoc: async (collection: string, id: string) => {
      const data = docs[collection]?.[id];
      return data ? { exists: true, data: { ...data } } : { exists: false };
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures: one logical identity, expressed once, served by either backend
// ---------------------------------------------------------------------------

const CHAPTER = 'seds-ist-chapter';
const UID = 'u-rehome';

const LOGICAL_ROLES: DocData = {
  role: 'chapter_vice_president',
  additionalRoles: ['chapter_events_chair'],
  expiresAt: '2030-01-01T00:00:00.000Z',
  expiresRoleKey: 'chapter_events_chair',
  chapterId: CHAPTER,
};
const LOGICAL_USERS: DocData = {
  role: 'chapter_vice_president',
  displayRole: 'Chapter Vice President',
  additionalRoles: ['chapter_events_chair'],
  isBanned: false,
  chapterId: CHAPTER,
};

/** DIFFERENT stale values for the same uid, seeded in Firestore behind
 * the seam: if any Firestore get leaked into a seam-on run, the bundle
 * would show these instead of the Supabase values. */
function seedStaleFirestore(fake: CountingDb, uid: string) {
  fake.seed('roles', uid, {
    role: 'member_basic',
    additionalRoles: [],
    chapterId: 'stale-chapter',
  });
  fake.seed('users', uid, {
    role: 'member_basic',
    displayRole: 'Stale Member',
    additionalRoles: [],
    isBanned: true,
    chapterId: 'stale-chapter',
  });
}

function stripLoadedAt(bundle: IdentityBundle) {
  const { loadedAt, ...rest } = bundle;
  expect(typeof loadedAt).toBe('number');
  return rest;
}

const ENV_KEYS = ['SUPA_ALL', 'NEXT_PUBLIC_SUPA_ALL', 'SUPA_ROLES', 'SUPA_USERS'];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  resetIdentityCache();
  __setSupaAdapterForTests(null);
  mockDbHolder.db = null;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  __setSupaAdapterForTests(null);
  resetIdentityCache();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  jest.restoreAllMocks();
});

afterAll(() => {
  __setSupaAdapterForTests(null);
});

/** The Firestore-path bundle for the LOGICAL data: adapter null, env
 * flags unset (cleared in beforeEach), data seeded in the fake. */
async function firestoreBundleFor(uid: string): Promise<{ bundle: IdentityBundle; fake: CountingDb }> {
  __setSupaAdapterForTests(null);
  resetIdentityCache();
  const fake = new CountingDb();
  fake.seed('roles', uid, LOGICAL_ROLES);
  fake.seed('users', uid, LOGICAL_USERS);
  const bundle = await getIdentityBundleCached(fake as never, uid);
  return { bundle, fake };
}

describe('auth identity re-home (users half seam-first)', () => {
  it('(a) role holder parity: seam-on bundle is projected from Supabase, equals the Firestore bundle for the same logical data, with ZERO Firestore gets', async () => {
    __setSupaAdapterForTests(makeAdapter({ roles: { [UID]: LOGICAL_ROLES }, users: { [UID]: LOGICAL_USERS } }));
    const fake = new CountingDb();
    seedStaleFirestore(fake, UID);

    const seamBundle = await getIdentityBundleCached(fake as never, UID);
    expect(stripLoadedAt(seamBundle)).toEqual({
      roles: {
        exists: true,
        role: 'chapter_vice_president',
        additionalRoles: ['chapter_events_chair'],
        expiresAt: '2030-01-01T00:00:00.000Z',
        expiresRoleKey: 'chapter_events_chair',
        chapterId: CHAPTER,
      },
      users: {
        exists: true,
        role: 'chapter_vice_president',
        displayRole: 'Chapter Vice President',
        additionalRoles: ['chapter_events_chair'],
        isBanned: false,
        chapterId: CHAPTER,
      },
    });
    // The stale Firestore rows were never read.
    expect(fake.docGets()).toBe(0);

    // Same logical data through the Firestore loader (seam disabled).
    const { bundle: firestoreBundle } = await firestoreBundleFor(UID);
    expect(stripLoadedAt(seamBundle)).toEqual(stripLoadedAt(firestoreBundle));
  });

  it('(b) users-only member: roles row missing in Supabase, users row present; auth derives the users-based role with zero Firestore gets', async () => {
    const uid = 'u-users-only';
    __setSupaAdapterForTests(
      makeAdapter({ users: { [uid]: { role: 'member_basic', isBanned: false, chapterId: CHAPTER } } }),
    );
    const fake = new CountingDb();
    seedStaleFirestore(fake, uid);

    const bundle = await getIdentityBundleCached(fake as never, uid);
    expect(bundle.users?.exists).toBe(true);
    expect(bundle.roles?.exists).toBe(false);
    expect(bundle.users?.role).toBe('member_basic');

    await expect(resolveIdentityForAuth(fake as never, uid)).resolves.toEqual({
      role: 'member_basic',
      isBanned: false,
    });
    expect(fake.docGets()).toBe(0);
  });

  it('(c) missing doc: both halves exists:false; auth answer matches the Firestore path for a fully-missing user; zero Firestore gets', async () => {
    const uid = 'u-missing';
    __setSupaAdapterForTests(makeAdapter({}));
    const fake = new CountingDb();
    seedStaleFirestore(fake, uid);

    const bundle = await getIdentityBundleCached(fake as never, uid);
    expect(bundle.roles?.exists).toBe(false);
    expect(bundle.users?.exists).toBe(false);

    const seamAuth = await resolveIdentityForAuth(fake as never, uid);
    expect(seamAuth.isBanned).toBe(false);
    expect(fake.docGets()).toBe(0);

    // Firestore path for a fully-missing user (nothing seeded).
    __setSupaAdapterForTests(null);
    resetIdentityCache();
    const offFake = new CountingDb();
    const firestoreAuth = await resolveIdentityForAuth(offFake as never, uid);
    expect(seamAuth).toEqual(firestoreAuth);
    expect(firestoreAuth.isBanned).toBe(false);
  });

  it('(d) OUTAGE REGRESSION: seam ON serving rows while every Firestore get throws RESOURCE_EXHAUSTED — auth still resolves with the correct role/isBanned', async () => {
    __setSupaAdapterForTests(makeAdapter({ roles: { [UID]: LOGICAL_ROLES }, users: { [UID]: LOGICAL_USERS } }));
    const fake = new CountingDb();
    fake.throwOnGet = true;

    // Before the fix this rejected (the unconditional Firestore users
    // get threw) and verifyAuthentication folded it to a 401.
    await expect(getIdentityBundleCached(fake as never, UID)).resolves.toMatchObject({
      roles: { exists: true, role: 'chapter_vice_president' },
      users: { exists: true, role: 'chapter_vice_president', isBanned: false },
    });

    resetIdentityCache();
    await expect(resolveIdentityForAuth(fake as never, UID)).resolves.toEqual({
      role: 'chapter_vice_president',
      isBanned: false,
    });
    expect(fake.docGets()).toBe(0);
  });

  it('(e) flag-off parity: adapter null, Firestore bundle deep-equals the seam bundle except loadedAt, with exactly the two cold gets (roles + users)', async () => {
    // Seam bundle first (Firestore behind it holds only stale rows).
    __setSupaAdapterForTests(makeAdapter({ roles: { [UID]: LOGICAL_ROLES }, users: { [UID]: LOGICAL_USERS } }));
    const seamFake = new CountingDb();
    seedStaleFirestore(seamFake, UID);
    const seamBundle = await getIdentityBundleCached(seamFake as never, UID);
    expect(seamFake.docGets()).toBe(0);

    // Flag-off run over the same logical data in Firestore.
    const { bundle: firestoreBundle, fake } = await firestoreBundleFor(UID);
    expect(stripLoadedAt(firestoreBundle)).toEqual(stripLoadedAt(seamBundle));
    expect(fake.docGets()).toBe(2);
    expect(fake.docGets('roles', UID)).toBe(1);
    expect(fake.docGets('users', UID)).toBe(1);
  });
});
