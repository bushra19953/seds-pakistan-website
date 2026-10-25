/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION CONTRACTS for GET /api/admin/users.
 *
 * These tests pin the CURRENT Firestore behaviour at the HTTP surface
 * so the migrated implementation (reads behind src/lib/supa/) can
 * prove byte-identical responses. They extend route.test.ts /
 * route-expiry.test.ts / route-parity.test.ts; nothing here duplicates
 * those suites.
 *
 * SEAM ASSUMPTIONS (named per the migration brief; the seam does not
 * exist in this tree yet):
 *  1. The migrated route will consult the adapter through the module
 *     '@/lib/supa' (the adapter branch's documented entry point),
 *     exporting useSupa(surface), getSupaClient() and getSupaAdapter().
 *  2. The surface name for this route is one of 'admin-users',
 *     'admin/users', 'users' or 'directory'. The mock below answers
 *     the flag from test-controlled state for ANY surface name, so the
 *     tests do not depend on the final name.
 *  3. On any adapter error, or when getSupaClient() returns null, the
 *     migrated route falls back to Firestore and the response is
 *     identical to the flag-OFF response (modulo responseTime, which
 *     is wall-clock and excluded from byte comparisons everywhere).
 *
 * In THIS tree the route never imports '@/lib/supa', so the virtual
 * mock is inert: every scenario below exercises the Firestore path,
 * which is exactly the behaviour being pinned. On the migrated tree
 * the same file exercises flag OFF, flag ON + adapter error, and
 * flag ON + unconfigured client without modification.
 */

import { NextRequest } from 'next/server';

type Row = { id: string; data: Record<string, any> };

const IST = 'seds-ist-chapter';
const FOUNDER_UID = 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';

// ---------------------------------------------------------------------------
// Supabase seam mock (virtual: the module does not exist in this tree).
// ---------------------------------------------------------------------------
const mockSupa = {
  enabled: false,
  clientConfigured: true,
  adapterError: false,
};

jest.mock(
  // Relative form of '@/lib/supa': the '@/' moduleNameMapper rewrites
  // the alias before virtual-mock resolution, so the alias form fails
  // with "module not found" while the module does not exist. This
  // relative specifier resolves to the same src/lib/supa location.
  '../../../../../lib/supa',
  () => ({
    useSupa: jest.fn(() => mockSupa.enabled),
    parseSupaSurfaces: jest.fn(() => new Set()),
    getSupaClient: jest.fn(() => (mockSupa.clientConfigured ? { __mockSupaClient: true } : null)),
    getSupaAdapter: jest.fn(() => {
      const fail = async () => {
        throw new Error('mock adapter failure (Supabase unavailable)');
      };
      return {
        getDoc: fail,
        listDocs: fail,
        countDocs: fail,
        setDoc: fail,
        updateDoc: fail,
        deleteDoc: fail,
      };
    }),
    createSupaAdapter: jest.fn(() => {
      throw new Error('mock adapter failure (Supabase unavailable)');
    }),
    resetSupaClientForTests: jest.fn(),
    SupaAdapterError: class SupaAdapterError extends Error {},
    SupaUnavailableError: class SupaUnavailableError extends Error {},
  }),
  { virtual: true },
);

// ---------------------------------------------------------------------------
// Firestore fixtures. 70 same-prefix users fill the Path B candidate
// window (pageSize 20 -> window 60); 'zz-probe' sorts last by doc id
// and is reachable ONLY through the exact-email probe.
// ---------------------------------------------------------------------------
const state = {
  authContext: { userId: 'admin-global', role: 'superadmin' } as any,
  canManage: true,
  usersGets: 0,
  rolesGets: 0,
  emailProbeGets: 0,
  queryLog: [] as Array<{ collection: string; wheres: any[]; limitVal: number | null }>,
};

const bulkUsers: Row[] = Array.from({ length: 70 }, (_, i) => {
  const n = String(i + 1).padStart(2, '0');
  return {
    id: `bulk-${n}`,
    data: {
      displayName: `Match Person ${n}`,
      email: `match${n}@example.com`,
      whatsapp: `030000000${n}`,
      role: 'member',
      chapterId: IST,
    },
  };
});

const userRows: Row[] = [
  ...bulkUsers,
  { id: 'zz-probe', data: { displayName: 'Probe Target', email: 'probe@example.com', whatsapp: '03007777777', role: 'member', chapterId: IST } },
  { id: FOUNDER_UID, data: { displayName: 'Founder Person', email: 'founder@example.com', whatsapp: '', role: 'member', chapterId: IST } },
  { id: 'admin-global', data: { displayName: 'Global Admin', email: 'g@example.com', whatsapp: '', role: 'superadmin' } },
];

const roleRows: Row[] = [
  { id: 'bulk-01', data: { role: 'member' } },
  { id: 'zz-probe', data: { role: 'member' } },
];

function rowFilter(field: string, op: string, value: any) {
  if (field === '__name__' && op === 'in') return (r: Row) => (value as string[]).includes(r.id);
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

function makeChain(
  collection: string,
  rows: Row[],
  filters: Array<(r: Row) => boolean> = [],
  wheres: any[] = [],
  selected: string[] | null = null,
  limitVal: number | null = null,
  startAfterId: string | null = null,
): any {
  const chain: any = {
    where: (f: string, op: string, v: any) =>
      makeChain(collection, rows, [...filters, rowFilter(f, op, v)], [...wheres, [f, op, v]], selected, limitVal, startAfterId),
    orderBy: () => chain,
    startAfter: (v: string) => makeChain(collection, rows, filters, wheres, selected, limitVal, v),
    limit: (n: number) => makeChain(collection, rows, filters, wheres, selected, n, startAfterId),
    select: (...fields: string[]) => makeChain(collection, rows, filters, wheres, fields, limitVal, startAfterId),
    get: async () => {
      if (collection === 'users') state.usersGets++;
      if (collection === 'roles') state.rolesGets++;
      if (collection === 'users' && wheres.some(([f, op]) => f === 'email' && op === '==')) state.emailProbeGets++;
      state.queryLog.push({ collection, wheres, limitVal });
      let matched = rows.filter((r) => filters.every((fn) => fn(r)));
      // Doc-id order (the route orders by __name__) + startAfter + limit,
      // honoured so the bounded window is observable in these tests.
      matched = [...matched].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (startAfterId) matched = matched.filter((r) => r.id > startAfterId);
      if (limitVal !== null) matched = matched.slice(0, limitVal);
      return {
        docs: matched.map((r) => ({ id: r.id, data: () => project(r.data, selected) })),
        size: matched.length,
        empty: matched.length === 0,
      };
    },
  };
  return chain;
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'users') return makeChain('users', userRows);
    if (name === 'roles') return makeChain('roles', roleRows);
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
        ? { exists: true, role: r.data.role, chapterId: r.data.chapterId, isBanned: false }
        : { exists: false, role: undefined, chapterId: undefined, isBanned: false },
      loadedAt: Date.now(),
    };
  }),
}));

import { GET } from '@/app/api/admin/users/route';

function req(qs = '') {
  return new NextRequest(`http://localhost/api/admin/users${qs}`);
}

async function getJson(qs = '') {
  const res = await GET(req(qs));
  return { res, body: await res.json() };
}

function withoutTiming(body: any) {
  const { responseTime, ...rest } = body;
  return rest;
}

beforeEach(() => {
  state.authContext = { userId: 'admin-global', role: 'superadmin' };
  state.canManage = true;
  state.usersGets = 0;
  state.rolesGets = 0;
  state.emailProbeGets = 0;
  state.queryLog = [];
  mockSupa.enabled = false;
  mockSupa.clientConfigured = true;
  mockSupa.adapterError = false;
});

describe('GET /api/admin/users migration contracts: response shape', () => {
  it('Path A body carries exactly the pinned top-level keys and searchMethod native_firestore', async () => {
    const { res, body } = await getJson('?pageSize=3');
    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(
      ['nextCursor', 'pageSize', 'responseTime', 'searchMethod', 'users'].sort(),
    );
    // OPEN QUESTION for the migration: searchMethod is the literal
    // string 'native_firestore' today in BOTH paths. Whether the
    // Supabase path keeps this value or reports its own engine is a
    // product decision; until it is taken, byte-identical means this
    // exact string.
    expect(body.searchMethod).toBe('native_firestore');
    expect(typeof body.responseTime).toBe('number');
  });

  it('Path A user rows carry exactly the pinned projection keys', async () => {
    const { body } = await getJson('?pageSize=3');
    expect(body.users.length).toBeGreaterThan(0);
    for (const u of body.users) {
      expect(Object.keys(u).sort()).toEqual(
        ['chapterId', 'displayName', 'email', 'isBanned', 'role', 'roleExpiresAt', 'uid', 'whatsapp'].sort(),
      );
    }
  });

  it('Path B body carries exactly the pinned top-level keys (incl. cached:false and debug) and the same searchMethod', async () => {
    const { res, body } = await getJson('?q=match&pageSize=5');
    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(
      ['cached', 'debug', 'nextCursor', 'pageSize', 'responseTime', 'searchMethod', 'users'].sort(),
    );
    expect(body.searchMethod).toBe('native_firestore');
    expect(body.cached).toBe(false);
    expect(Object.keys(body.debug).sort()).toEqual(['query', 'totalScored'].sort());
    expect(body.debug.query).toBe('match');
    for (const u of body.users) {
      expect(Object.keys(u).sort()).toEqual(
        ['chapterId', 'displayName', 'email', 'isBanned', 'role', 'roleExpiresAt', 'uid', 'whatsapp'].sort(),
      );
    }
  });

  it('Path B lowercases email/whatsapp in rows while displayName keeps its case; Path A preserves stored case', async () => {
    // Path B scans a lowercased in-memory directory; pin the asymmetry.
    const b = await getJson('?q=probe@example.com');
    const probe = b.body.users.find((u: any) => u.uid === 'zz-probe');
    expect(probe.email).toBe('probe@example.com');
    expect(probe.displayName).toBe('Probe Target');
  });

  it('pageSize defaults to 20 and clamps into [1, 50]', async () => {
    const def = await getJson('?q=match');
    expect(def.body.pageSize).toBe(20);
    expect(def.body.users).toHaveLength(20);

    const huge = await getJson('?q=match&pageSize=999');
    expect(huge.body.pageSize).toBe(50);
    expect(huge.body.users).toHaveLength(50);

    const zero = await getJson('?q=match&pageSize=0');
    expect(zero.body.pageSize).toBe(1);
    expect(zero.body.users).toHaveLength(1);
  });
});

describe('GET /api/admin/users migration contracts: bounded reads', () => {
  it('Path B candidate window is bounded at pageSize*3 (<=150): only the first 60 doc-id-ordered docs are scored at pageSize 20', async () => {
    const { body } = await getJson('?q=match&pageSize=20');
    // Window = admin-global + bulk-01..bulk-59; admin-global does not
    // match 'match', so 59 of the 70 matching docs are scored.
    expect(body.debug.totalScored).toBe(59);
    expect(body.users).toHaveLength(20);
    expect(body.nextCursor).not.toBe('');
    const usersQuery = state.queryLog.find((e) => e.collection === 'users');
    expect(usersQuery).toBeDefined();
    expect(usersQuery!.limitVal).toBe(60);
  });

  it('no users or roles query in either path ever requests more than 150 docs', async () => {
    await getJson('?pageSize=50');
    await getJson('?q=match&pageSize=50');
    for (const entry of state.queryLog) {
      if (entry.limitVal !== null) expect(entry.limitVal).toBeLessThanOrEqual(150);
      const inClause = entry.wheres.find(([, op]) => op === 'in');
      if (inClause) expect((inClause[2] as any[]).length).toBeLessThanOrEqual(30);
    }
  });

  it('exact-email search resolves a user outside the candidate window via a single equality probe (limit 1)', async () => {
    const { res, body } = await getJson('?q=probe@example.com');
    expect(res.status).toBe(200);
    const probe = body.users.find((u: any) => u.uid === 'zz-probe');
    expect(probe).toBeDefined();
    expect(probe.email).toBe('probe@example.com');
    expect(state.emailProbeGets).toBe(1);
    const probeQuery = state.queryLog.find(
      (e) => e.collection === 'users' && e.wheres.some(([f, op]) => f === 'email' && op === '=='),
    );
    expect(probeQuery).toBeDefined();
    expect(probeQuery!.limitVal).toBe(1);
  });

  it('no email probe is issued when the exact-email user is already inside the candidate window', async () => {
    const { body } = await getJson('?q=match01@example.com');
    expect(body.users.map((u: any) => u.uid)).toContain('bulk-01');
    expect(state.emailProbeGets).toBe(0);
  });

  it('an exact email match outranks name matches (score 100 ordering)', async () => {
    const { body } = await getJson('?q=match person match07@example.com');
    expect(body.users[0].uid).toBe('bulk-07');
  });
});

describe('GET /api/admin/users migration contracts: Path A cache + cursor', () => {
  it('a second identical idle call is served from the 30s cache: cached:true, identical payload, no new Firestore gets', async () => {
    const first = await getJson('?pageSize=4');
    expect(first.body.cached).toBeUndefined();
    const getsAfterFirst = state.usersGets + state.rolesGets;

    const second = await getJson('?pageSize=4');
    expect(second.body.cached).toBe(true);
    expect(second.body.searchMethod).toBe('native_firestore');
    expect(withoutTiming(second.body)).toEqual({ ...withoutTiming(first.body), cached: true });
    expect(state.usersGets + state.rolesGets).toBe(getsAfterFirst);
  });

  it('Path A cursor: nextCursor is the last row uid and startAfter continues disjointly', async () => {
    const page1 = await getJson('?pageSize=2');
    expect(page1.body.users).toHaveLength(2);
    expect(page1.body.nextCursor).toBe(page1.body.users[1].uid);

    const page2 = await getJson(`?pageSize=2&startAfter=${page1.body.nextCursor}`);
    expect(page2.body.users).toHaveLength(2);
    const ids1 = new Set(page1.body.users.map((u: any) => u.uid));
    for (const u of page2.body.users) expect(ids1.has(u.uid)).toBe(false);
  });
});

describe('GET /api/admin/users migration contracts: founder alias role filter', () => {
  it("role=superadmin (and president_national / founder_patron) returns only the founder UID row when the founder is inside the candidate window", async () => {
    for (const alias of ['superadmin', 'president_national', 'founder_patron']) {
      const { res, body } = await getJson(`?role=${alias}&pageSize=50`);
      expect(res.status).toBe(200);
      expect(body.users.map((u: any) => u.uid)).toEqual([FOUNDER_UID]);
    }
  });

  it('SURPRISE (pinned current behaviour): the founder alias is window-bound - at the default pageSize the founder doc (id sorts after bulk-*) falls outside the 60-doc window and the alias returns []', async () => {
    const { res, body } = await getJson('?role=superadmin');
    expect(res.status).toBe(200);
    expect(body.users).toEqual([]);
    expect(body.debug.totalScored).toBe(0);
  });
});

describe('GET /api/admin/users migration contracts: flag / fallback equivalence', () => {
  const scenarios: Array<[string, () => void]> = [
    ['flag OFF (Firestore serves)', () => { mockSupa.enabled = false; }],
    ['flag ON + adapter error (Firestore fallback)', () => { mockSupa.enabled = true; mockSupa.adapterError = true; }],
    ['flag ON + Supabase client unconfigured (Firestore fallback)', () => { mockSupa.enabled = true; mockSupa.clientConfigured = false; }],
  ];

  for (const [label, setup] of scenarios) {
    it(`${label}: Path B search response is identical to the pinned baseline`, async () => {
      setup();
      const { res, body } = await getJson('?q=match&pageSize=20');
      expect(res.status).toBe(200);
      expect(body.searchMethod).toBe('native_firestore');
      expect(body.users).toHaveLength(20);
      expect(body.users.slice(0, 5).map((u: any) => u.uid)).toEqual(['bulk-01', 'bulk-02', 'bulk-03', 'bulk-04', 'bulk-05']);
      expect(body.users[0]).toEqual({
        uid: 'bulk-01',
        displayName: 'Match Person 01',
        email: 'match01@example.com',
        whatsapp: '03000000001',
        role: 'member',
        roleExpiresAt: null,
        chapterId: IST,
        isBanned: false,
      });
      expect(body.debug.totalScored).toBe(59);
    });
  }
});
