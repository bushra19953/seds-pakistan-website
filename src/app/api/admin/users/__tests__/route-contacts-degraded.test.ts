/**
 * @jest-environment node
 *
 * Directory contact-outage loudness (live defect, 2026-10-30): contact
 * fields (email, WhatsApp) live ONLY in the gated Firestore records
 * users/{uid}/private/contact and are merged into directory rows by
 * loadDirectoryContacts. When that read fails - as it did for every row
 * during the Firestore quota outage - the route used to degrade
 * SILENTLY: rows serialized with empty emails, the EMAIL column showed
 * "-" for everyone and email search matched nothing, indistinguishable
 * from "nobody has an email on file". The response must now carry
 * contactsDegraded: true so the UI can warn, while still serving rows.
 */

import { NextRequest } from 'next/server';

type Row = { id: string; data: Record<string, any> };

const IST = 'seds-ist-chapter';

const state = {
  authContext: { userId: 'x-admin', role: 'superadmin' } as any,
  canManage: true,
  contactsThrow: false,
};

const userRows: Row[] = [
  { id: 'x-admin', data: { displayName: 'Directory Admin', email: 'admin@example.com', whatsapp: '', role: 'superadmin', chapterId: IST } },
  { id: 'u-shomail', data: { displayName: 'Shomail Khan', email: 'shomailkhan3@gmail.com', whatsapp: '', role: 'chapter_secretary', chapterId: IST } },
];

const roleRows: Row[] = [
  { id: 'u-shomail', data: { role: 'chapter_secretary' } },
];

// --- Fake Firestore (same chain pattern as route-rolefilter.test.ts) --

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

// Contact doorway mock: healthy mode serves contacts derived from the
// fixture rows (as route-rolefilter.test.ts does); outage mode throws
// the way a real Firestore RESOURCE_EXHAUSTED error escapes
// getUserContacts (it is not a capability error, so it propagates).
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

describe('directory contact degradation is loud', () => {
  it('healthy contact store: rows carry emails and no degradation flag', async () => {
    // Distinct pageSize per test: the route's 30s Path A cache keys on
    // it, and both tests here exercise idle Path A.
    const { res, body } = await getJson('?pageSize=20');
    expect(res.status).toBe(200);
    const shomail = body.users.find((u: any) => u.uid === 'u-shomail');
    expect(shomail.email).toBe('shomailkhan3@gmail.com');
    expect(body.contactsDegraded).toBeFalsy();
  });

  it('contact store down (quota): rows still serve, emails blank, contactsDegraded is true', async () => {
    state.contactsThrow = true;
    const { res, body } = await getJson('?pageSize=21');
    expect(res.status).toBe(200);
    expect(body.contactsDegraded).toBe(true);
    const shomail = body.users.find((u: any) => u.uid === 'u-shomail');
    expect(shomail).toBeTruthy();
    expect(shomail.displayName).toBe('Shomail Khan');
    expect(shomail.email).toBe('');
  });
});
