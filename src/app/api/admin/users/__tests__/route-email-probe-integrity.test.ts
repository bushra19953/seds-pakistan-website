/**
 * @jest-environment node
 *
 * Directory zero-records fix, REQ 3 (email-search integrity): an
 * exact-email search must never score-0 its own Auth-probe candidate.
 *
 * Live incident (2026-10-30): during a transient contacts-leg failure,
 * email searches for khan.shehriyar.1974@gmail.com and
 * litespice593@gmail.com returned a settled HTTP 200 with users: [] -
 * "no account" lies. Both people have complete records in Auth,
 * fs_users, the contact mirror and Firestore (proven in
 * ~/workspace/known_issues/directory_zero_records_scope.md). The
 * mechanism: loadDirectoryContacts degraded to an empty map, every
 * candidate's merged email became "", the Auth probe resolved the uid
 * but the rescued record still scored on the same failed merge, so it
 * scored 0 and was dropped.
 *
 * The fix contract pinned here: when Firebase Auth resolves the exact
 * address, the account email OF RECORD (Auth) backfills the candidate
 * whose contact merge left the email blank, so findability degrades
 * never - only the WhatsApp/contact display may degrade. Identity is
 * email-keyed ground truth from Auth only; names never rescue anyone.
 */

import { NextRequest } from 'next/server';

type Row = { id: string; data: Record<string, any> };

const IST = 'seds-ist-chapter';

// The two people from the live incident, with their real Auth uids and
// account emails (scope-doc record-level proof).
const SHEHRIYAR = { id: '2QoHitKoRFaYp8MaP0gM4SRlpPG2', email: 'khan.shehriyar.1974@gmail.com', name: 'Shehriyar Khan' };
const ZAINAB = { id: '2cpaTXJoocamNtIhEh2YpR8kkb72', email: 'litespice593@gmail.com', name: 'Zainab irfan' };

const state = {
  authContext: { userId: 'x-admin', role: 'superadmin' } as any,
  canManage: true,
  contactsThrow: false,
};

const userRows: Row[] = [
  { id: 'x-admin', data: { displayName: 'Directory Admin', email: 'admin@example.com', whatsapp: '', role: 'superadmin', chapterId: IST } },
  { id: SHEHRIYAR.id, data: { displayName: SHEHRIYAR.name, email: SHEHRIYAR.email, whatsapp: '', role: 'member_basic', chapterId: IST } },
  { id: ZAINAB.id, data: { displayName: ZAINAB.name, email: ZAINAB.email, whatsapp: '', role: 'member_basic', chapterId: IST } },
  // Fillers whose doc ids sort BEFORE '2QoH...' so a pageSize=1 window
  // (limit pageSize*3 = 3) excludes both incident people - the probe
  // then has to fetch the record itself.
  { id: '0filler-1', data: { displayName: 'Filler One', email: 'filler1@example.com', whatsapp: '', role: 'member_basic', chapterId: IST } },
  { id: '0filler-2', data: { displayName: 'Filler Two', email: 'filler2@example.com', whatsapp: '', role: 'member_basic', chapterId: IST } },
  { id: '0filler-3', data: { displayName: 'Filler Three', email: 'filler3@example.com', whatsapp: '', role: 'member_basic', chapterId: IST } },
];

const roleRows: Row[] = [
  { id: SHEHRIYAR.id, data: { role: 'member_basic' } },
  { id: ZAINAB.id, data: { role: 'member_basic' } },
];

// --- Fake Firestore (same chain pattern as route-contacts-degraded) --

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

// Deterministic seam: the directory is served by the Firestore arm in
// these fixtures (the probe/scoring machinery under test is shared by
// both arms; the Supa arm's own contract suites live elsewhere).
jest.mock('@/lib/supa-seams/users-directory', () => ({
  getUsersSupaAdapter: jest.fn(() => null),
  supaGetRolesByIds: jest.fn(async () => []),
  supaGetUsersByIds: jest.fn(async () => []),
  supaListAllUsers: jest.fn(async () => []),
  supaListRolesWhereRole: jest.fn(async () => []),
  supaListUsersWhere: jest.fn(async () => []),
  supaListUsersByNameKeyword: jest.fn(async () => []),
}));

// Contact doorway mock: healthy mode serves each row's contact fields;
// outage mode throws the way a real RESOURCE_EXHAUSTED escapes
// getUserContacts (same pattern as route-contacts-degraded.test.ts).
jest.mock('@/lib/server/user-contact', () => {
  const shared = jest.requireActual('@/lib/user-contact-shared');
  return {
    ...shared,
    getUserContacts: async (_db: any, uids: string[]) => {
      if (state.contactsThrow) {
        const err: any = new Error('8 RESOURCE_EXHAUSTED: Quota exceeded.');
        err.code = 8;
        throw err;
      }
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

// Firebase Auth mock: the email-keyed ground truth. Resolves exactly
// the addresses that have accounts; anything else is user-not-found.
jest.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    getUserByEmail: async (email: string) => {
      const row = userRows.find((r: any) => r.data.email === email);
      if (row) return { uid: row.id, email };
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
  state.contactsThrow = false;
  jest.clearAllMocks();
});

describe('REQ 3: exact-email search can never score-0 its Auth-probe candidate', () => {
  it('contacts down + person inside the candidate window: Shehriyar is still found by his exact email', async () => {
    state.contactsThrow = true;
    const { res, body } = await getJson(`?q=${encodeURIComponent(SHEHRIYAR.email)}`);
    expect(res.status).toBe(200);
    // The degradation stays loud (REQ 4) AND the person stays findable.
    expect(body.contactsDegraded).toBe(true);
    const hit = body.users.find((u: any) => u.uid === SHEHRIYAR.id);
    expect(hit).toBeTruthy();
    expect(hit.displayName).toBe('Shehriyar Khan');
    expect(hit.email).toBe(SHEHRIYAR.email);
  });

  it('contacts down + person outside the candidate window: the probe fetches Zainab and she is still found', async () => {
    state.contactsThrow = true;
    // pageSize=1 -> window is the 3 filler docs; Zainab's record can
    // only arrive through the Auth probe's by-id fetch.
    const { res, body } = await getJson(`?q=${encodeURIComponent(ZAINAB.email)}&pageSize=1`);
    expect(res.status).toBe(200);
    expect(body.contactsDegraded).toBe(true);
    const hit = body.users.find((u: any) => u.uid === ZAINAB.id);
    expect(hit).toBeTruthy();
    expect(hit.displayName).toBe('Zainab irfan');
    expect(hit.email).toBe(ZAINAB.email);
  });

  it('contacts healthy (control): exact-email search finds Zainab through the normal merge, no degraded flag', async () => {
    const { res, body } = await getJson(`?q=${encodeURIComponent(ZAINAB.email)}`);
    expect(res.status).toBe(200);
    expect(body.contactsDegraded).toBeFalsy();
    const hit = body.users.find((u: any) => u.uid === ZAINAB.id);
    expect(hit).toBeTruthy();
    expect(hit.email).toBe(ZAINAB.email);
  });

  it('contacts down + address with no account (control): Auth says not-found, result is a truthful empty, no phantom row', async () => {
    state.contactsThrow = true;
    const { res, body } = await getJson(`?q=${encodeURIComponent('nobody@example.com')}`);
    expect(res.status).toBe(200);
    expect(body.users).toEqual([]);
    expect(body.contactsDegraded).toBe(true);
  });
});
