/**
 * @jest-environment node
 *
 * Directory zero-records fix, REQ 5 (request gauntlet) - the
 * requirement's stated minimum. The route's pre-arm reads
 * (hasServerPermissionForUser, getIdentityBundleCached) run before
 * any serving arm; when one throws, the request must fail LOUD: a
 * 500 carrying an error body - distinguishable from a 200-with-[]
 * answer by the client, which renders its LOAD-FAILED state for it
 * (REQ 1) instead of the empty directory.
 *
 * Why not stale-serve the bundle instead (the requirement's first
 * clause)? Attempted and reverted in this fix line: the identity
 * loader's failure semantics are pinned DO-NOT-CHANGE by
 * identity-supa-parity.test.ts and identity-cache-integration.test.ts
 * ("RESOURCE_EXHAUSTED on the bundle load: side A THROWS (never
 * returns a stale/partial bundle)"). Serving a stale identity half
 * past a failed load would also serve stale role/ban state on the
 * auth path. The pins win; this suite pins the loud minimum here.
 */

import { NextRequest } from 'next/server';

type Row = { id: string; data: Record<string, any> };

const IST = 'seds-ist-chapter';

const state = {
  authContext: { userId: 'x-admin', role: 'superadmin' } as any,
  gauntletThrow: null as null | 'bundle' | 'permission',
};

const userRows: Row[] = [
  { id: 'x-admin', data: { displayName: 'Directory Admin', email: 'admin@example.com', whatsapp: '', role: 'superadmin', chapterId: IST } },
  { id: 'u-shomail', data: { displayName: 'Shomail Khan', email: 'shomailkhan3@gmail.com', whatsapp: '', role: 'chapter_secretary', chapterId: IST } },
];

const roleRows: Row[] = [
  { id: 'u-shomail', data: { role: 'chapter_secretary' } },
];

type ChainState = {
  filters: Array<(r: Row) => boolean>;
  selected: string[] | null;
  ordered: boolean;
  limitN: number | null;
  afterId: string | null;
};

function rowFilter(field: string, op: string, value: any) {
  if (field === '__name__' && op === 'in') return (r: Row) => (value as string[]).includes(r.id);
  if (field === '__name__' && op === '==') return (r: Row) => r.id === value;
  if (op === '==') return (r: Row) => r.data[field] === value;
  return () => true;
}

function project(data: Record<string, any>, selected: string[] | null) {
  if (!selected) return { ...data };
  const out: Record<string, any> = {};
  for (const field of selected) {
    if (Object.prototype.hasOwnProperty.call(data, field)) out[field] = data[field];
  }
  return out;
}

function makeChain(rows: Row[], s: ChainState): any {
  return {
    where: (f: string, op: string, v: any) =>
      makeChain(rows, { ...s, filters: [...s.filters, rowFilter(f, op, v)] }),
    orderBy: () => makeChain(rows, { ...s, ordered: true }),
    startAfter: (v: string) => makeChain(rows, { ...s, afterId: v }),
    limit: (n: number) => makeChain(rows, { ...s, limitN: n }),
    select: (...fields: string[]) => makeChain(rows, { ...s, selected: fields }),
    get: async () => {
      let matched = rows.filter((r) => s.filters.every((fn) => fn(r)));
      if (s.ordered) matched = [...matched].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (s.afterId) matched = matched.filter((r) => r.id > (s.afterId as string));
      if (s.limitN != null) matched = matched.slice(0, s.limitN);
      return {
        docs: matched.map((r) => ({ id: r.id, data: () => project(r.data, s.selected) })),
        size: matched.length,
        empty: matched.length === 0,
      };
    },
  };
}

const fresh = (): ChainState => ({ filters: [], selected: null, ordered: false, limitN: null, afterId: null });

const mockDb = {
  collection: (name: string) => {
    if (name === 'users') {
      return {
        ...makeChain(userRows, fresh()),
        doc: (id: string) => ({
          get: async () => {
            const r = userRows.find((u) => u.id === id);
            return { exists: !!r, id, data: () => (r ? { ...r.data } : undefined) };
          },
        }),
      };
    }
    if (name === 'roles') return makeChain(roleRows, fresh());
    if (name === 'permissions') {
      return { doc: (_id: string) => ({ get: async () => ({ exists: false, data: () => undefined }) }) };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
  ensureAdminInitialized: jest.fn(() => true),
}));

jest.mock('@/lib/auth-middleware', () => ({
  withAuth: jest.fn(async (_req: any, handler: any) => handler(state.authContext)),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async () => true),
  hasServerPermissionForUser: jest.fn(async () => {
    if (state.gauntletThrow === 'permission') {
      const err: any = new Error('14 UNAVAILABLE: transient backend failure');
      err.code = 14;
      throw err;
    }
    return true;
  }),
  getIdentityBundleCached: jest.fn(async (_db: any, uid: string) => {
    if (state.gauntletThrow === 'bundle') {
      const err: any = new Error('8 RESOURCE_EXHAUSTED: Quota exceeded.');
      err.code = 8;
      throw err;
    }
    const r = userRows.find((u) => u.id === uid);
    return {
      roles: null,
      users: r
        ? { exists: true, role: r.data.role, additionalRoles: r.data.additionalRoles, isBanned: false, chapterId: r.data.chapterId }
        : { exists: false, role: undefined, additionalRoles: undefined, isBanned: false, chapterId: undefined },
      loadedAt: Date.now(),
    };
  }),
}));

jest.mock('@/lib/supa-seams/users-directory', () => ({
  getUsersSupaAdapter: jest.fn(() => null),
  supaGetRolesByIds: jest.fn(async () => []),
  supaGetUsersByIds: jest.fn(async () => []),
  supaListAllUsers: jest.fn(async () => []),
  supaListRolesWhereRole: jest.fn(async () => []),
  supaListUsersWhere: jest.fn(async () => []),
  supaListUsersByNameKeyword: jest.fn(async () => []),
}));

jest.mock('@/lib/server/user-contact', () => {
  const shared = jest.requireActual('@/lib/user-contact-shared');
  return {
    ...shared,
    getUserContacts: async (_db: any, uids: string[]) => {
      const map = new Map<string, any>();
      for (const r of userRows) {
        if (!uids.includes(r.id)) continue;
        const contact = shared.pickContactFields(r.data);
        if (Object.keys(contact).length > 0) map.set(r.id, contact);
      }
      return map;
    },
  };
});

jest.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    getUserByEmail: async () => {
      const err: any = new Error('There is no user record corresponding to the provided identifier.');
      err.code = 'auth/user-not-found';
      throw err;
    },
  }),
}));

import { GET } from '@/app/api/admin/users/route';

async function getJson(qs = '') {
  const res = await GET(new NextRequest(`http://localhost/api/admin/users${qs}`));
  return { res, body: await res.json() };
}

beforeEach(() => {
  state.authContext = { userId: 'x-admin', role: 'superadmin' };
  state.gauntletThrow = null;
  jest.clearAllMocks();
});

describe('REQ 5: gauntlet failures are loud and distinguishable, never a silent empty', () => {
  it('identity bundle load throws: the route answers 500 with an error body, not a 200 empty list', async () => {
    state.gauntletThrow = 'bundle';
    const { res, body } = await getJson('?pageSize=22');
    expect(res.status).toBe(500);
    expect(body.error).toBeTruthy();
    expect(body.users).toBeUndefined();
  });

  it('permission check throws: the route answers 500 with an error body, not a 200 empty list', async () => {
    state.gauntletThrow = 'permission';
    const { res, body } = await getJson('?pageSize=23');
    expect(res.status).toBe(500);
    expect(body.error).toBeTruthy();
    expect(body.users).toBeUndefined();
  });

  it('gauntlet healthy (control): the same request shape serves 200 with rows', async () => {
    const { res, body } = await getJson('?pageSize=24');
    expect(res.status).toBe(200);
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.users.length).toBeGreaterThan(0);
  });
});
