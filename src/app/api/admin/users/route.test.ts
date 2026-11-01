/**
 * @jest-environment node
 *
 * Heap-guard test for src/app/api/admin/users/route.ts (fix/heap-root-hunt):
 * the idle-browse search caches (Firestore arm + Supa arm) previously grew
 * without bound (plain .set, TTL checked on read but never evicting).
 * This test drives the Firestore arm through the GET handler: after more
 * distinct idle keys than MAX_SEARCH_CACHE_ENTRIES (200), the oldest key
 * must be evicted, so re-requesting it refetches instead of serving
 * `cached: true`.
 */
import { NextRequest } from 'next/server';

const mockUsersIdleGet = jest.fn();
const mockRolesWhereGet = jest.fn();

function doc(id: string, data: any) {
  return { id, data: () => data };
}

function chain(getFn: jest.Mock) {
  const c: any = {
    orderBy: () => c,
    where: () => c,
    select: () => c,
    limit: () => c,
    startAfter: () => c,
    get: getFn,
  };
  return c;
}

const mockDb: any = {
  collection: (name: string) => {
    if (name === 'users') return chain(mockUsersIdleGet);
    if (name === 'roles') return chain(mockRolesWhereGet);
    return chain(jest.fn().mockResolvedValue({ docs: [] }));
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDb,
}));
jest.mock('@/lib/auth-middleware', () => ({
  withAuth: (_req: any, handler: any) => handler({ userId: 'admin-1', role: 'superadmin' }),
}));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: async () => true,
  getIdentityBundleCached: async () => ({ users: { chapterId: null } }),
}));
jest.mock('@/lib/server/chapter-scoping', () => ({
  resolveEffectiveScope: async () => 'global',
  resolveChapterFilter: ({ requestedChapterId }: any) => ({
    ok: true,
    effectiveChapterId: requestedChapterId,
  }),
}));
jest.mock('@/lib/supa-seams/users-directory', () => ({
  getUsersSupaAdapter: () => null,
  supaGetRolesByIds: jest.fn(),
  supaGetUsersByIds: jest.fn(),
  supaListAllUsers: jest.fn(),
  supaListRolesWhereRole: jest.fn(),
  supaListUsersWhere: jest.fn(),
  supaListUsersByNameKeyword: jest.fn(),
}));
jest.mock('@/lib/server/user-contact', () => ({
  getUserContacts: async () => new Map(),
  stripContactFields: (d: any) => d,
}));

import { GET } from './route';

function idleRequest(chapterId: string) {
  return new NextRequest(`http://localhost/api/admin/users?chapterId=${chapterId}&pageSize=20`);
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe('admin users idle-search cache cap (Firestore arm)', () => {
  it('evicts the oldest key after 200 distinct idle keys', async () => {
    mockUsersIdleGet.mockResolvedValue({
      docs: [doc('u1', { displayName: 'Idle One', email: 'i@x.com', whatsapp: '1', role: null, chapterId: 'ch-0', isBanned: false })],
    });
    mockRolesWhereGet.mockResolvedValue({ docs: [] });

    const first = await (await GET(idleRequest('ch-0'))).json();
    expect(first.cached).toBeFalsy();
    const repeat = await (await GET(idleRequest('ch-0'))).json();
    expect(repeat.cached).toBe(true);

    for (let i = 1; i <= 200; i++) {
      await GET(idleRequest(`ch-${i}`));
    }

    // ch-0 was the oldest of 201 distinct keys with a 200-entry cap: evicted.
    const evicted = await (await GET(idleRequest('ch-0'))).json();
    expect(evicted.cached).toBeFalsy();
    // The most recently inserted key is still cached.
    const kept = await (await GET(idleRequest('ch-200'))).json();
    expect(kept.cached).toBe(true);
  });
});
