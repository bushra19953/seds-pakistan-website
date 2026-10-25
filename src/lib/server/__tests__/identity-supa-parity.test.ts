/**
 * @jest-environment node
 *
 * IDENTITY PARITY SUITE (Supabase migration, identity cluster).
 *
 * Proves that a Supabase-backed identity reader returns outputs
 * SHAPE-FOR-SHAPE identical to the Firestore-backed one:
 *   - the full IdentityBundle from getIdentityBundleCached /
 *     loadIdentityBundle (roles/{uid} + users/{uid} projections), and
 *   - PermissionDocEntry values from getPermissionDoc
 *     (roleDefinitions/{slug}, permissions/{slug}),
 * for every fixture in helpers/identity-parity-fixtures.ts, plus the
 * pinned failure semantics (missing docs are data; a throwing read
 * propagates, is never cached, and auth-middleware folds it into
 * authenticated:false).
 *
 * HOW IT RUNS TODAY (A-vs-stub):
 *   Side A = the REAL production Firestore path: CountingFirestore
 *   seeded from the fixture's Firestore expression, read through
 *   getIdentityBundleCached (bundle) and through the exact loader
 *   body permissions.ts uses inside cachedDocGet (permission docs).
 *   Side B = a test-local STUB loader fed by the SAME fixture's fs_*
 *   row expression (helpers/identity-parity-fixtures.ts fsRowsFor),
 *   plugged into the SAME identity-cache wrappers
 *   (getIdentityBundle / getPermissionDoc), so caching, copying and
 *   freezing semantics are shared and only the data source differs.
 *   The stub is an independent re-statement of the projection rules
 *   over the fs_* rows; it is NOT the production reader.
 *
 * ZERO live reads: Firestore is the in-memory CountingFirestore
 * fake; the "Supabase" side reads in-memory fixture rows. No network,
 * no real Firestore, no real Supabase.
 */

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  admin: {
    auth: () => ({
      verifyIdToken: async (token: string) => {
        const uid = token.startsWith('tok:') ? token.slice(4) : token;
        return { uid, email: `${uid}@example.com`, email_verified: true, name: uid };
      },
    }),
    firestore: {
      FieldValue: {
        serverTimestamp: () => 'ts',
        increment: (n: number) => ({ __increment: n }),
        delete: () => ({ __delete: true }),
      },
    },
  },
}));
jest.mock('firebase/auth', () => ({ getAuth: jest.fn() }));
jest.mock('@/firebase', () => ({ getFirebaseApp: jest.fn() }));
jest.mock('@/firebase/error-emitter', () => ({ errorEmitter: { emit: jest.fn() } }));
jest.mock('@/firebase/errors', () => ({
  FirestorePermissionError: class FirestorePermissionError extends Error {
    constructor() { super('permission-error'); }
  },
}));

import { NextRequest } from 'next/server';
import { CountingFirestore, resourceExhaustedError } from './helpers/counting-firestore';
import {
  IDENTITY_PARITY_FIXTURES,
  PARITY_FIXED_NOW,
  expectedBundleFor,
  expectedPermissionEntryFor,
  fsRowsFor,
  type FsRow,
  type IdentityParityFixture,
  type PermissionCollection,
} from './helpers/identity-parity-fixtures';
import {
  getIdentityBundle,
  getPermissionDoc,
  resetIdentityCache,
  type IdentityBundle,
  type PermissionDocEntry,
} from '../identity-cache';
import { getIdentityBundleCached, resolveIdentityForAuth } from '../permissions';
import { loadIdentityBundleFromSupa, loadPermissionDocFromSupa } from '../identity-supa';
import { verifyAuthentication, withAuth } from '@/lib/auth-middleware';

/* ------------------------------------------------------------------ */
/* Reader factories (parameterized parity harness)                     */
/* ------------------------------------------------------------------ */

/**
 * A reader-under-test is a pair of RAW loaders: one identity-bundle
 * loader for a uid, one permission-doc loader for (collection,
 * slug). Loaders plug into the identity-cache wrappers, exactly as
 * the production Firestore loaders do today.
 */
export interface IdentityReaderLoaders {
  loadBundleRaw: (uid: string) => Promise<IdentityBundle>;
  loadPermissionDocRaw: (
    collection: PermissionCollection,
    slug: string,
  ) => Promise<PermissionDocEntry>;
}

export type IdentityReaderFactory = (
  fixture: IdentityParityFixture,
) => IdentityReaderLoaders;

/** Side A: the existing Firestore-backed loaders, fixture-seeded. */
function createFirestoreIdentityReader(fixture: IdentityParityFixture): IdentityReaderLoaders & {
  counting: CountingFirestore;
} {
  const counting = new CountingFirestore();
  if (fixture.rolesDoc) counting.seed('roles', fixture.uid, fixture.rolesDoc);
  if (fixture.usersDoc) counting.seed('users', fixture.uid, fixture.usersDoc);
  for (const perm of fixture.permissionDocs) {
    if (perm.doc) counting.seed(perm.collection, perm.slug, perm.doc);
  }
  const db = counting.asDb();
  return {
    counting,
    // Bundle: the production cached accessor (permissions.ts
    // getIdentityBundleCached -> getBundleForDb -> loadIdentityBundle).
    loadBundleRaw: async (uid) => getIdentityBundleCached(db, uid),
    // Permission doc RAW get: the exact loader body permissions.ts
    // passes to getPermissionDoc inside cachedDocGet.
    loadPermissionDocRaw: async (collection, slug) => {
      const snap = await counting.collection(collection).doc(slug).get();
      return {
        exists: snap.exists,
        data: snap.exists ? (snap.data() as Record<string, unknown> | undefined) : undefined,
      };
    },
  };
}

/**
 * Side B STUB (test-local): an independent projection over the
 * fixture's fs_* rows. Lookup is by (table, id) — table fs_roles /
 * fs_users for the bundle, fs_permissions / fs_roleDefinitions for
 * permission docs; a missing doc is a MISSING ROW. The projection
 * re-states loadIdentityBundle's rules directly from the row data:
 * only the projected fields, additionalRoles sliced, isBanned only
 * on === true, loadedAt from Date.now() (frozen clock in tests).
 * `failOnTable` simulates a throwing backend read for the failure
 * tests (the same RESOURCE_EXHAUSTED shape Firestore produces).
 */
function createStubSupaIdentityReader(
  fixture: IdentityParityFixture,
  opts: { failOnTable?: string } = {},
): IdentityReaderLoaders {
  const rows: FsRow[] = fsRowsFor(fixture);
  const findRow = (table: string, id: string): FsRow | undefined => {
    if (opts.failOnTable === table) throw resourceExhaustedError();
    return rows.find((r) => r.table === table && r.id === id);
  };
  const slice = (v: unknown): unknown => (Array.isArray(v) ? [...v] : v);
  return {
    loadBundleRaw: async (uid) => {
      const roleRow = findRow('fs_roles', uid);
      const userRow = findRow('fs_users', uid);
      const roleData = roleRow?.data;
      const userData = userRow?.data;
      return {
        roles: {
          exists: roleRow !== undefined,
          role: roleData?.role,
          additionalRoles: slice(roleData?.additionalRoles),
          expiresAt: roleData?.expiresAt,
          expiresRoleKey: roleData?.expiresRoleKey,
          chapterId: roleData?.chapterId,
        },
        users: {
          exists: userRow !== undefined,
          role: userData?.role,
          displayRole: userData?.displayRole,
          additionalRoles: slice(userData?.additionalRoles),
          isBanned: userData?.isBanned === true,
          chapterId: userData?.chapterId,
        },
        loadedAt: Date.now(),
      };
    },
    loadPermissionDocRaw: async (collection, slug) => {
      const row = findRow(`fs_${collection}`, slug);
      return row
        ? { exists: true, data: { ...row.data } }
        : { exists: false, data: undefined };
    },
  };
}

/**
 * ACCEPTANCE AUDIT (feat/supa-identity-6): the REAL Supa reader factory.
 * Wraps implementer A's production loaders (identity-supa.ts
 * loadIdentityBundleFromSupa / loadPermissionDocFromSupa). The ONLY
 * mock is the fetchRowData seam's transport — global fetch + the
 * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env — serving this
 * fixture's fs_* rows, exactly the mocking pattern of A's own
 * identity-supa.test.ts. No other code is stubbed: A's projection,
 * parallel Promise.all, isBanned coercion and throw-on-failure all run
 * for real.
 */
function createRealSupaIdentityReader(
  fixture: IdentityParityFixture,
): IdentityReaderLoaders {
  const rows: FsRow[] = fsRowsFor(fixture);
  process.env.SUPABASE_URL = 'https://supa.example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  globalThis.fetch = jest.fn(async (url: string) => {
    const u = new URL(url as string);
    const table = u.pathname.split('/').pop() as string;
    const id = (u.searchParams.get('id') ?? '').replace(/^eq\./, '');
    const row = rows.find((r) => r.table === table && r.id === id);
    return {
      ok: true,
      status: 200,
      json: async () => (row === undefined ? [] : [{ data: row.data }]),
    };
  }) as unknown as typeof fetch;
  return {
    loadBundleRaw: async (uid) => loadIdentityBundleFromSupa(uid),
    loadPermissionDocRaw: async (collection, slug) =>
      loadPermissionDocFromSupa(collection, slug),
  };
}

/**
 * ================================================================
 *  ACCEPTANCE-AUDITOR SWAP POINT
 * ================================================================
 *  When the sibling implementer's Supabase-backed identity reader
 *  lands, replace ONLY the right-hand side of the next line with
 *  that reader's factory (same IdentityReaderFactory signature:
 *  fixture -> { loadBundleRaw, loadPermissionDocRaw }, its loaders
 *  reading the fixture's fs_* rows through the real Supabase reader
 *  code with Supabase mocked). Every assertion below then runs
 *  unchanged against the real reader. Until then it is wired to the
 *  test-local stub above, and the suite proves A-vs-stub parity.
 * ================================================================
 */
export const SUPA_IDENTITY_READER_FACTORY_UNDER_TEST: IdentityReaderFactory =
  createRealSupaIdentityReader; // AUDIT SWAP (feat/supa-identity-6): was createStubSupaIdentityReader

/** Run a bundle load through the identity cache (fresh scope). */
function loadBundleViaCache(
  factory: IdentityReaderFactory,
  fixture: IdentityParityFixture,
): Promise<IdentityBundle> {
  const loaders = factory(fixture);
  return getIdentityBundle(fixture.uid, () => loaders.loadBundleRaw(fixture.uid), {
    scope: {},
  });
}

/** Side A bundle: the production cached accessor, no extra wrapper. */
function loadBundleSideA(fixture: IdentityParityFixture): Promise<IdentityBundle> {
  const reader = createFirestoreIdentityReader(fixture);
  return reader.loadBundleRaw(fixture.uid);
}

/** Run a permission-doc load through the identity cache (fresh scope). */
function loadPermissionViaCache(
  loaders: IdentityReaderLoaders,
  collection: PermissionCollection,
  slug: string,
): Promise<PermissionDocEntry> {
  return getPermissionDoc(collection, slug, () => loaders.loadPermissionDocRaw(collection, slug), {
    scope: {},
  });
}

/* ------------------------------------------------------------------ */
/* Setup: one frozen clock so loadedAt is deep-equal across sides    */
/* ------------------------------------------------------------------ */

let nowSpy: jest.SpyInstance;

beforeEach(() => {
  resetIdentityCache();
  mockDbHolder.db = null;
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(PARITY_FIXED_NOW);
});

afterEach(() => {
  nowSpy.mockRestore();
});

/* ------------------------------------------------------------------ */
/* Parity per fixture                                                  */
/* ------------------------------------------------------------------ */

describe('identity parity: Firestore (side A) vs reader-under-test (side B)', () => {
  for (const fixture of IDENTITY_PARITY_FIXTURES) {
    describe(`fixture ${fixture.id} [${fixture.covers}]`, () => {
      it('IdentityBundle: B deep-equals A, and A deep-equals the stated expected shape', async () => {
        const a = await loadBundleSideA(fixture);
        const b = await loadBundleViaCache(SUPA_IDENTITY_READER_FACTORY_UNDER_TEST, fixture);
        expect(a).toEqual(expectedBundleFor(fixture));
        expect(b).toEqual(a);
      });

      it('side A auth derivation matches the pinned expectedAuth', async () => {
        const reader = createFirestoreIdentityReader(fixture);
        mockDbHolder.db = reader.counting.asDb();
        const auth = await resolveIdentityForAuth(reader.counting.asDb(), fixture.uid);
        expect(auth).toEqual(fixture.expectedAuth);
      });

      for (const perm of fixture.permissionDocs) {
        it(`PermissionDocEntry ${perm.collection}/${perm.slug}: B deep-equals A and the stated shape`, async () => {
          const readerA = createFirestoreIdentityReader(fixture);
          const a = await loadPermissionViaCache(readerA, perm.collection, perm.slug);
          const loadersB = SUPA_IDENTITY_READER_FACTORY_UNDER_TEST(fixture);
          const b = await loadPermissionViaCache(loadersB, perm.collection, perm.slug);
          expect(a).toEqual(expectedPermissionEntryFor(perm));
          expect(b).toEqual(a);
        });
      }
    });
  }

  it('custom-additionals cap: the bundle preserves index 3 verbatim (the cap bites downstream, never in the reader)', async () => {
    const fixture = IDENTITY_PARITY_FIXTURES.find((f) => f.id === 'custom-additionals-index-0-to-3')!;
    const b = await loadBundleViaCache(SUPA_IDENTITY_READER_FACTORY_UNDER_TEST, fixture);
    expect(b.roles?.additionalRoles).toEqual([
      'custom_alpha',
      'custom_beta',
      'custom_gamma',
      'custom_delta', // index 3: rules unroll (cap 0-2) drops this; the reader must not
    ]);
  });

  it('founder-by-string vs founder-by-UID: identical docs on a non-founder uid produce a bundle identical to the founder\u2019s', async () => {
    const founder = IDENTITY_PARITY_FIXTURES.find((f) => f.id === 'founder-no-scope')!;
    const other = IDENTITY_PARITY_FIXTURES.find((f) => f.id === 'founder-string-on-other-uid')!;
    const founderBundle = await loadBundleSideA(founder);
    const otherBundle = await loadBundleViaCache(SUPA_IDENTITY_READER_FACTORY_UNDER_TEST, other);
    // No uid, no founder flag, no scope anywhere in the output:
    // root power (isFounderUid) cannot be derived from this shape.
    expect(otherBundle).toEqual(founderBundle);
    expect(JSON.stringify(otherBundle)).not.toContain(other.uid);
    expect(JSON.stringify(otherBundle)).not.toContain('isFounder');
  });
});

/* ------------------------------------------------------------------ */
/* Failure semantics (pinned side-A behavior; B must match)          */
/* ------------------------------------------------------------------ */

describe('failure semantics (pinned, do not change)', () => {
  const fixture = IDENTITY_PARITY_FIXTURES.find((f) => f.id === 'member-basic')!;

  it('user doc missing: side A RETURNS an exists:false bundle (no throw), and so does B', async () => {
    const noUsers = IDENTITY_PARITY_FIXTURES.find((f) => f.id === 'no-users-doc')!;
    const a = await loadBundleSideA(noUsers);
    expect(a.users).toEqual({
      exists: false,
      role: undefined,
      displayRole: undefined,
      additionalRoles: undefined,
      isBanned: false,
      chapterId: undefined,
    });
    const b = await loadBundleViaCache(SUPA_IDENTITY_READER_FACTORY_UNDER_TEST, noUsers);
    expect(b).toEqual(a);
  });

  it('RESOURCE_EXHAUSTED on the bundle load: side A THROWS (never returns a stale/partial bundle) and the error is not cached', async () => {
    const reader = createFirestoreIdentityReader(fixture);
    const quota = resourceExhaustedError();
    reader.counting.setThrow('roles', quota);
    await expect(reader.loadBundleRaw(fixture.uid)).rejects.toMatchObject({
      code: 'RESOURCE_EXHAUSTED',
    });
    // Not cached: once the throw clears, the very next load re-reads
    // and succeeds with the real shape.
    reader.counting.setThrow(null, null);
    resetIdentityCache();
    const ok = await reader.loadBundleRaw(fixture.uid);
    expect(ok).toEqual(expectedBundleFor(fixture));
  });

  it('RESOURCE_EXHAUSTED on the bundle load: side B (stub) throws the same shape and is not cached', async () => {
    let failing = true;
    const factory: IdentityReaderFactory = (f) =>
      createStubSupaIdentityReader(f, failing ? { failOnTable: 'fs_roles' } : {});
    await expect(loadBundleViaCache(factory, fixture)).rejects.toMatchObject({
      code: 'RESOURCE_EXHAUSTED',
    });
    failing = false;
    const ok = await loadBundleViaCache(factory, fixture);
    expect(ok).toEqual(expectedBundleFor(fixture));
  });

  it('RESOURCE_EXHAUSTED on a permission-doc get: throws on both sides; NEVER converted to {exists:false}; not cached', async () => {
    const perm = { collection: 'permissions' as const, slug: 'member_basic' };
    const withDoc: IdentityParityFixture = {
      ...fixture,
      permissionDocs: [{ ...perm, doc: { canManageTasks: true } }],
    };
    // Side A
    const readerA = createFirestoreIdentityReader(withDoc);
    readerA.counting.setThrow('permissions', resourceExhaustedError());
    await expect(loadPermissionViaCache(readerA, perm.collection, perm.slug)).rejects.toMatchObject({
      code: 'RESOURCE_EXHAUSTED',
    });
    readerA.counting.setThrow(null, null);
    const aOk = await loadPermissionViaCache(readerA, perm.collection, perm.slug);
    expect(aOk).toEqual({ exists: true, data: { canManageTasks: true } });
    // Side B (stub failing on the fs_permissions table)
    let failing = true;
    const factoryB: IdentityReaderFactory = (f) =>
      createStubSupaIdentityReader(f, failing ? { failOnTable: 'fs_permissions' } : {});
    const loadersB = factoryB(withDoc);
    await expect(loadPermissionViaCache(loadersB, perm.collection, perm.slug)).rejects.toMatchObject({
      code: 'RESOURCE_EXHAUSTED',
    });
    failing = false;
    const bOk = await loadPermissionViaCache(factoryB(withDoc), perm.collection, perm.slug);
    expect(bOk).toEqual(aOk);
  });

  it('what auth-middleware makes of a throwing bundle load (pinned): verifyAuthentication folds it to authenticated:false, withAuth answers 401 {error:"Unauthorized"}', async () => {
    const reader = createFirestoreIdentityReader(fixture);
    mockDbHolder.db = reader.counting.asDb();
    reader.counting.setThrow('roles', resourceExhaustedError());
    // FOUNDER_ACCESS_MAP §0: the catch-all in auth-middleware folds
    // ANY identity-load throw into authenticated:false with error
    // 'Authentication verification failed' (NOT a 503, NOT a stale
    // success). This pins that behavior; changing it is a separate
    // fix program (§5 item 1), not a reader-parity change.
    const result = await verifyAuthentication(
      new NextRequest('http://localhost/api/test', {
        headers: { authorization: `Bearer tok:${fixture.uid}` },
      }),
    );
    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Authentication verification failed');

    const res = await withAuth(
      new NextRequest('http://localhost/api/test', {
        headers: { authorization: `Bearer tok:${fixture.uid}` },
      }),
      async () => new Response('should not run') as never,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'Unauthorized',
      message: 'Authentication verification failed',
    });
  });

  it('resolveIdentityForAuth itself does NOT swallow the throw (the fold happens only in auth-middleware)', async () => {
    const reader = createFirestoreIdentityReader(fixture);
    reader.counting.setThrow('users', resourceExhaustedError());
    await expect(
      resolveIdentityForAuth(reader.counting.asDb(), fixture.uid),
    ).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' });
  });
});
