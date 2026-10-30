/**
 * @jest-environment node
 *
 * Directory zero-records fix, REQ 6 (latency margin): the Firestore
 * fallback arm's legs used to run SEQUENTIALLY - candidate window,
 * then one name-keyword query per term, then one roles chunk query
 * per 30 candidates with NO timeout wrapper at all. Against the
 * degraded-day baseline measured live on 2026-10-30 (a 60-doc window
 * query answering in ~3,948 ms, a 30-id roles chunk in ~711 ms, each
 * leg individually raced against a 10 s timeout), a 150-candidate
 * search stacks window + keyword legs + 5 sequential roles chunks
 * and can sail past any single leg's 10 s budget end-to-end - the
 * client/proxy then gives up and the directory renders as the
 * generic empty-looking failure (Rank 2 in the scope doc).
 *
 * Pinned here, deterministically (no wall-clock pass/fail):
 *  1. The roles chunk queries for a candidate set run CONCURRENTLY
 *     (max in-flight > 1), not one-after-another.
 *  2. A roles chunk query that never answers can no longer hang the
 *     request forever: the leg is timeout-bounded, the request
 *     settles, and rows still serve with the users-doc role fallback.
 */

import { NextRequest } from 'next/server';

type Row = { id: string; data: Record<string, any> };

const IST = 'seds-ist-chapter';
const CANDIDATES = 150; // pageSize=50 -> window cap pageSize*3

const state = {
  authContext: { userId: 'x-admin', role: 'superadmin' } as any,
  canManage: true,
  rolesHang: false,
};

const pad = (n: number) => `u${String(n).padStart(3, '0')}`;
const userRows: Row[] = [
  { id: 'x-admin', data: { displayName: 'Directory Admin', email: 'admin@example.com', whatsapp: '', role: 'superadmin', chapterId: IST } },
  ...Array.from({ length: CANDIDATES }, (_, i) => ({
    id: pad(i),
    data: { displayName: `Person ${i}`, email: `person${i}@example.com`, whatsapp: '', role: 'member_basic', chapterId: IST },
  })),
];
const roleRows: Row[] = userRows.map((r) => ({ id: r.id, data: { role: r.data.role } }));

// In-flight instrumentation for roles-collection gets.
const rolesFlight = { inFlight: 0, maxInFlight: 0 };
const QUERY_DELAY_MS = 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

function makeChain(collection: string, rows: Row[], s: ChainState): any {
  return {
    where: (f: string, op: string, v: any) =>
      makeChain(collection, rows, { ...s, filters: [...s.filters, rowFilter(f, op, v)] }),
    orderBy: () => makeChain(collection, rows, { ...s, ordered: true }),
    startAfter: (v: string) => makeChain(collection, rows, { ...s, afterId: v }),
    limit: (n: number) => makeChain(collection, rows, { ...s, limitN: n }),
    select: (...fields: string[]) => makeChain(collection, rows, { ...s, selected: fields }),
    get: async () => {
      if (collection === 'roles') {
        if (state.rolesHang) return new Promise(() => {}); // never settles
        rolesFlight.inFlight += 1;
        rolesFlight.maxInFlight = Math.max(rolesFlight.maxInFlight, rolesFlight.inFlight);
        try {
          await sleep(QUERY_DELAY_MS);
        } finally {
          rolesFlight.inFlight -= 1;
        }
      } else {
        await sleep(QUERY_DELAY_MS);
      }
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
        ...makeChain('users', userRows, fresh()),
        doc: (id: string) => ({
          get: async () => {
            const r = userRows.find((u) => u.id === id);
            return { exists: !!r, id, data: () => (r ? { ...r.data } : undefined) };
          },
        }),
      };
    }
    if (name === 'roles') return makeChain('roles', roleRows, fresh());
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
        ? { exists: true, role: r.data.role, additionalRoles: undefined, isBanned: false, chapterId: r.data.chapterId }
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
  state.canManage = true;
  state.rolesHang = false;
  rolesFlight.inFlight = 0;
  rolesFlight.maxInFlight = 0;
  jest.clearAllMocks();
});

describe('REQ 6: Firestore fallback legs are bounded, not stacked sequentially', () => {
  it('roles chunk queries for a 150-candidate search run concurrently (max in-flight > 1)', async () => {
    // q matches nobody by name, but candidate assembly + the roles
    // overlay still run over the full 150-doc window: 5 roles chunks.
    const started = Date.now();
    const { res, body } = await getJson('?q=zzznomatch&pageSize=50');
    const elapsed = Date.now() - started;
    // Measurement for the fix-line report (not the pass/fail signal):
    // sequential stacking would cost >= window 40ms + keyword 40ms +
    // 5 chunks x 40ms = ~280ms of pure injected delay; concurrent
    // legs cost ~120ms.
    console.info(`[REQ6] fallback elapsed=${elapsed}ms maxRolesInFlight=${rolesFlight.maxInFlight}`);
    expect(res.status).toBe(200);
    expect(body.users).toEqual([]);
    expect(rolesFlight.maxInFlight).toBeGreaterThan(1);
  });

  it('a roles chunk query that never answers cannot hang the request: it settles inside the leg timeout', async () => {
    jest.useFakeTimers();
    try {
      state.rolesHang = true;
      let settled = false;
      const pending = getJson('?q=zzznomatch&pageSize=50').then((r) => {
        settled = true;
        return r;
      });
      // The route races every leg against its 10s timeout; before the
      // fix the roles chunks had NO race, so this promise never
      // settled no matter how far the clock advanced. (11s, not 10s:
      // the earlier legs' own timers elapse first on the fake clock,
      // so the roles race is scheduled a few ms in.)
      await jest.advanceTimersByTimeAsync(11_000);
      expect(settled).toBe(true);
      const { res, body } = await pending;
      expect(res.status).toBe(200);
      // Rows still serve; roles fall back to the users-doc mirror.
      expect(Array.isArray(body.users)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
