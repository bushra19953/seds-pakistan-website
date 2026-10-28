/**
 * @jest-environment node
 *
 * FLAG-ON tests for the G1 Supa directory path (DECISIONS.md):
 *  - searchMethod reports "supabase" when the Supa path served
 *    (the case the contract suites left unpinned);
 *  - role filter returns the EXACT holder set, not a window;
 *  - name search finds a user whose doc id sorts beyond position 60
 *    (the full-set strategy: no pageSize*3 window on the Supa path);
 *  - exact-email probe parity on the Supa path.
 * All adapter and Firestore access is mocked; no live reads.
 */

import { NextRequest } from 'next/server';

type Row = { id: string; data: Record<string, any> };

const IST = 'seds-ist-chapter';
const FOUNDER_UID = 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';

const mockSupa = {
  enabled: true,
  clientConfigured: true,
  shouldFail: false,
  omitProbeFromFullList: false,
};

const bulkUsers: Row[] = Array.from({ length: 75 }, (_, i) => {
  const n = String(i + 1).padStart(3, '0');
  return {
    id: `a${n}`,
    data: { displayName: `Match Person ${n}`, email: `match${n}@example.com`, whatsapp: '', role: 'member', chapterId: IST },
  };
});

const supaUserRows: Row[] = [
  ...bulkUsers,
  { id: 'zz-late', data: { displayName: 'Zebra Late', email: 'zebra@example.com', whatsapp: '', role: 'member', chapterId: IST } },
  { id: 'zz-probe', data: { displayName: 'Probe Target', email: 'probe@example.com', whatsapp: '', role: 'member', chapterId: IST } },
  { id: 'z-holder', data: { displayName: 'Vera Holder', email: 'vera@example.com', whatsapp: '', role: 'member_basic', chapterId: IST } },
  { id: 'z-mirror', data: { displayName: 'Mira Mirror', email: 'mira@example.com', whatsapp: '', role: 'chapter_vice_president', chapterId: IST } },
  { id: FOUNDER_UID, data: { displayName: 'Founder Person', email: 'founder@example.com', whatsapp: '', role: 'member_basic', chapterId: IST } },
  { id: 'admin-global', data: { displayName: 'Global Admin', email: 'g@example.com', whatsapp: '', role: 'superadmin' } },
];

const supaRoleRows: Row[] = [
  { id: 'z-holder', data: { role: 'chapter_vice_president' } },
  { id: FOUNDER_UID, data: { role: 'founder_patron' } },
];

function applyWhere(rows: Row[], where: any[] | undefined): Row[] {
  if (!where) return rows;
  return rows.filter((r) =>
    where.every(([field, op, value]: any[]) => {
      if ((field === '__name__' || field === 'id') && op === 'in') return (value as string[]).includes(r.id);
      if ((field === '__name__' || field === 'id') && op === '==') return r.id === value;
      if (op === '==') return r.data[field] === value;
      return true;
    }),
  );
}



const mockAdapter = {
  getDoc: async () => null,
  listDocs: async (collection: string, options: any) => {
    if (mockSupa.shouldFail) throw new Error('mock adapter failure (Supabase unavailable)');
    let rows = collection === 'users' ? supaUserRows : supaRoleRows;
    if (collection === 'users' && mockSupa.omitProbeFromFullList && !options?.where) {
      rows = rows.filter((r) => r.id !== 'zz-probe');
    }
    const matched = applyWhere(rows, options?.where);
    const limited = options?.limit !== undefined ? matched.slice(0, options.limit) : matched;
    return limited.map((r) => ({ id: r.id, ...r.data }));
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

// Minimal Firestore mock: flag-ON scenarios must not need it, but the
// route still resolves permissions/identity through these modules.
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


// Contact doorway (contact-gating fix, 2026-10-28): the route no
// longer reads contact fields from user records. Fixture addresses
// are served as gated CONTACT records - derived from the fixture
// rows with the real pickContactFields - and the exact-email probe
// resolves through Firebase Auth, mocked here over the same fixture
// rows. mockAuthEmailLookups records every Auth probe lookup.
const mockAuthEmailLookups: string[] = [];

jest.mock('@/lib/server/user-contact', () => {
  const shared = jest.requireActual('@/lib/user-contact-shared');
  return {
    ...shared,
    getUserContacts: async (_db: any, uids: string[]) => {
      const map = new Map<string, any>();
      for (const r of supaUserRows) {
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
      mockAuthEmailLookups.push(email);
      const row = supaUserRows.find((r: any) => r.data.email === email);
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
  process.env.SUPA_SURFACES = 'users';
  setUsersSupaAdapterForTests(mockAdapter as any);
  mockSupa.enabled = true;
  mockSupa.clientConfigured = true;
  mockSupa.shouldFail = false;
  mockSupa.omitProbeFromFullList = false;
  state.authContext = { userId: 'admin-global', role: 'superadmin' };
  state.canManage = true;
});

afterAll(() => {
  delete process.env.SUPA_SURFACES;
  resetUsersSupaAdapterForTests();
});

describe('G1 flag-ON Supa directory', () => {
  it('searchMethod reports "supabase" on Path B and Path A (DECISIONS.md pin)', async () => {
    const b = await getJson('?q=match&pageSize=5');
    expect(b.res.status).toBe(200);
    expect(b.body.searchMethod).toBe('supabase');

    const a = await getJson('?pageSize=3');
    expect(a.res.status).toBe(200);
    expect(a.body.searchMethod).toBe('supabase');
    expect(a.body.users).toHaveLength(3);
    expect(a.body.users.map((u: any) => u.uid)).toEqual(['a001', 'a002', 'a003']);
  });

  it('name search searches the FULL set: a user whose doc id sorts beyond position 60 is found', async () => {
    const { res, body } = await getJson('?q=zebra');
    expect(res.status).toBe(200);
    expect(body.users.map((u: any) => u.uid)).toEqual(['zz-late']);
    // And a common term scores all 75 matches, not the 60-doc window.
    const all = await getJson('?q=match&pageSize=20');
    expect(all.body.debug.totalScored).toBe(75);
  });

  it('role filter returns the EXACT holder set (roles-store + mirror holders, both beyond any window)', async () => {
    const { res, body } = await getJson('?role=chapter_vice_president');
    expect(res.status).toBe(200);
    expect(body.searchMethod).toBe('supabase');
    expect(body.users.map((u: any) => u.uid).sort()).toEqual(['z-holder', 'z-mirror']);
    expect(body.debug.totalScored).toBe(2);
    const holder = body.users.find((u: any) => u.uid === 'z-holder');
    expect(holder.role).toBe('chapter_vice_president');
  });

  it('founder alias slugs resolve to the founder alone on the Supa path', async () => {
    for (const slug of ['president_national', 'superadmin', 'founder_patron']) {
      const { body } = await getJson(`?role=${slug}`);
      expect(body.users.map((u: any) => u.uid)).toEqual([FOUNDER_UID]);
    }
  });

  it('exact-email probe parity: an exact address resolves even when the full-list read omits the doc', async () => {
    mockSupa.omitProbeFromFullList = true;
    const { res, body } = await getJson('?q=probe@example.com');
    expect(res.status).toBe(200);
    expect(body.searchMethod).toBe('supabase');
    expect(body.users.map((u: any) => u.uid)).toEqual(['zz-probe']);
    expect(body.users[0].email).toBe('probe@example.com');
  });

  it('adapter error falls back to Firestore (served response is not a Supa response)', async () => {
    mockSupa.shouldFail = true;
    const { res, body } = await getJson('?q=match&pageSize=5');
    expect(res.status).toBe(200);
    // The minimal Firestore mock holds no users: the fallback path
    // served an empty Firestore result, NOT the Supa set.
    expect(body.searchMethod).toBe('native_firestore');
    expect(body.users).toEqual([]);
  });
});
