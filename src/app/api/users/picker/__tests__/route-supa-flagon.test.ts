/**
 * @jest-environment node
 *
 * FLAG-ON tests for the G2 Supa picker path: rows are built through
 * the adapter (full filtered set, roles-first overlay), and an
 * adapter error falls back to the Firestore build with an identical
 * response shape. All access is mocked; no live reads.
 */

import { NextRequest } from 'next/server';

type Row = { id: string; data: Record<string, any> };

const IST = 'seds-ist-chapter';
const OTHER = 'seds-other-chapter';

const mockSupa = {
  enabled: true,
  clientConfigured: true,
  shouldFail: false,
};

const supaUserRows: Row[] = [
  { id: 'u-ayesha', data: { displayName: 'Ayesha Khan', role: 'member', chapterId: IST, photoURL: 'https://x/a.jpg' } },
  { id: 'u-bilal', data: { displayName: 'Bilal Ahmed', role: 'member', chapterId: IST } },
  { id: 'u-zara', data: { displayName: 'Zara Sheikh', role: 'chair_design', chapterId: OTHER, vacationMode: true } },
];

const supaRoleRows: Row[] = [
  { id: 'u-zara', data: { role: 'president_chapter', additionalRoles: [] } },
];

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
    if (mockSupa.shouldFail) throw new Error('mock adapter failure (Supabase unavailable)');
    const rows = collection === 'users' ? supaUserRows : supaRoleRows;
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

const state = {
  authResult: { authenticated: true, user: { userId: 'u-ayesha', role: 'member' } } as any,
  dbAvailable: true,
};

// Firestore fallback fixtures mirror the Supa fixtures so the fallback
// response can be compared byte-for-byte with the Supa response.
function makeUsersChain(filters: Array<[string, any]> = []): any {
  return {
    where: (f: string, _op: string, v: any) => makeUsersChain([...filters, [f, v]]),
    get: async () => {
      const matched = supaUserRows.filter((r) => filters.every(([f, v]) => r.data[f] === v));
      return { docs: matched.map((r) => ({ id: r.id, data: () => ({ ...r.data }) })) };
    },
  };
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'users') return makeUsersChain();
    if (name === 'roles') {
      return {
        where: (_f: string, _op: string, values: string[]) => ({
          get: async () => {
            const matched = supaRoleRows.filter((r) => values.includes(r.id));
            return { docs: matched.map((r) => ({ id: r.id, data: () => ({ ...r.data }) })) };
          },
        }),
      };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => (state.dbAvailable ? mockDb : null)),
  ensureAdminInitialized: jest.fn(() => true),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

import { GET } from '@/app/api/users/picker/route';

function req(qs = '') {
  return new NextRequest(`http://localhost/api/users/picker${qs}`);
}

beforeEach(() => {
  process.env.SUPA_SURFACES = 'users';
  setUsersSupaAdapterForTests(mockAdapter as any);
  state.authResult = { authenticated: true, user: { userId: 'u-ayesha', role: 'member' } };
  state.dbAvailable = true;
  mockSupa.enabled = true;
  mockSupa.clientConfigured = true;
  mockSupa.shouldFail = false;
});

afterAll(() => {
  delete process.env.SUPA_SURFACES;
  resetUsersSupaAdapterForTests();
});

describe('G2 flag-ON Supa picker', () => {
  it('serves rows through the adapter with roles-first overlay (roles doc beats users mirror)', async () => {
    const body = await (await GET(req(`?chapterId=${OTHER}`))).json();
    expect(body).toEqual({
      users: [
        {
          uid: 'u-zara',
          displayName: 'Zara Sheikh',
          photoURL: null,
          chapterId: OTHER,
          role: 'president_chapter',
          additionalRoles: [],
          isOnVacation: true,
        },
      ],
    });
  });

  it('unfiltered Supa build returns all rows sorted by displayName; q filters per request', async () => {
    const all = await (await GET(req(''))).json();
    expect(all.users.map((u: any) => u.displayName)).toEqual(['Ayesha Khan', 'Bilal Ahmed', 'Zara Sheikh']);
    const byQ = await (await GET(req('?q=kh'))).json();
    expect(byQ.users.map((u: any) => u.uid)).toEqual(['u-ayesha', 'u-zara']);
  });

  it('adapter error falls back to the Firestore build with an identical response', async () => {
    mockSupa.shouldFail = true;
    const res = await GET(req('?chapterId=fallback-chapter'));
    expect(res.status).toBe(200);
    const body = await res.json();
    // 'fallback-chapter' matches nobody in either backend.
    expect(body).toEqual({ users: [] });

    mockSupa.shouldFail = false;
    const supaBody = await (await GET(req(`?chapterId=${IST}`))).json();
    mockSupa.shouldFail = true;
    // IST rows were built (and cached) by the Supa build above; a
    // failing adapter on a cold chapter still serves Firestore rows.
    const cold = await (await GET(req('?chapterId=fallback-chapter-2'))).json();
    expect(cold).toEqual({ users: [] });
    expect(supaBody.users.map((u: any) => u.uid).sort()).toEqual(['u-ayesha', 'u-bilal']);
  });
});
