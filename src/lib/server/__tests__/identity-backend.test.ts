/**
 * @jest-environment node
 *
 * Backend dispatcher (identity-backend.ts): SUPA_SURFACES gating,
 * Firestore path when OFF, Supa path (behind the real identity cache,
 * distinct scope) when ON, Firestore fallback when the Supa load
 * throws, and cache-scope isolation between the two backends.
 * Firestore is a counting fake; Supa is a mocked global fetch (the
 * fetchRowData transport). Zero live reads.
 */
import { getIdentityBundle, resetIdentityCache, type IdentityBundle } from '../identity-cache';
import { getDb } from '../firebase-admin';
import { getIdentityBundleCached } from '../permissions';
import {
  useSupaIdentity,
  getIdentityBundleViaBackend,
  getPermissionDocViaBackend,
} from '../identity-backend';

jest.mock('../firebase-admin', () => ({ getDb: jest.fn() }));
jest.mock('../permissions', () => ({ getIdentityBundleCached: jest.fn() }));

const getDbMock = getDb as unknown as jest.Mock;
const cachedMock = getIdentityBundleCached as unknown as jest.Mock;

const FIRESTORE_BUNDLE: IdentityBundle = {
  roles: { exists: true, role: 'firestore_role', additionalRoles: undefined, expiresAt: undefined, expiresRoleKey: undefined, chapterId: 'fc' },
  users: { exists: true, role: 'firestore_role', displayRole: undefined, additionalRoles: undefined, isBanned: false, chapterId: 'fc' },
  loadedAt: 111,
};

// Counting fake Firestore for the seam-local permission-doc mirror loader.
let fsDocs: Map<string, Record<string, unknown>>;
let fsGetCount: number;
const fakeDb = {
  collection: (collection: string) => ({
    doc: (id: string) => ({
      get: async () => {
        fsGetCount++;
        const data = fsDocs.get(`${collection}/${id}`);
        return { exists: data !== undefined, data: () => data };
      },
    }),
  }),
};

// Mocked Supa transport (global fetch, as in identity-supa.test.ts).
let supaRows: Map<string, Record<string, unknown>>;
let fetchCount: number;
let fetchFails: boolean;
const realFetch = globalThis.fetch;

const savedEnv = {
  SUPA_SURFACES: process.env.SUPA_SURFACES,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

function supaKeyFromUrl(url: string): string {
  const u = new URL(url);
  const table = u.pathname.split('/').pop() as string;
  return `${table}/${(u.searchParams.get('id') ?? '').replace(/^eq\./, '')}`;
}

beforeEach(() => {
  resetIdentityCache();
  jest.clearAllMocks();
  fsDocs = new Map();
  fsGetCount = 0;
  getDbMock.mockReturnValue(fakeDb);
  cachedMock.mockResolvedValue(FIRESTORE_BUNDLE);

  supaRows = new Map();
  fetchCount = 0;
  fetchFails = false;
  globalThis.fetch = jest.fn(async (url: string) => {
    fetchCount++;
    if (fetchFails) throw new Error('supa down');
    const data = supaRows.get(supaKeyFromUrl(url));
    return { ok: true, status: 200, json: async () => (data === undefined ? [] : [{ data }]) };
  }) as unknown as typeof fetch;
  process.env.SUPABASE_URL = 'https://supa.example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  delete process.env.SUPA_SURFACES;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedEnv.SUPA_SURFACES === undefined) delete process.env.SUPA_SURFACES;
  else process.env.SUPA_SURFACES = savedEnv.SUPA_SURFACES;
  if (savedEnv.SUPABASE_URL === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = savedEnv.SUPABASE_URL;
  if (savedEnv.SUPABASE_SERVICE_ROLE_KEY === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = savedEnv.SUPABASE_SERVICE_ROLE_KEY;
});

function supaOn(): void {
  process.env.SUPA_SURFACES = 'identity';
}

describe('useSupaIdentity', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['users,tasks', false],
    ['identity', true],
    ['users, identity ,tasks', true],
    ['identityx', false],
  ])('SUPA_SURFACES=%p -> %p', (value, expected) => {
    if (value === undefined) delete process.env.SUPA_SURFACES;
    else process.env.SUPA_SURFACES = value;
    expect(useSupaIdentity()).toBe(expected);
  });
});

describe('getIdentityBundleViaBackend', () => {
  it('OFF -> existing Firestore cached accessor; zero Supa fetches', async () => {
    const bundle = await getIdentityBundleViaBackend('uid-off');
    expect(bundle).toBe(FIRESTORE_BUNDLE);
    expect(cachedMock).toHaveBeenCalledTimes(1);
    expect(cachedMock).toHaveBeenCalledWith(fakeDb, 'uid-off');
    expect(fetchCount).toBe(0);
  });

  it('ON -> Supa bundle; cold = 2 lookups, warm = 0 additional lookups', async () => {
    supaOn();
    supaRows.set('fs_roles/uid-on', { role: 'founder_patron', additionalRoles: ['president_national', 'chapter_president'], chapterId: 'seds-ist-chapter' });
    supaRows.set('fs_users/uid-on', { role: 'founder_patron', isBanned: false, chapterId: 'seds-ist-chapter' });

    const cold = await getIdentityBundleViaBackend('uid-on');
    expect(cold.roles?.role).toBe('founder_patron');
    expect(cold.roles?.additionalRoles).toEqual(['president_national', 'chapter_president']);
    expect(fetchCount).toBe(2);
    expect(cachedMock).not.toHaveBeenCalled();

    const warm = await getIdentityBundleViaBackend('uid-on');
    expect(warm).toBe(cold);
    expect(fetchCount).toBe(2); // warm adds ZERO lookups
  });

  it('ON + Supa throw -> Firestore fallback (outside the failed cache call)', async () => {
    supaOn();
    fetchFails = true;
    const bundle = await getIdentityBundleViaBackend('uid-fallback');
    expect(bundle).toBe(FIRESTORE_BUNDLE);
    expect(cachedMock).toHaveBeenCalledTimes(1);
    expect(cachedMock).toHaveBeenCalledWith(fakeDb, 'uid-fallback');
    // The throw was not cached in the Supa partition: a retry after
    // recovery re-runs the Supa loader instead of serving the failure.
    fetchFails = false;
    supaRows.set('fs_roles/uid-fallback', { role: 'recovered_role' });
    supaRows.set('fs_users/uid-fallback', { role: 'recovered_role' });
    const retried = await getIdentityBundleViaBackend('uid-fallback');
    expect(retried.roles?.role).toBe('recovered_role');
  });

  it('cache scope isolation: Supa partition and Firestore partition never alias', async () => {
    supaOn();
    supaRows.set('fs_roles/uid-iso', { role: 'supa_role' });
    supaRows.set('fs_users/uid-iso', { role: 'supa_role' });
    const supaBundle = await getIdentityBundleViaBackend('uid-iso');
    expect(supaBundle.roles?.role).toBe('supa_role');
    expect(fetchCount).toBe(2);

    // A Firestore-scope load for the same uid must MISS the Supa
    // partition and run its own loader.
    let fsLoads = 0;
    const fsBundle = await getIdentityBundle(
      'uid-iso',
      async () => {
        fsLoads++;
        return { ...FIRESTORE_BUNDLE, loadedAt: Date.now() };
      },
      { scope: fakeDb as unknown as object },
    );
    expect(fsLoads).toBe(1);
    expect(fsBundle.roles?.role).toBe('firestore_role');

    // And the Supa partition still serves its own entry (warm, 0 new).
    const supaWarm = await getIdentityBundleViaBackend('uid-iso');
    expect(supaWarm.roles?.role).toBe('supa_role');
    expect(fetchCount).toBe(2);
  });
});

describe('getPermissionDocViaBackend', () => {
  it('OFF -> Firestore mirror loader through the cache (present + absent)', async () => {
    fsDocs.set('roleDefinitions/admin', { permissions: ['canManageTasks'] });
    const present = await getPermissionDocViaBackend('roleDefinitions', 'admin');
    expect(present).toEqual({ exists: true, data: { permissions: ['canManageTasks'] } });
    expect(fsGetCount).toBe(1);
    const absent = await getPermissionDocViaBackend('permissions', 'nope');
    expect(absent.exists).toBe(false);
    expect(absent.data).toBeUndefined();
    expect(fetchCount).toBe(0);
  });

  it('ON -> Supa doc, 1 lookup cold / 0 warm; Firestore untouched', async () => {
    supaOn();
    supaRows.set('fs_permissions/member', { canPost: true });
    const entry = await getPermissionDocViaBackend('permissions', 'member');
    expect(entry).toEqual({ exists: true, data: { canPost: true } });
    expect(fetchCount).toBe(1);
    const warm = await getPermissionDocViaBackend('permissions', 'member');
    expect(warm).toEqual(entry);
    expect(fetchCount).toBe(1);
    expect(fsGetCount).toBe(0);
  });

  it('ON + Supa throw -> Firestore fallback loader', async () => {
    supaOn();
    fetchFails = true;
    fsDocs.set('permissions/member', { canPost: false });
    const entry = await getPermissionDocViaBackend('permissions', 'member');
    expect(entry).toEqual({ exists: true, data: { canPost: false } });
    expect(fsGetCount).toBe(1);
  });
});
