/**
 * @jest-environment node
 *
 * RBT2 (directory) pins:
 *  - Item 1: Supa Path A merges contacts (and the roles overlay)
 *    AFTER slicing the pageSize*3 window to the page — an idle load
 *    with pageSize 20 pays contact reads for 20 rows, not 60.
 *  - Item 2: the Supa Path A arm has the same 30s cache treatment as
 *    the flag-OFF Firestore arm (same keying: a different pageSize
 *    misses; same conditions: startAfter pages are neither served
 *    from nor written to the cache), in its own map.
 * All adapter and Firestore access is mocked; no live reads.
 */

import { NextRequest } from 'next/server';

type Row = { id: string; data: Record<string, any> };

const IST = 'seds-ist-chapter';

const supaUserRows: Row[] = [
  ...Array.from({ length: 75 }, (_, i) => {
    const n = String(i + 1).padStart(3, '0');
    return {
      id: `a${n}`,
      data: { displayName: `Person ${n}`, role: 'member', chapterId: IST },
    };
  }),
  { id: 'admin-global', data: { displayName: 'Global Admin', role: 'superadmin' } },
];

const supaRoleRows: Row[] = [];

const counters = {
  listDocsCalls: [] as string[],
  contactCalls: [] as string[][],
};

function applyWhere(rows: Row[], where: any[] | undefined): Row[] {
  if (!where) return rows;
  return rows.filter((r) =>
    where.every(([field, op, value]: any[]) => {
      if ((field === '__name__' || field === 'id') && op === 'in') return (value as string[]).includes(r.id);
      if (op === '==') return r.data[field] === value;
      return true;
    }),
  );
}

const mockAdapter = {
  getDoc: async () => null,
  listDocs: async (collection: string, options: any) => {
    counters.listDocsCalls.push(collection);
    const rows = collection === 'users' ? supaUserRows : supaRoleRows;
    const matched = applyWhere(rows, options?.where);
    return matched.map((r) => ({ id: r.id, ...r.data }));
  },
  countDocs: async () => 0,
  setDoc: async () => ({}),
  updateDoc: async () => ({}),
  deleteDoc: async () => undefined,
};

import {
  setUsersSupaAdapterForTests,
  resetUsersSupaAdapterForTests,
} from '@/lib/supa-seams/users-directory';

const mockDb = {
  collection: (name: string) => {
    const chain: any = {
      where: () => chain,
      orderBy: () => chain,
      startAfter: () => chain,
      limit: () => chain,
      select: () => chain,
      get: async () => ({ docs: [], size: 0, empty: true }),
    };
    if (name === 'users' || name === 'roles') return chain;
    throw new Error(`unexpected collection: ${name}`);
  },
};

const state = {
  authContext: { userId: 'admin-global', role: 'superadmin' } as any,
  canManage: true,
};

// The seam's gate is mocked at '@/lib/supa' (env-driven useSupa, like
// the real flags module) because @supabase/supabase-js is not installed
// in this tree's node_modules — the real client module cannot load
// under jest here (the pre-existing flag-on suites fail the same way).
// The seam code itself, and its test-adapter injection point, run real.
jest.mock('@/lib/supa', () => ({
  useSupa: (surface: string) =>
    (process.env.SUPA_SURFACES || '').split(',').map((s) => s.trim()).includes(surface),
  getSupaClient: () => ({}),
  getSupaAdapter: () => {
    throw new Error('tests must inject via setUsersSupaAdapterForTests');
  },
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
  ensureAdminInitialized: jest.fn(() => true),
}));

jest.mock('@/lib/auth-middleware', () => ({
  withAuth: jest.fn(async (_req: any, handler: any) => handler(state.authContext)),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async () => state.canManage),
  hasServerPermissionForUser: jest.fn(async () => state.canManage),
  getIdentityBundleCached: jest.fn(async (_db: any, uid: string) => {
    const r = supaUserRows.find((u) => u.id === uid);
    return {
      roles: null,
      users: r
        ? { exists: true, role: r.data.role, chapterId: r.data.chapterId, isBanned: false }
        : { exists: false, role: undefined, chapterId: undefined, isBanned: false },
      loadedAt: Date.now(),
    };
  }),
}));

jest.mock('@/lib/server/user-contact', () => {
  const shared = jest.requireActual('@/lib/user-contact-shared');
  return {
    ...shared,
    getUserContacts: async (_db: any, uids: string[]) => {
      counters.contactCalls.push([...uids]);
      const map = new Map<string, any>();
      uids.forEach((uid, i) => {
        map.set(uid, { email: `${uid}@example.com`, whatsapp: `0300000${String(i).padStart(4, '0')}` });
      });
      return map;
    },
  };
});

jest.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    getUserByEmail: async () => {
      throw new Error('not used in Path A');
    },
  }),
}));

import { GET } from '@/app/api/admin/users/route';

async function getJson(qs = '') {
  const res = await GET(new NextRequest(`http://localhost/api/admin/users${qs}`));
  return { res, body: await res.json() };
}

beforeEach(() => {
  process.env.SUPA_SURFACES = 'users';
  setUsersSupaAdapterForTests(mockAdapter as any);
});

afterAll(() => {
  delete process.env.SUPA_SURFACES;
  resetUsersSupaAdapterForTests();
});

describe('RBT2 Supa Path A: contacts after slice + 30s Supa cache', () => {
  it('contacts merge runs for the 20-row page, not the 60-row window; a repeat idle call is cached; pageSize keys the cache; startAfter bypasses it', async () => {
    // Item 1: first idle load, pageSize 20 over a 76-row directory.
    const first = await getJson('?pageSize=20');
    expect(first.res.status).toBe(200);
    expect(first.body.searchMethod).toBe('supabase');
    expect(first.body.cached).toBeUndefined();
    expect(first.body.users).toHaveLength(20);
    expect(first.body.users.map((u: any) => u.uid)).toEqual(
      supaUserRows.slice(0, 20).map((r) => r.id),
    );
    // Exactly one contact merge, for exactly the page's 20 ids —
    // before the fix this was one merge for the 60-id window.
    expect(counters.contactCalls).toHaveLength(1);
    expect(counters.contactCalls[0]).toEqual(supaUserRows.slice(0, 20).map((r) => r.id));
    // Rows still carry their merged contact fields (shape unchanged).
    expect(first.body.users[0].email).toBe('a001@example.com');
    expect(first.body.users[0].whatsapp).toBeTruthy();
    const listCallsAfterFirst = counters.listDocsCalls.length;

    // Item 2: second identical idle call inside 30s is served from
    // the Supa cache — no new adapter reads, no new contact merge.
    const second = await getJson('?pageSize=20');
    expect(second.body.cached).toBe(true);
    expect(second.body.searchMethod).toBe('supabase');
    expect(second.body.users).toEqual(first.body.users);
    expect(second.body.nextCursor).toBe(first.body.nextCursor);
    expect(counters.listDocsCalls.length).toBe(listCallsAfterFirst);
    expect(counters.contactCalls).toHaveLength(1);

    // Same keying as the Firestore arm: pageSize is part of the key,
    // so a different pageSize misses and rebuilds (for its own page).
    const otherSize = await getJson('?pageSize=10');
    expect(otherSize.body.cached).toBeUndefined();
    expect(otherSize.body.users).toHaveLength(10);
    expect(counters.contactCalls).toHaveLength(2);
    expect(counters.contactCalls[1]).toHaveLength(10);

    // Same conditions as the Firestore arm: a startAfter page is
    // never served from the cache and never stored into it, so the
    // identical cursor call rebuilds again.
    const cursor1 = await getJson('?pageSize=20&startAfter=a020');
    expect(cursor1.body.cached).toBeUndefined();
    expect(cursor1.body.users[0].uid).toBe('a021');
    const contactCallsAfterCursor1 = counters.contactCalls.length;
    const cursor2 = await getJson('?pageSize=20&startAfter=a020');
    expect(cursor2.body.cached).toBeUndefined();
    expect(counters.contactCalls.length).toBe(contactCallsAfterCursor1 + 1);
  });
});
