/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION CONTRACTS for GET /api/admin/users.
 *
 * These tests pin the CORRECTED directory behaviour at the HTTP
 * surface so the migrated implementation (reads behind src/lib/supa/)
 * can prove identical responses. They extend route.test.ts /
 * route-expiry.test.ts / route-parity.test.ts; nothing here duplicates
 * those suites.
 *
 * RE-BASED 2026-10-25 on the corrected directory semantics. The
 * previous revision of this file pinned the bounded-window behaviour
 * for role filters (commit 3c01e8e: 'bounded window'), which is a
 * live-verified DEFECT: role filters and founder-alias lookups were
 * answered from the first pageSize*3 user docs by doc id, so a holder
 * whose doc id sorted past the window was silently invisible
 * (DIRECTORY_SEARCH_DEFECT_2026-10-25.md). The spec for the corrected
 * semantics is ~/workspace/permissions_audit/
 * DIRECTORY_ROLEFILTER_FIX_REPORT.md; the reference implementation is
 * branch fix/directory-role-filter (route-rolefilter.test.ts there is
 * the case-structure mirror for the 'corrected role-filter semantics'
 * describe below). Corrected semantics, in short:
 *  - A role filter resolves its holder set EXACTLY: roles-store
 *    equality UNION users-mirror equality; the RESOLVED role
 *    (roles doc beats users mirror) decides the match, so a stale
 *    mirror confers nothing and a roles-store holder is never missed.
 *  - additionalRoles confer NO filter match (primary role only).
 *  - Founder alias slugs (president_national / superadmin /
 *    founder_patron) resolve to the founder UID alone, at any
 *    pageSize - the alias is no longer window-bound.
 *  - A zero-holder role is an empty 200 (users: [], totalScored: 0,
 *    nextCursor: ''), never an error; an orphaned roles doc (no
 *    users doc) never surfaces as a row.
 *  - debug.totalScored for role-filtered queries is the TRUE holder
 *    count; cursor pagination walks the exact set with no duplicates.
 *  - Text-only searches are UNCHANGED: still served from the bounded
 *    candidate window on the Firestore side (the fix deliberately
 *    left them; the owner's name-search decision is still pending).
 *  - Idle Path A is unchanged.
 *
 * searchMethod (DECISIONS.md, cluster-users, 2026-10-25): the field
 * reports the engine that actually served the query - flag OFF or
 * Firestore fallback: 'native_firestore'; flag ON with the Supa seam
 * serving: 'supabase'.
 *
 * SEAM ASSUMPTIONS (named per the migration brief; the seam does not
 * exist in this tree yet - G1 builds it on feat/supa-users-1 as
 * src/lib/supa-seams/users-directory.ts behind useSupa('directory')):
 *  1. The migrated route consults the adapter through '@/lib/supa',
 *     exporting useSupa(surface), getSupaClient() and getSupaAdapter()
 *     (adapter: getDoc/listDocs/countDocs per src/lib/supa/adapter.ts;
 *     listDocs(collectionPath, { where, orderBy, limit, startAfter })
 *     resolves to SupaDoc[] = { id, ...data }).
 *  2. The mock below answers the flag from test-controlled state for
 *     ANY surface name, so the tests do not depend on the final name.
 *  3. On any adapter error, or when getSupaClient() returns null, the
 *     migrated route falls back to Firestore and the response is
 *     identical to the flag-OFF response - including searchMethod
 *     'native_firestore' (DECISIONS.md).
 *
 * RUNNABLE NOW vs MERGE-TIME:
 *  - Every non-skipped test is runnable now. Against the UNCORRECTED
 *    route (this tree, base 4d5a1e16) the corrected-semantics pins
 *    FAIL by design - that failure is the proof they encode the fix;
 *    against the corrected route (fix/directory-role-filter) they
 *    pass. The unchanged-behaviour pins pass on both.
 *  - The 'flag-ON served by the seam' describe is MERGE-TIME: its
 *    tests are skipped until G1 wires the route to the seam. The fake
 *    adapter in 'serve' mode already serves the active fixture corpus
 *    through the documented adapter interface, so un-skipping the
 *    describe on the merged tree exercises them without edits.
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
  // MERGE-TIME only: when true, getSupaAdapter() returns a fake
  // adapter that SERVES the active fixture corpus (see mockServeListDocs)
  // instead of the all-failing adapter used by the fallback pins.
  serve: false,
};

// The corpus the fake adapter serves; kept in lockstep with the fake
// Firestore corpus by useLegacyCorpus()/useExactCorpus() below (the
// declarations are hoisted module state, assigned before any test
// runs).
let mockAdapterUsers: Row[] = [];
let mockAdapterRoles: Row[] = [];

function mockAdapterRows(collectionPath: string): Row[] {
  if (collectionPath === 'users') return mockAdapterUsers;
  if (collectionPath === 'roles') return mockAdapterRoles;
  return [];
}

function mockServeListDocs(collectionPath: string, options: any = {}): any[] {
  let rows = mockAdapterRows(collectionPath);
  for (const [field, op, value] of options.where ?? []) {
    rows = rows.filter((r) => {
      const v = field === '__name__' || field === 'id' ? r.id : r.data[field];
      if (op === '==') return v === value;
      if (op === 'in') return (value as any[]).includes(v);
      return true;
    });
  }
  // The real adapter pages by document id (adapter.ts fetchAllRows),
  // so id-ascending is the honest default order here too.
  rows = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (options.startAfter !== undefined) {
    rows = rows.filter((r) => r.id > String(options.startAfter));
  }
  if (options.limit !== undefined) rows = rows.slice(0, options.limit);
  return rows.map((r) => ({ id: r.id, ...r.data }));
}

jest.mock(
  // MERGE-TIME (coordinator): the alias form is used on the merged tree.
  // The relative form was required on the authoring tree, where
  // src/lib/supa did not exist yet; it does not intercept the seam's
  // '@/lib/supa' import in this jest setup (probe-verified: the seam
  // bound the real module and the served pins fell back). The module
  // exists now, so the alias form resolves and the mock reaches every
  // importer, the seam included.
  '@/lib/supa',
  () => ({
    useSupa: jest.fn(() => mockSupa.enabled),
    parseSupaSurfaces: jest.fn(() => new Set()),
    getSupaClient: jest.fn(() => (mockSupa.clientConfigured ? { __mockSupaClient: true } : null)),
    getSupaAdapter: jest.fn(() => {
      if (mockSupa.serve && !mockSupa.adapterError) {
        return {
          getDoc: async (collectionPath: string, id: string) => {
            const r = mockAdapterRows(collectionPath).find((x) => x.id === id);
            return r ? { id: r.id, ...r.data } : null;
          },
          listDocs: async (collectionPath: string, options: any = {}) =>
            mockServeListDocs(collectionPath, options),
          countDocs: async (collectionPath: string, options: any = {}) =>
            mockServeListDocs(collectionPath, options).length,
          setDoc: async () => { throw new Error('directory contracts are read-only'); },
          updateDoc: async () => { throw new Error('directory contracts are read-only'); },
          deleteDoc: async () => { throw new Error('directory contracts are read-only'); },
        };
      }
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
// Fixtures - TWO corpora.
//
// LEGACY corpus (the original fixtures of this file, unchanged): 70
// same-prefix users fill the Path B candidate window (pageSize 20 ->
// window 60); 'zz-probe' sorts last by doc id and is reachable ONLY
// through the exact-email probe. Used by every unchanged-behaviour pin.
//
// EXACT corpus (mirrors route-rolefilter.test.ts on
// fix/directory-role-filter): 74 fillers + founder + caller +
// z-holder + z-mirror; both chapter_vice_president holders sort at
// doc-id positions 77-78, far past the old 60-doc window.
//   f001..f074  fillers, users-mirror role 'member_basic', no roles doc
//   FOUNDER_UID users-mirror 'member_basic' (STALE), roles doc
//               'founder_patron' + additionalRoles
//               ['president_national', 'chapter_president']
//   x-admin     the caller (superadmin)
//   z-holder    users-mirror 'member_basic' (STALE), roles doc
//               'chapter_vice_president'  -> roles-store holder
//   z-mirror    users-mirror 'chapter_vice_president', NO roles doc
//               -> mirror-only holder
//   z-gone      roles doc 'chapter_vice_president', NO users doc
//               -> orphaned grant; must never surface as a row
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

const legacyUsers: Row[] = [
  ...bulkUsers,
  { id: 'zz-probe', data: { displayName: 'Probe Target', email: 'probe@example.com', whatsapp: '03007777777', role: 'member', chapterId: IST } },
  { id: FOUNDER_UID, data: { displayName: 'Founder Person', email: 'founder@example.com', whatsapp: '', role: 'member', chapterId: IST } },
  { id: 'admin-global', data: { displayName: 'Global Admin', email: 'g@example.com', whatsapp: '', role: 'superadmin' } },
];

const legacyRoles: Row[] = [
  { id: 'bulk-01', data: { role: 'member' } },
  { id: 'zz-probe', data: { role: 'member' } },
];

const exactUsers: Row[] = [];
for (let i = 1; i <= 74; i++) {
  const n = String(i).padStart(3, '0');
  exactUsers.push({
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
exactUsers.push(
  { id: FOUNDER_UID, data: { displayName: 'Founder Person', email: 'founder@example.com', whatsapp: '', role: 'member_basic', chapterId: IST } },
  { id: 'x-admin', data: { displayName: 'Directory Admin', email: 'admin@example.com', whatsapp: '', role: 'superadmin', chapterId: IST } },
  { id: 'z-holder', data: { displayName: 'Vera Holder', email: 'vera@example.com', whatsapp: '', role: 'member_basic', chapterId: IST } },
  { id: 'z-mirror', data: { displayName: 'Mira Mirror', email: 'mira@example.com', whatsapp: '', role: 'chapter_vice_president', chapterId: IST } },
);

const exactRoles: Row[] = [
  { id: FOUNDER_UID, data: { role: 'founder_patron', additionalRoles: ['president_national', 'chapter_president'] } },
  { id: 'z-holder', data: { role: 'chapter_vice_president' } },
  { id: 'z-gone', data: { role: 'chapter_vice_president' } },
];

// Active corpus pointers: the fake Firestore and the fake Supa
// adapter both read these, so a scenario sees ONE directory no
// matter which engine serves it.
let userRows: Row[] = legacyUsers;
let roleRows: Row[] = legacyRoles;

function useLegacyCorpus() {
  userRows = legacyUsers;
  roleRows = legacyRoles;
  mockAdapterUsers = legacyUsers;
  mockAdapterRoles = legacyRoles;
  state.authContext = { userId: 'admin-global', role: 'superadmin' };
}

function useExactCorpus() {
  userRows = exactUsers;
  roleRows = exactRoles;
  mockAdapterUsers = exactUsers;
  mockAdapterRoles = exactRoles;
  state.authContext = { userId: 'x-admin', role: 'superadmin' };
}

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
    if (name === 'users') {
      return {
        ...makeChain('users', userRows),
        doc: (id: string) => ({
          get: async () => {
            const r = userRows.find((u) => u.id === id);
            return { exists: !!r, id, data: () => (r ? { ...r.data } : undefined) };
          },
        }),
      };
    }
    if (name === 'roles') return makeChain('roles', roleRows);
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
  useLegacyCorpus();
  state.canManage = true;
  state.usersGets = 0;
  state.rolesGets = 0;
  state.emailProbeGets = 0;
  state.queryLog = [];
  mockSupa.enabled = false;
  mockSupa.clientConfigured = true;
  mockSupa.adapterError = false;
  mockSupa.serve = false;
});

describe('GET /api/admin/users migration contracts: response shape', () => {
  it('Path A body carries exactly the pinned top-level keys and searchMethod native_firestore', async () => {
    const { res, body } = await getJson('?pageSize=3');
    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(
      ['nextCursor', 'pageSize', 'responseTime', 'searchMethod', 'users'].sort(),
    );
    // DECIDED (DECISIONS.md, cluster-users, 2026-10-25): searchMethod
    // reports the engine that actually served the query. Flag OFF and
    // every Firestore fallback keep this exact string; a flag-ON
    // response served by the seam reports 'supabase' (pinned in the
    // merge-time describe below).
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

describe('GET /api/admin/users migration contracts: bounded reads + text-only window (UNCHANGED by the role-filter fix)', () => {
  it('TEXT-ONLY search still runs over the bounded window: only the first 60 doc-id-ordered docs are scored at pageSize 20', async () => {
    // The fix deliberately left text-only searches window-served on
    // the Firestore side (fix report: "Text-only searches are
    // byte-for-byte unchanged"). This pin is the flag-OFF behaviour;
    // the flag-ON text-search contract is an OPEN pin - see the
    // merge-time describe.
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

  it('no users or roles query in either path ever requests more than 150 docs (role-filtered queries included)', async () => {
    await getJson('?pageSize=50');
    await getJson('?q=match&pageSize=50');
    await getJson('?role=member&pageSize=50');
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

describe('GET /api/admin/users migration contracts: founder alias (CORRECTED - the alias is not window-bound)', () => {
  it("role=superadmin (and president_national / founder_patron) returns only the founder UID row at pageSize 50", async () => {
    for (const alias of ['superadmin', 'president_national', 'founder_patron']) {
      const { res, body } = await getJson(`?role=${alias}&pageSize=50`);
      expect(res.status).toBe(200);
      expect(body.users.map((u: any) => u.uid)).toEqual([FOUNDER_UID]);
    }
  });

  it('CORRECTED (was: "SURPRISE - the founder alias is window-bound"): the alias slugs return the founder at the DEFAULT pageSize too, with totalScored 1', async () => {
    // Old pin (3c01e8e) asserted users: [] and totalScored: 0 here
    // because the founder doc sorts past the 60-doc window. That was
    // the defect, not a contract: alias resolution is exact.
    for (const alias of ['superadmin', 'president_national', 'founder_patron']) {
      const { res, body } = await getJson(`?role=${alias}`);
      expect(res.status).toBe(200);
      expect(body.users.map((u: any) => u.uid)).toEqual([FOUNDER_UID]);
      expect(body.debug.totalScored).toBe(1);
    }
  });
});

describe('GET /api/admin/users migration contracts: CORRECTED role-filter semantics (exact holder resolution)', () => {
  beforeEach(() => {
    useExactCorpus();
  });

  it('role filter returns BOTH holders whose doc ids sort beyond position 60: roles-store holder AND mirror-only holder; the orphaned roles doc never surfaces', async () => {
    const { res, body } = await getJson('?role=chapter_vice_president');
    expect(res.status).toBe(200);
    const ids = body.users.map((u: any) => u.uid).sort();
    expect(ids).toEqual(['z-holder', 'z-mirror']);
    // totalScored is the TRUE holder count, not a window-limited one.
    expect(body.debug.totalScored).toBe(2);
    // The roles-store holder shows the roles-doc role, not the stale
    // users-doc mirror ('member_basic'): the resolved role decides.
    const holder = body.users.find((u: any) => u.uid === 'z-holder');
    expect(holder.role).toBe('chapter_vice_president');
    // The mirror-only holder (no roles doc) matches on its mirror.
    const mirror = body.users.find((u: any) => u.uid === 'z-mirror');
    expect(mirror.role).toBe('chapter_vice_president');
    // Exact resolution stays cheap: a handful of bounded queries,
    // never a collection scan (fix-report read profile: <= 6).
    expect(state.usersGets + state.rolesGets).toBeLessThanOrEqual(6);
  });

  it('a zero-holder role returns an empty 200 result (users: [], totalScored: 0, empty cursor), not an error', async () => {
    const { res, body } = await getJson('?role=chapter_treasurer');
    expect(res.status).toBe(200);
    expect(body.users).toEqual([]);
    expect(body.debug.totalScored).toBe(0);
    expect(body.nextCursor).toBe('');
  });

  it('role=member_basic paginates over the EXACT holder set: all 74 fillers reachable across cursor pages, zero duplicates, stale mirrors confer nothing', async () => {
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
    expect(seen).toHaveLength(74);
    expect(new Set(seen).size).toBe(74);
    expect(seen).toContain('f074'); // sorts at position 74: outside the old window
    expect(seen).not.toContain('z-holder');
    expect(seen).not.toContain(FOUNDER_UID);
  });

  it('founder alias slugs resolve to the founder alone at the default pageSize, even with the founder deep in doc-id order', async () => {
    for (const slug of ['president_national', 'superadmin', 'founder_patron']) {
      const { res, body } = await getJson(`?role=${slug}`);
      expect(res.status).toBe(200);
      expect(body.users.map((u: any) => u.uid)).toEqual([FOUNDER_UID]);
      expect(body.debug.totalScored).toBe(1);
    }
  });

  it('additionalRoles confer NO filter match: role=chapter_president (held only via the founder additionalRoles) returns empty', async () => {
    const { res, body } = await getJson('?role=chapter_president');
    expect(res.status).toBe(200);
    expect(body.users).toEqual([]);
    expect(body.debug.totalScored).toBe(0);
  });

  it('UNCHANGED: exact-email lookup still resolves a holder beyond the window, with the roles-doc role', async () => {
    const { res, body } = await getJson('?q=vera@example.com');
    expect(res.status).toBe(200);
    expect(body.users).toHaveLength(1);
    expect(body.users[0].uid).toBe('z-holder');
    expect(body.users[0].role).toBe('chapter_vice_president');
  });

  it('UNCHANGED (flag-OFF pin): text search without a role filter still runs over the bounded window on this corpus (totalScored capped at 60)', async () => {
    const { res, body } = await getJson('?q=filler');
    expect(res.status).toBe(200);
    expect(body.debug.totalScored).toBe(60);
    expect(body.users).toHaveLength(20);
  });
});

describe('GET /api/admin/users migration contracts: flag / fallback equivalence (text search, legacy corpus)', () => {
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

describe('GET /api/admin/users migration contracts: flag / fallback equivalence for role-filtered queries (CORRECTED semantics, exact corpus)', () => {
  beforeEach(() => {
    useExactCorpus();
  });

  const scenarios: Array<[string, () => void]> = [
    ['flag OFF (Firestore serves)', () => { mockSupa.enabled = false; }],
    ['flag ON + adapter error (Firestore fallback)', () => { mockSupa.enabled = true; mockSupa.adapterError = true; }],
    ['flag ON + Supabase client unconfigured (Firestore fallback)', () => { mockSupa.enabled = true; mockSupa.clientConfigured = false; }],
  ];

  for (const [label, setup] of scenarios) {
    it(`${label}: role=chapter_vice_president returns the exact holder set with searchMethod native_firestore`, async () => {
      setup();
      const { res, body } = await getJson('?role=chapter_vice_president');
      expect(res.status).toBe(200);
      // Fallback means the FIRESTORE answer, verbatim - corrected
      // semantics included - and searchMethod stays
      // 'native_firestore' because Firestore served it (DECISIONS.md).
      expect(body.searchMethod).toBe('native_firestore');
      expect(body.users.map((u: any) => u.uid).sort()).toEqual(['z-holder', 'z-mirror']);
      expect(body.debug.totalScored).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// MERGE-TIME PINS - flag ON, seam SERVES. Skipped in this tree: the
// route does not consult the seam yet (G1, feat/supa-users-1, builds
// src/lib/supa-seams/users-directory.ts behind useSupa('directory')).
// On the merged tree: un-skip this describe (describe.skip -> describe)
// and these tests run as written - the fake adapter above already
// serves the active corpus through the documented adapter interface,
// and SUPA_SURFACES is set in-process in case the merged route reads
// the real flags module instead of the mocked '@/lib/supa'.
// ---------------------------------------------------------------------------
describe('GET /api/admin/users migration contracts: flag-ON served by the seam (MERGE-TIME)', () => {
  beforeEach(() => {
    useExactCorpus();
    mockSupa.enabled = true;
    mockSupa.serve = true;
    process.env.SUPA_SURFACES = 'users'; // flag-name ruling (coordinator): the landing surface is 'users', not the stub-era 'directory'
  });

  afterEach(() => {
    delete process.env.SUPA_SURFACES;
  });

  it('MERGE-TIME: role=chapter_vice_president served by the seam returns the same corrected holder set, searchMethod supabase, Firestore untouched', async () => {
    const { res, body } = await getJson('?role=chapter_vice_president');
    expect(res.status).toBe(200);
    expect(body.searchMethod).toBe('supabase');
    expect(body.users.map((u: any) => u.uid).sort()).toEqual(['z-holder', 'z-mirror']);
    expect(body.debug.totalScored).toBe(2);
    const holder = body.users.find((u: any) => u.uid === 'z-holder');
    expect(holder.role).toBe('chapter_vice_president');
    // Served means served: a fallback in disguise would show up here.
    expect(state.usersGets + state.rolesGets).toBe(0);
  });

  it('MERGE-TIME: role=member_basic served by the seam reports the true holder count (totalScored 74) on page 1', async () => {
    const { res, body } = await getJson('?role=member_basic&pageSize=20');
    expect(res.status).toBe(200);
    expect(body.searchMethod).toBe('supabase');
    expect(body.debug.totalScored).toBe(74);
    expect(body.users).toHaveLength(20);
    expect(body.nextCursor).not.toBe('');
    expect(state.usersGets + state.rolesGets).toBe(0);
  });

  it('MERGE-TIME: idle Path A served by the seam reports searchMethod supabase and the pinned Path A shape', async () => {
    const { res, body } = await getJson('?pageSize=3');
    expect(res.status).toBe(200);
    expect(body.searchMethod).toBe('supabase');
    expect(Object.keys(body).sort()).toEqual(
      ['nextCursor', 'pageSize', 'responseTime', 'searchMethod', 'users'].sort(),
    );
    expect(body.users).toHaveLength(3);
    expect(state.usersGets + state.rolesGets).toBe(0);
  });

  it('MERGE-TIME / OPEN PIN: text-only search served by the seam - only the shape is pinned; totalScored semantics are OPEN', async () => {
    // OPEN: the fix report and DECISIONS.md settle text-only
    // behaviour for the FIRESTORE side only (bounded window). Whether
    // the seam serves text search from an exact scan (totalScored =
    // true match count) or reproduces the window (totalScored capped
    // at pageSize*3) is a G1 design decision that follows from
    // neither document. Recommendation (see CONTRACTS_UPDATE.md):
    // exact scan - the seam's listDocs already pages by id without
    // silent truncation, and pinning the window into a second engine
    // would re-encode a known defect as a contract. Until G1 rules,
    // this test pins only status + Path B shape.
    const { res, body } = await getJson('?q=filler');
    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(
      ['cached', 'debug', 'nextCursor', 'pageSize', 'responseTime', 'searchMethod', 'users'].sort(),
    );
    expect(body.users.length).toBeGreaterThan(0);
  });
});
