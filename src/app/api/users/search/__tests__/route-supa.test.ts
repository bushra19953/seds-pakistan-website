/**
 * @jest-environment node
 *
 * RBT2 item 3, Supa arm: GET /api/users/search serves from the
 * users-directory seam (supaListAllUsers) when the adapter is
 * available — zero Firestore users gets — and still resolves emails
 * once per 5-minute build through the contact doorway.
 * All adapter and Firestore access is mocked; no live reads.
 */

import { NextRequest } from 'next/server';

type Row = { id: string; data: Record<string, any> };

const supaRows: Row[] = [
  { id: 's-1', data: { displayName: 'Seam Person One', role: 'member', chapterId: 'seds-ist-chapter' } },
  { id: 's-2', data: { displayName: 'Seam Person Two', role: 'member', chapterId: 'seds-ist-chapter' } },
];

const counters = { usersGets: 0, emailResolutions: 0, listDocsCalls: 0 };

const mockAdapter = {
  getDoc: async () => null,
  listDocs: async (collection: string, _options: any) => {
    if (collection !== 'users') return [];
    counters.listDocsCalls += 1;
    return supaRows.map((r) => ({ id: r.id, ...r.data }));
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
    if (name !== 'users') throw new Error(`unexpected collection: ${name}`);
    return {
      get: async () => {
        counters.usersGets += 1;
        return { docs: [] };
      },
    };
  },
};

// See route-rbt2-directory.test.ts: the '@/lib/supa' gate is mocked
// (env-driven) because @supabase/supabase-js is not installed in this
// tree; the seam code and its test-adapter injection run real.
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
  verifyAuthentication: jest.fn(async () => ({
    authenticated: true,
    user: { userId: 'caller-1', role: 'member' },
  })),
}));

jest.mock('@/lib/server/user-contact', () => ({
  resolveUserEmails: async (_db: any, uids: string[]) => {
    counters.emailResolutions += 1;
    const map = new Map<string, string>();
    uids.forEach((uid) => map.set(uid, `${uid}@example.com`));
    return map;
  },
}));

import { GET } from '@/app/api/users/search/route';

function req(qs = '') {
  return new NextRequest(`http://localhost/api/users/search${qs}`);
}

beforeEach(() => {
  process.env.SUPA_SURFACES = 'users';
  setUsersSupaAdapterForTests(mockAdapter as any);
});

afterAll(() => {
  delete process.env.SUPA_SURFACES;
  resetUsersSupaAdapterForTests();
});

describe('GET /api/users/search (RBT2 Supa seam arm)', () => {
  it('serves from the seam with no Firestore users get, and caches the build across calls', async () => {
    const first = await (await GET(req('?q=seam&chapterId=all'))).json();
    expect(first.users.map((u: any) => u.id)).toEqual(['s-1', 's-2']);
    expect(counters.usersGets).toBe(0);
    expect(counters.listDocsCalls).toBe(1);
    expect(counters.emailResolutions).toBe(1);

    const second = await (await GET(req('?q=two&chapterId=all'))).json();
    expect(second.users.map((u: any) => u.id)).toEqual(['s-2']);
    // Cached build: no second seam read, no second email resolution.
    expect(counters.listDocsCalls).toBe(1);
    expect(counters.emailResolutions).toBe(1);
    expect(counters.usersGets).toBe(0);
  });
});
