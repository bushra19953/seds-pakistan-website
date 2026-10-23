/**
 * @jest-environment node
 *
 * Tests for GET /api/admin/users (Item 5, spec 5(f) suite 2): caller
 * chapter scoping in BOTH paths (Path A native query, Path B RAM
 * directory), the foreign-chapter 403, 'All' handling, the
 * no-chapter sentinel, cache isolation between scopes (T8), and the
 * gate running before any directory build (T7).
 *
 * Fixtures are shared across the file on purpose: the route's RAM
 * directory and 30s Path A cache are module-level, exactly as in
 * production.
 */

import { NextRequest } from 'next/server';

type Row = { id: string; data: Record<string, any> };

const IST = 'seds-ist-chapter';
const OTHER = 'seds-other-chapter';

const state = {
  authContext: { userId: 'admin-global', role: 'superadmin' } as any,
  canManage: true,
  queryGets: 0,
  docGets: 0,
};

const userRows: Row[] = [
  { id: 'ist-1', data: { displayName: 'Ayesha Khan', email: 'ayesha@example.com', whatsapp: '03001111111', role: 'member', chapterId: IST } },
  { id: 'ist-2', data: { displayName: 'Bilal Ahmed', email: 'bilal@example.com', whatsapp: '03002222222', role: 'member', chapterId: IST } },
  { id: 'oth-1', data: { displayName: 'Zara Sheikh', email: 'zara@example.com', whatsapp: '03009999999', role: 'member', chapterId: OTHER } },
  { id: 'admin-global', data: { displayName: 'Global Admin', email: 'g@example.com', whatsapp: '', role: 'superadmin' } },
  { id: 'admin-ch', data: { displayName: 'Chapter Admin', email: 'c@example.com', whatsapp: '', role: 'chapter_lead', chapterId: IST } },
  { id: 'admin-noch', data: { displayName: 'Nochapter Admin', email: 'n@example.com', whatsapp: '', role: 'member' } },
];

const roleRows: Row[] = [
  { id: 'ist-1', data: { role: 'member' } },
  { id: 'ist-2', data: { role: 'member' } },
  { id: 'oth-1', data: { role: 'member' } },
];

function rowFilter(field: string, op: string, value: any) {
  if (field === '__name__' && op === 'in') return (r: Row) => (value as string[]).includes(r.id);
  if (op === '==') return (r: Row) => r.data[field] === value;
  return () => true;
}

function makeChain(rows: Row[], filters: Array<(r: Row) => boolean> = []): any {
  const chain: any = {
    where: (f: string, op: string, v: any) => makeChain(rows, [...filters, rowFilter(f, op, v)]),
    orderBy: () => chain,
    startAfter: () => chain,
    limit: () => chain,
    select: () => chain,
    get: async () => {
      state.queryGets++;
      const matched = rows.filter((r) => filters.every((fn) => fn(r)));
      return {
        docs: matched.map((r) => ({ id: r.id, data: () => ({ ...r.data }) })),
        size: matched.length,
        empty: matched.length === 0,
      };
    },
  };
  return chain;
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'users') {
      return {
        ...makeChain(userRows),
        doc: (id: string) => ({
          get: async () => {
            state.docGets++;
            const r = userRows.find((u) => u.id === id);
            return { exists: !!r, id, data: () => (r ? { ...r.data } : undefined) };
          },
        }),
      };
    }
    if (name === 'roles') return makeChain(roleRows);
    if (name === 'permissions') {
      return {
        doc: (_id: string) => ({
          get: async () => ({ exists: false, data: () => undefined }),
        }),
      };
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
  hasServerPermission: jest.fn(async () => state.canManage),
  hasServerPermissionForUser: jest.fn(async () => state.canManage),
}));

import { GET } from '@/app/api/admin/users/route';

function asCaller(userId: string, role: string) {
  state.authContext = { userId, role };
}

function req(qs = '') {
  return new NextRequest(`http://localhost/api/admin/users${qs}`);
}

async function getJson(qs = '') {
  const res = await GET(req(qs));
  return { res, body: await res.json() };
}

beforeEach(() => {
  state.authContext = { userId: 'admin-global', role: 'superadmin' };
  state.canManage = true;
  state.queryGets = 0;
  state.docGets = 0;
  jest.clearAllMocks();
});

describe('GET /api/admin/users caller scoping (Item 5)', () => {
  it("1. chapter admin, no param (Path A): only own-chapter rows; no foreign WhatsApp anywhere in the payload", async () => {
    asCaller('admin-ch', 'chapter_lead');
    const { res, body } = await getJson();
    expect(res.status).toBe(200);
    const ids = body.users.map((u: any) => u.uid);
    expect(ids).toContain('ist-1');
    expect(ids).toContain('ist-2');
    expect(ids).not.toContain('oth-1');
    expect(JSON.stringify(body)).not.toContain('03009999999');
  });

  it('2. chapter admin, chapterId = foreign chapter: 403, and the cache is not poisoned for a later global caller', async () => {
    asCaller('admin-ch', 'chapter_lead');
    const { res } = await getJson(`?chapterId=${OTHER}`);
    expect(res.status).toBe(403);

    asCaller('admin-global', 'superadmin');
    const after = await getJson(`?chapterId=${OTHER}`);
    expect(after.res.status).toBe(200);
    expect(after.body.users.map((u: any) => u.uid)).toContain('oth-1');
  });

  it("3. chapter admin, chapterId = 'All': own chapter only (T5)", async () => {
    asCaller('admin-ch', 'chapter_lead');
    const { body } = await getJson('?chapterId=All');
    const ids = body.users.map((u: any) => u.uid);
    expect(ids).toContain('ist-1');
    expect(ids).not.toContain('oth-1');
  });

  it('4. chapter admin, chapterId = own chapter: own chapter only', async () => {
    asCaller('admin-ch', 'chapter_lead');
    const { body } = await getJson(`?chapterId=${IST}`);
    const ids = body.users.map((u: any) => u.uid);
    expect(ids).toContain('ist-2');
    expect(ids).not.toContain('oth-1');
  });

  it('5. chapter admin search (Path B) for a foreign member by exact name: zero results, totalScored counts only own scope', async () => {
    asCaller('admin-ch', 'chapter_lead');
    const { res, body } = await getJson('?q=zara');
    expect(res.status).toBe(200);
    expect(body.users).toHaveLength(0);
    expect(body.debug.totalScored).toBe(0);
  });

  it('6. chapter admin role-filtered search (Path B via role, no q): own chapter only', async () => {
    asCaller('admin-ch', 'chapter_lead');
    const { body } = await getJson('?role=member');
    const ids = body.users.map((u: any) => u.uid);
    expect(ids.sort()).toEqual(['ist-1', 'ist-2']);
  });

  it('7. global admin: no param returns both chapters; chapterId=X returns chapter X only', async () => {
    asCaller('admin-global', 'superadmin');
    const all = await getJson();
    const allIds = all.body.users.map((u: any) => u.uid);
    expect(allIds).toContain('ist-1');
    expect(allIds).toContain('ist-2');
    expect(allIds).toContain('oth-1');

    const filtered = await getJson(`?chapterId=${OTHER}`);
    const filteredIds = filtered.body.users.map((u: any) => u.uid);
    expect(filteredIds).toContain('oth-1');
    expect(filteredIds).not.toContain('ist-1');
  });

  it('8. chapter admin with no own chapterId: 200 with users: [] in both paths (T6)', async () => {
    asCaller('admin-noch', 'member');
    const pathA = await getJson();
    expect(pathA.res.status).toBe(200);
    expect(pathA.body.users).toHaveLength(0);

    const pathB = await getJson('?q=ayesha');
    expect(pathB.res.status).toBe(200);
    expect(pathB.body.users).toHaveLength(0);
  });

  it('9. cache isolation (T8): a primed cache never crosses scopes, in either order', async () => {
    // Global primes the default-params cache entry.
    asCaller('admin-global', 'superadmin');
    const primed = await getJson();
    expect(primed.body.users.map((u: any) => u.uid)).toContain('oth-1');

    // Chapter caller with identical client parameters gets their scoped page.
    asCaller('admin-ch', 'chapter_lead');
    const chapterView = await getJson();
    expect(chapterView.body.users.map((u: any) => u.uid)).not.toContain('oth-1');
    expect(JSON.stringify(chapterView.body)).not.toContain('03009999999');

    // Reverse order with a fresh parameter set: chapter primes, global must not receive the chapter page.
    const chapterPrimed = await getJson('?pageSize=7');
    expect(chapterPrimed.body.users.map((u: any) => u.uid)).not.toContain('oth-1');
    asCaller('admin-global', 'superadmin');
    const globalAfter = await getJson('?pageSize=7');
    expect(globalAfter.body.users.map((u: any) => u.uid)).toContain('oth-1');
  });

  it('10. no canManageUsers: 403 and neither the directory nor any query runs (T7)', async () => {
    state.canManage = false;
    asCaller('admin-ch', 'chapter_lead');
    const { res } = await getJson('?q=ayesha');
    expect(res.status).toBe(403);
    expect(state.queryGets).toBe(0);
  });
});
