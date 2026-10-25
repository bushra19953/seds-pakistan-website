/**
 * @jest-environment node
 *
 * Contract tests for the ROLE-FILTER half of the directory search
 * defect (DIRECTORY_SEARCH_DEFECT_2026-10-25.md): Path B used to
 * resolve role filters inside a candidate window of the first
 * pageSize*3 user docs by document id, so any holder whose doc id
 * sorted past the window was silently invisible.
 *
 * The fake Firestore in this file HONOURS orderBy('__name__') and
 * limit() (the older route.test.ts fake ignores both), so the window
 * is real here: with 77 user docs and the default pageSize of 20,
 * the old window covered exactly f001..f060.
 *
 * Fixtures (doc-id order):
 *   f001..f074  fillers, role 'member_basic' in the users doc mirror
 *   pLW0...Mz1  the founder: users.role 'member_basic' (stale mirror),
 *               roles doc role 'founder_patron' with additionalRoles
 *               ['president_national', 'chapter_president']
 *   x-admin     the caller (superadmin)
 *   z-holder    users.role 'member_basic' (stale mirror), roles doc
 *               role 'chapter_vice_president'  -> roles-store holder
 *   z-mirror    users.role 'chapter_vice_president', NO roles doc
 *               -> mirror-only holder
 */

import { NextRequest } from 'next/server';

type Row = { id: string; data: Record<string, any> };

const FOUNDER_UID = 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';
const IST = 'seds-ist-chapter';

const state = {
  authContext: { userId: 'x-admin', role: 'superadmin' } as any,
  canManage: true,
  queryGets: 0,
};

const userRows: Row[] = [];
for (let i = 1; i <= 74; i++) {
  const n = String(i).padStart(3, '0');
  userRows.push({
    id: `f${n}`,
    data: {
      displayName: `Filler ${n}`,
      email: `filler${n}@example.com`,
      whatsapp: '',
      role: 'member_basic',
      chapterId: IST,
    },
  });
}
userRows.push(
  { id: FOUNDER_UID, data: { displayName: 'Founder Person', email: 'founder@example.com', whatsapp: '', role: 'member_basic', chapterId: IST } },
  { id: 'x-admin', data: { displayName: 'Directory Admin', email: 'admin@example.com', whatsapp: '', role: 'superadmin', chapterId: IST } },
  { id: 'z-holder', data: { displayName: 'Vera Holder', email: 'vera@example.com', whatsapp: '', role: 'member_basic', chapterId: IST } },
  { id: 'z-mirror', data: { displayName: 'Mira Mirror', email: 'mira@example.com', whatsapp: '', role: 'chapter_vice_president', chapterId: IST } },
);

const roleRows: Row[] = [
  { id: FOUNDER_UID, data: { role: 'founder_patron', additionalRoles: ['president_national', 'chapter_president'] } },
  { id: 'z-holder', data: { role: 'chapter_vice_president' } },
];

// --- Fake Firestore that honours ordering + limit -------------------

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
  const chain: any = {
    where: (f: string, op: string, v: any) =>
      makeChain(rows, { ...s, filters: [...s.filters, rowFilter(f, op, v)] }),
    orderBy: () => makeChain(rows, { ...s, ordered: true }),
    startAfter: (v: string) => makeChain(rows, { ...s, afterId: v }),
    limit: (n: number) => makeChain(rows, { ...s, limitN: n }),
    select: (...fields: string[]) => makeChain(rows, { ...s, selected: fields }),
    get: async () => {
      state.queryGets++;
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
  return chain;
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
  hasServerPermission: jest.fn(async () => state.canManage),
  hasServerPermissionForUser: jest.fn(async () => state.canManage),
  getIdentityBundleCached: jest.fn(async (_db: any, uid: string) => {
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

import { GET } from '@/app/api/admin/users/route';

async function getJson(qs = '') {
  const res = await GET(new NextRequest(`http://localhost/api/admin/users${qs}`));
  return { res, body: await res.json() };
}

beforeEach(() => {
  state.authContext = { userId: 'x-admin', role: 'superadmin' };
  state.canManage = true;
  state.queryGets = 0;
  jest.clearAllMocks();
});

describe('role filter resolves holders exactly (defect fix)', () => {
  it('1. role=chapter_vice_president returns BOTH holders whose doc ids sort beyond position 60', async () => {
    const { res, body } = await getJson('?role=chapter_vice_president');
    expect(res.status).toBe(200);
    const ids = body.users.map((u: any) => u.uid).sort();
    expect(ids).toEqual(['z-holder', 'z-mirror']);
    expect(body.debug.totalScored).toBe(2);
    // The roles-store holder shows the roles doc role, not the stale
    // users-doc mirror ('member_basic').
    const holder = body.users.find((u: any) => u.uid === 'z-holder');
    expect(holder.role).toBe('chapter_vice_president');
    // Exact resolution stays cheap: a handful of bounded queries,
    // never a collection scan.
    expect(state.queryGets).toBeLessThanOrEqual(6);
  });

  it('2. role filter with zero holders returns an empty 200 result, not an error', async () => {
    const { res, body } = await getJson('?role=chapter_treasurer');
    expect(res.status).toBe(200);
    expect(body.users).toEqual([]);
    expect(body.debug.totalScored).toBe(0);
    expect(body.nextCursor).toBe('');
  });

  it('5. role=member_basic paginates over the EXACT holder set: all 74 fillers reachable, precedence drops re-roled docs', async () => {
    const seen: string[] = [];
    let cursor = '';
    let totalScored = -1;
    for (let page = 0; page < 6; page++) {
      const qs = cursor
        ? `?role=member_basic&pageSize=20&startAfter=${cursor}`
        : '?role=member_basic&pageSize=20';
      const { res, body } = await getJson(qs);
      expect(res.status).toBe(200);
      if (page === 0) totalScored = body.debug.totalScored;
      seen.push(...body.users.map((u: any) => u.uid));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    // Exactly the 74 fillers: z-holder and the founder carry
    // 'member_basic' only in the stale users-doc mirror; their roles
    // docs (chapter_vice_president / founder_patron) win resolution,
    // so they are NOT member_basic holders.
    expect(totalScored).toBe(74);
    expect(new Set(seen).size).toBe(74);
    expect(seen).toContain('f074'); // sorts at position 74: outside the old window
    expect(seen).not.toContain('z-holder');
    expect(seen).not.toContain(FOUNDER_UID);
  });

  it('6. founder alias slugs resolve to the founder alone; additionalRoles-only slugs do not match', async () => {
    for (const slug of ['president_national', 'superadmin', 'founder_patron']) {
      const { res, body } = await getJson(`?role=${slug}`);
      expect(res.status).toBe(200);
      expect(body.users.map((u: any) => u.uid)).toEqual([FOUNDER_UID]);
    }
    // chapter_president is held ONLY via the founder's additionalRoles.
    // Directory role filters match the resolved PRIMARY role everywhere
    // in this route; additionalRoles confer no filter match (the
    // founder's president_national access flows through the alias).
    const { body } = await getJson('?role=chapter_president');
    expect(body.users).toEqual([]);
  });
});

describe('unchanged behaviour (no role-filter regression)', () => {
  it('3. exact-email lookup still resolves a holder beyond the window, with the roles-doc role', async () => {
    const { res, body } = await getJson('?q=vera@example.com');
    expect(res.status).toBe(200);
    expect(body.users).toHaveLength(1);
    expect(body.users[0].uid).toBe('z-holder');
    expect(body.users[0].role).toBe('chapter_vice_president');
  });

  it('4a. text search without a role filter still runs over the bounded window (totalScored capped at 60)', async () => {
    const { res, body } = await getJson('?q=filler');
    expect(res.status).toBe(200);
    expect(body.debug.totalScored).toBe(60);
    expect(body.users).toHaveLength(20);
  });

  it('4b. idle browsing (Path A) is unchanged', async () => {
    const { res, body } = await getJson();
    expect(res.status).toBe(200);
    expect(body.searchMethod).toBe('native_firestore');
    expect(body.users).toHaveLength(20);
    expect(body.users.map((u: any) => u.uid)).toContain('f001');
  });
});
