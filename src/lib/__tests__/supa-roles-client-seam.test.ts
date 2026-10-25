/**
 * Seam tests for src/lib/supa-roles-client-seam.ts (file-group 3).
 *
 * Covers: flag parsing (default OFF, list, wildcard, case), the
 * no-network guarantee while OFF, Firestore-shaped results when ON,
 * timestamp normalization (ISO string and serialized Admin Timestamp),
 * and the fallback contract — every failure mode returns null so the
 * caller runs its historical Firestore path.
 *
 * firebase/auth is mocked so the Bearer attempt never touches a real
 * auth instance; fetch is stubbed per test. Zero live reads.
 */

jest.mock('firebase/auth', () => ({
  getAuth: () => ({
    currentUser: {
      getIdToken: async () => 'test-token',
    },
  }),
}));

import {
  parseSupaClientSurfaces,
  rolesSupaEnabled,
  seamGetDoc,
  seamListDocs,
  seamQueryDocs,
  seamSetDoc,
  seamUpdateDoc,
  normalizeSeamData,
} from '../supa-roles-client-seam';

const ENV_KEY = 'NEXT_PUBLIC_SUPA_SURFACES';
let savedEnv: string | undefined;
let fetchMock: jest.Mock;

function fetchResponding(status: number, payload: unknown): jest.Mock {
  return jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }));
}

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  fetchMock = jest.fn();
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  jest.clearAllMocks();
});

describe('flag parsing', () => {
  it('is OFF when unset or empty (the default)', () => {
    expect(rolesSupaEnabled()).toBe(false);
    process.env[ENV_KEY] = '';
    expect(rolesSupaEnabled()).toBe(false);
    process.env[ENV_KEY] = '  , ,';
    expect(rolesSupaEnabled()).toBe(false);
  });

  it('is ON for the roles surface, case-insensitively', () => {
    process.env[ENV_KEY] = 'announcements, Roles ';
    expect(rolesSupaEnabled()).toBe(true);
    expect(rolesSupaEnabled('ROLES')).toBe(true);
  });

  it('is OFF for other surfaces only', () => {
    expect(rolesSupaEnabled('announcements,directory')).toBe(false);
  });

  it('wildcard enables every surface', () => {
    expect(rolesSupaEnabled('*')).toBe(true);
    expect(parseSupaClientSurfaces(' a ,B ').has('b')).toBe(true);
  });
});

describe('flag OFF: no network, null results', () => {
  it('seamGetDoc returns null without calling fetch', async () => {
    await expect(seamGetDoc('roleDefinitions', 'member')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('list/query/set/update all return null without fetch', async () => {
    await expect(seamListDocs('roleDefinitions')).resolves.toBeNull();
    await expect(seamQueryDocs('roles', 'role', 'member')).resolves.toBeNull();
    await expect(seamSetDoc('role_requests', null, {})).resolves.toBeNull();
    await expect(seamUpdateDoc('role_requests', 'x', {})).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('flag ON', () => {
  beforeEach(() => {
    process.env[ENV_KEY] = 'roles';
  });

  it('seamGetDoc returns the Firestore-shaped doc and sends a Bearer token', async () => {
    (globalThis as { fetch?: unknown }).fetch = fetchResponding(200, {
      doc: {
        id: 'member',
        exists: true,
        data: { slug: 'member', permissions: ['canAccessAdmin'] },
      },
    });
    const doc = await seamGetDoc('roleDefinitions', 'member');
    expect(doc).toEqual({
      id: 'member',
      exists: true,
      data: { slug: 'member', permissions: ['canAccessAdmin'] },
    });
    const call = ((globalThis.fetch as unknown) as jest.Mock).mock.calls[0];
    expect(call[0]).toContain('/api/roles/reads?');
    expect(call[0]).toContain('collection=roleDefinitions');
    expect(call[1].headers.Authorization).toBe('Bearer test-token');
  });

  it('a missing doc is exists:false (authoritative), NOT a fallback null', async () => {
    (globalThis as { fetch?: unknown }).fetch = fetchResponding(200, {
      doc: { id: 'nope', exists: false, data: null },
    });
    await expect(seamGetDoc('role_permissions', 'nope')).resolves.toEqual({
      id: 'nope',
      exists: false,
      data: null,
    });
  });

  it('seamListDocs maps an array of docs', async () => {
    (globalThis as { fetch?: unknown }).fetch = fetchResponding(200, {
      docs: [
        { id: 'a', exists: true, data: { slug: 'a' } },
        { id: 'b', exists: true, data: { slug: 'b' } },
      ],
    });
    const docs = await seamListDocs('roleDefinitions');
    expect(docs?.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('seamQueryDocs passes field/value/order params', async () => {
    (globalThis as { fetch?: unknown }).fetch = fetchResponding(200, { docs: [] });
    await seamQueryDocs('role_requests', 'status', 'pending', 'createdAt');
    const url = ((globalThis.fetch as unknown) as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('field=status');
    expect(url).toContain('value=pending');
    expect(url).toContain('orderByDesc=createdAt');
  });

  it('seamSetDoc returns the minted id; seamUpdateDoc returns true', async () => {
    (globalThis as { fetch?: unknown }).fetch = fetchResponding(200, { ok: true, id: 'req-1' });
    await expect(
      seamSetDoc('role_requests', null, { requesterUid: 'u1' }),
    ).resolves.toEqual({ id: 'req-1' });
    await expect(
      seamUpdateDoc('role_requests', 'req-1', { status: 'approved' }),
    ).resolves.toBe(true);
  });
});

describe('fallback contract: any failure returns null', () => {
  beforeEach(() => {
    process.env[ENV_KEY] = 'roles';
  });

  it('non-2xx -> null', async () => {
    (globalThis as { fetch?: unknown }).fetch = fetchResponding(500, { error: 'x' });
    await expect(seamGetDoc('roles', 'u1')).resolves.toBeNull();
  });

  it('fetch throws -> null', async () => {
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => {
      throw new Error('network down');
    });
    await expect(seamListDocs('roleDefinitions')).resolves.toBeNull();
  });

  it('malformed payload -> null', async () => {
    (globalThis as { fetch?: unknown }).fetch = fetchResponding(200, { doc: { nope: 1 } });
    await expect(seamGetDoc('roles', 'u1')).resolves.toBeNull();
    (globalThis as { fetch?: unknown }).fetch = fetchResponding(200, { docs: 'nope' });
    await expect(seamListDocs('roleDefinitions')).resolves.toBeNull();
  });
});

describe('timestamp normalization', () => {
  it('ISO strings become Timestamp shims with a working toDate()', () => {
    const out = normalizeSeamData({ createdAt: '2026-10-25T00:00:00.000Z', name: 'x' });
    const ts = out?.createdAt as { toDate: () => Date };
    expect(ts.toDate().toISOString()).toBe('2026-10-25T00:00:00.000Z');
    expect(out?.name).toBe('x');
  });

  it('serialized Admin Timestamps ({_seconds,_nanoseconds}) become shims', () => {
    const out = normalizeSeamData({
      handledAt: { _seconds: 1761436800, _nanoseconds: 500000000 },
    });
    const ts = out?.handledAt as { toDate: () => Date };
    expect(ts.toDate().getTime()).toBe(1761436800500);
  });

  it('non-timestamp values are left untouched', () => {
    const out = normalizeSeamData({ createdAt: 'not-a-date', updatedAt: null });
    expect(out?.createdAt).toBe('not-a-date');
    expect(out?.updatedAt).toBeNull();
  });
});
