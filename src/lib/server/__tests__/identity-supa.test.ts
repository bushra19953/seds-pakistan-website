/**
 * @jest-environment node
 *
 * Supa identity loaders (identity-supa.ts): the fetchRowData seam is the
 * ONLY store access, exercised here through a mocked global fetch (the
 * transport fetchRowData uses). Zero live reads.
 *
 * Contract: IDENTITY_DEPENDENCY_MAP.md §1 + §6 — cold bundle = exactly 2
 * row lookups (fs_roles + fs_users by id, parallel); permission doc = 1
 * lookup; missing row -> exists:false object (never null); lookup
 * failure THROWS (never exists:false, §6.4d); expiresAt verbatim.
 */
import {
  loadIdentityBundleFromSupa,
  loadPermissionDocFromSupa,
  fetchRowData,
} from '../identity-supa';

const FOUNDER_UID = 'founder-uid-1';

type RowData = Record<string, unknown>;
let rowsByKey: Map<string, RowData>;
let fetchCalls: string[];
let fetchImpl: (url: string) => Promise<unknown>;

const realFetch = globalThis.fetch;
const savedEnv = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

function keyFromUrl(url: string): string {
  const u = new URL(url);
  const table = u.pathname.split('/').pop() as string;
  const idEq = u.searchParams.get('id') ?? '';
  return `${table}/${idEq.replace(/^eq\./, '')}`;
}

beforeEach(() => {
  rowsByKey = new Map();
  fetchCalls = [];
  fetchImpl = async (url: string) => {
    const data = rowsByKey.get(keyFromUrl(url));
    return {
      ok: true,
      status: 200,
      json: async () => (data === undefined ? [] : [{ data }]),
    };
  };
  globalThis.fetch = jest.fn(async (url: string) => {
    fetchCalls.push(url);
    return fetchImpl(url);
  }) as unknown as typeof fetch;
  process.env.SUPABASE_URL = 'https://supa.example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedEnv.SUPABASE_URL === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = savedEnv.SUPABASE_URL;
  if (savedEnv.SUPABASE_SERVICE_ROLE_KEY === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = savedEnv.SUPABASE_SERVICE_ROLE_KEY;
});

function setRow(table: string, id: string, data: RowData): void {
  rowsByKey.set(`${table}/${id}`, data);
}

describe('loadIdentityBundleFromSupa', () => {
  it('founder rows: exactly 2 lookups, fields projected exactly as the Firestore loader', async () => {
    const additionals = ['president_national', 'chapter_president'];
    setRow('fs_roles', FOUNDER_UID, {
      role: 'founder_patron',
      additionalRoles: additionals,
      expiresAt: { _seconds: 1893456000, _nanoseconds: 0 },
      expiresRoleKey: 'custom_grant',
      chapterId: 'seds-ist-chapter',
      ignoredField: 'must not appear',
    });
    setRow('fs_users', FOUNDER_UID, {
      role: 'member_basic',
      displayRole: 'Founder',
      additionalRoles: ['member'],
      isBanned: false,
      chapterId: 'seds-ist-chapter',
    });

    const bundle = await loadIdentityBundleFromSupa(FOUNDER_UID);

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls.some((u) => u.includes('/fs_roles?'))).toBe(true);
    expect(fetchCalls.some((u) => u.includes('/fs_users?'))).toBe(true);
    expect(fetchCalls.every((u) => u.includes(`id=eq.${FOUNDER_UID}`))).toBe(true);

    expect(bundle.roles).toEqual({
      exists: true,
      role: 'founder_patron',
      additionalRoles: ['president_national', 'chapter_president'],
      expiresAt: { _seconds: 1893456000, _nanoseconds: 0 },
      expiresRoleKey: 'custom_grant',
      chapterId: 'seds-ist-chapter',
    });
    // Sliced at the source, never the source array reference.
    expect(bundle.roles?.additionalRoles).not.toBe(additionals);
    expect(bundle.users).toEqual({
      exists: true,
      role: 'member_basic',
      displayRole: 'Founder',
      additionalRoles: ['member'],
      isBanned: false,
      chapterId: 'seds-ist-chapter',
    });
    expect(typeof bundle.loadedAt).toBe('number');
  });

  it('missing fs_roles row -> roles exists:false object (never null), users intact', async () => {
    setRow('fs_users', 'u2', { role: 'member_basic', isBanned: true, chapterId: 'c1' });
    const bundle = await loadIdentityBundleFromSupa('u2');
    expect(bundle.roles).not.toBeNull();
    expect(bundle.roles?.exists).toBe(false);
    expect(bundle.roles?.role).toBeUndefined();
    expect(bundle.roles?.expiresAt).toBeUndefined();
    expect(bundle.users?.exists).toBe(true);
    expect(bundle.users?.isBanned).toBe(true);
  });

  it('missing fs_users row -> users exists:false, isBanned false', async () => {
    setRow('fs_roles', 'u3', { role: 'chapter_president' });
    const bundle = await loadIdentityBundleFromSupa('u3');
    expect(bundle.users).not.toBeNull();
    expect(bundle.users?.exists).toBe(false);
    expect(bundle.users?.isBanned).toBe(false);
    expect(bundle.users?.role).toBeUndefined();
    expect(bundle.roles?.exists).toBe(true);
  });

  it('both rows missing -> both exists:false objects, isBanned false', async () => {
    const bundle = await loadIdentityBundleFromSupa('ghost');
    expect(bundle.roles?.exists).toBe(false);
    expect(bundle.users?.exists).toBe(false);
    expect(bundle.users?.isBanned).toBe(false);
  });

  it.each([
    [true, true],
    ['true', false],
    [1, false],
    ['yes', false],
    [false, false],
    [undefined, false],
  ])('isBanned coercion: jsonb %p -> %p (=== true only)', async (raw, expected) => {
    setRow('fs_users', 'u4', raw === undefined ? {} : { isBanned: raw });
    const bundle = await loadIdentityBundleFromSupa('u4');
    expect(bundle.users?.isBanned).toBe(expected);
  });

  it.each([
    ['dump object shape', { _seconds: 1893456000, _nanoseconds: 500 }],
    ['ISO string', '2030-01-01T00:00:00.000Z'],
    ['epoch millis', 1893456000000],
  ])('expiresAt passthrough verbatim: %s', async (_label, expiresAt) => {
    setRow('fs_roles', 'u5', { role: 'member', expiresAt, expiresRoleKey: 'custom_x' });
    const bundle = await loadIdentityBundleFromSupa('u5');
    expect(bundle.roles?.expiresAt).toEqual(expiresAt);
    expect(bundle.roles?.expiresAt).not.toBeInstanceOf(Date);
  });

  it('non-array additionalRoles is stored as-is', async () => {
    setRow('fs_roles', 'u6', { role: 'member', additionalRoles: 'not-an-array' });
    const bundle = await loadIdentityBundleFromSupa('u6');
    expect(bundle.roles?.additionalRoles).toBe('not-an-array');
  });
});

describe('loadPermissionDocFromSupa', () => {
  it.each(['roleDefinitions', 'permissions'] as const)(
    '%s: present row -> { exists:true, data: whole jsonb }, exactly 1 lookup',
    async (collection) => {
      const table = collection === 'roleDefinitions' ? 'fs_roleDefinitions' : 'fs_permissions';
      const data = { permissions: ['canManageTasks'], canManageTasks: true, _scope: 'global' };
      setRow(table, 'founder_patron', data);
      const entry = await loadPermissionDocFromSupa(collection, 'founder_patron');
      expect(entry).toEqual({ exists: true, data });
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]).toContain(`/${table}?`);
    },
  );

  it.each(['roleDefinitions', 'permissions'] as const)(
    '%s: absent row -> { exists:false, data:undefined }',
    async (collection) => {
      const entry = await loadPermissionDocFromSupa(collection, 'no_such_slug');
      expect(entry.exists).toBe(false);
      expect(entry.data).toBeUndefined();
      expect(fetchCalls).toHaveLength(1);
    },
  );
});

describe('failure semantics (§6.4d): failures throw, never exists:false', () => {
  it('network throw -> bundle loader throws', async () => {
    fetchImpl = async () => {
      throw new Error('network down');
    };
    await expect(loadIdentityBundleFromSupa('u7')).rejects.toThrow('network down');
  });

  it('HTTP 500 -> bundle and permission-doc loaders throw', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(loadIdentityBundleFromSupa('u8')).rejects.toThrow('HTTP 500');
    await expect(loadPermissionDocFromSupa('permissions', 'x')).rejects.toThrow('HTTP 500');
  });

  it('unconfigured env -> fetchRowData throws before any fetch', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await expect(fetchRowData('fs_roles', 'u9')).rejects.toThrow('not configured');
    await expect(loadIdentityBundleFromSupa('u9')).rejects.toThrow('not configured');
  });
});
