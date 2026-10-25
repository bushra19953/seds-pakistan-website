/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION CONTRACTS for GET /api/users/picker.
 *
 * Pins the CURRENT Firestore behaviour at the HTTP surface so the
 * migrated implementation can prove byte-identical responses. Extends
 * route.test.ts (allowlist, roles-first, additionalRoles) and
 * route-cache.test.ts (per-chapter build caching); this file adds the
 * migration-facing contracts: exact body shape, byte-identical repeat
 * responses, cache TTL expiry, limit clamping edges, error bodies,
 * and flag/fallback equivalence.
 *
 * SEAM ASSUMPTIONS (the seam does not exist in this tree yet):
 *  1. The migrated route consults the adapter through '@/lib/supa'
 *     (useSupa(surface) + getSupaClient() + getSupaAdapter()); the
 *     mock below is registered via the relative specifier that
 *     resolves to the same src/lib/supa location, because the '@/
 *     moduleNameMapper rewrites the alias before virtual-mock
 *     resolution.
 *  2. The surface name is unknown ('picker' / 'users-picker' /
 *     'directory' are all plausible); the mock answers from
 *     test-controlled state for ANY surface name.
 *  3. Adapter error or unconfigured client => Firestore fallback with
 *     a response identical to flag OFF.
 *
 * In THIS tree the route never imports the seam, so the mock is inert
 * and every scenario exercises the Firestore path being pinned.
 */

import { NextRequest } from 'next/server';

type Row = { id: string; data: Record<string, any> };

const mockSupa = {
  enabled: false,
  clientConfigured: true,
};

jest.mock(
  '../../../../../lib/supa',
  () => ({
    useSupa: jest.fn(() => mockSupa.enabled),
    parseSupaSurfaces: jest.fn(() => new Set()),
    getSupaClient: jest.fn(() => (mockSupa.clientConfigured ? { __mockSupaClient: true } : null)),
    getSupaAdapter: jest.fn(() => {
      const fail = async () => {
        throw new Error('mock adapter failure (Supabase unavailable)');
      };
      return { getDoc: fail, listDocs: fail, countDocs: fail, setDoc: fail, updateDoc: fail, deleteDoc: fail };
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

const state = {
  authResult: { authenticated: true, user: { userId: 'u-ayesha', role: 'member' } } as any,
  dbAvailable: true,
  usersGets: 0,
  rolesGets: 0,
};

const IST = 'seds-ist-chapter';
const OTHER = 'seds-other-chapter';

const userRows: Row[] = [
  { id: 'u-ayesha', data: { displayName: 'Ayesha Khan', role: 'member', chapterId: IST, photoURL: 'https://x/a.jpg' } },
  { id: 'u-bilal', data: { displayName: 'Bilal Ahmed', role: 'member', chapterId: IST } },
  { id: 'u-zara', data: { displayName: 'Zara Sheikh', role: 'chair_design', chapterId: OTHER, vacationMode: true } },
];

const roleRows: Row[] = [
  { id: 'u-zara', data: { role: 'president_chapter', additionalRoles: [] } },
];

function makeUsersChain(filters: Array<[string, any]> = []): any {
  return {
    where: (f: string, _op: string, v: any) => makeUsersChain([...filters, [f, v]]),
    get: async () => {
      state.usersGets++;
      const matched = userRows.filter((r) => filters.every(([f, v]) => r.data[f] === v));
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
            state.rolesGets++;
            const matched = roleRows.filter((r) => values.includes(r.id));
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
  state.authResult = { authenticated: true, user: { userId: 'u-ayesha', role: 'member' } };
  state.dbAvailable = true;
  mockSupa.enabled = false;
  mockSupa.clientConfigured = true;
  jest.clearAllMocks();
});

describe('GET /api/users/picker migration contracts: body shape + byte identity', () => {
  it('the body has exactly one top-level key, users', async () => {
    const body = await (await GET(req('?chapterId=shape-chapter'))).json();
    expect(Object.keys(body)).toEqual(['users']);
  });

  it('two identical calls return byte-identical bodies (second call serves the cache)', async () => {
    const first = await GET(req('?chapterId=byte-chapter'));
    const firstText = await first.text();
    const getsAfterFirst = state.usersGets;

    const second = await GET(req('?chapterId=byte-chapter'));
    const secondText = await second.text();

    expect(secondText).toBe(firstText);
    expect(state.usersGets).toBe(getsAfterFirst);
  });

  it('rows are sorted by displayName (localeCompare) in the response', async () => {
    const body = await (await GET(req('?chapterId=sort-chapter-none'))).json();
    // chapterId 'sort-chapter-none' matches nobody via the where filter
    // in production Firestore; this mock applies the same filter, so
    // use the unfiltered cache key space instead:
    expect(body.users).toEqual([]);
    const all = await (await GET(req(''))).json();
    expect(all.users.map((u: any) => u.displayName)).toEqual(['Ayesha Khan', 'Bilal Ahmed', 'Zara Sheikh']);
  });
});

describe('GET /api/users/picker migration contracts: cache keying + TTL', () => {
  it('cache is keyed by the chapterId filter: an unfiltered build never leaks into a chapter-filtered response and vice versa', async () => {
    const all = await (await GET(req('?chapterId='))).json();
    expect(all.users).toHaveLength(3);

    const istOnly = await (await GET(req(`?chapterId=${IST}`))).json();
    expect(istOnly.users.map((u: any) => u.uid).sort()).toEqual(['u-ayesha', 'u-bilal']);

    const otherOnly = await (await GET(req(`?chapterId=${OTHER}`))).json();
    expect(otherOnly.users.map((u: any) => u.uid)).toEqual(['u-zara']);
    expect(otherOnly.users[0].role).toBe('president_chapter');
  });

  it('the cache expires after the 5-minute TTL: a call past the TTL rebuilds from Firestore', async () => {
    const chapter = 'ttl-chapter';
    await GET(req(`?chapterId=${chapter}`));
    const getsAfterBuild = state.usersGets;

    const nowSpy = jest.spyOn(Date, 'now');
    try {
      const realNow = Date.now();
      nowSpy.mockReturnValue(realNow + 5 * 60 * 1000 + 1);
      await GET(req(`?chapterId=${chapter}`));
      expect(state.usersGets).toBe(getsAfterBuild + 1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('q and limit are per-request over the cached rows: different q/limit share one build', async () => {
    const chapter = 'perreq-chapter';
    const full = await (await GET(req(`?chapterId=${chapter}&limit=1000`))).json();
    const getsAfterBuild = state.usersGets;
    const byQ = await (await GET(req(`?chapterId=${chapter}&q=zzz-no-match`))).json();
    expect(byQ.users).toEqual([]);
    expect(state.usersGets).toBe(getsAfterBuild);
    expect(full.users).toEqual([]);
  });
});

describe('GET /api/users/picker migration contracts: params + errors', () => {
  it('limit clamps: 0 and negatives become 1; a non-numeric limit falls back to the default page', async () => {
    const zero = await (await GET(req('?limit=0'))).json();
    expect(zero.users).toHaveLength(1);
    const negative = await (await GET(req('?limit=-5'))).json();
    expect(negative.users).toHaveLength(1);
    const nan = await (await GET(req('?limit=abc'))).json();
    expect(nan.users).toHaveLength(3);
  });

  it('q is trimmed and case-insensitive; a 1-char q returns an empty list (not an error)', async () => {
    const padded = await (await GET(req('?q=%20KH%20'))).json();
    expect(padded.users.map((u: any) => u.uid)).toEqual(['u-ayesha', 'u-zara']);
    const short = await GET(req('?q=k'));
    expect(short.status).toBe(200);
    expect(await short.json()).toEqual({ users: [] });
  });

  it('unauthenticated: 401 with the exact body { error: "Unauthorized" }', async () => {
    state.authResult = { authenticated: false, error: 'no token' };
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('database unavailable: 500 with the exact body { error: "Database unavailable" }', async () => {
    state.dbAvailable = false;
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Database unavailable' });
  });
});

describe('GET /api/users/picker migration contracts: flag / fallback equivalence', () => {
  const scenarios: Array<[string, () => void]> = [
    ['flag OFF (Firestore serves)', () => { mockSupa.enabled = false; }],
    ['flag ON + adapter error (Firestore fallback)', () => { mockSupa.enabled = true; }],
    ['flag ON + Supabase client unconfigured (Firestore fallback)', () => { mockSupa.enabled = true; mockSupa.clientConfigured = false; }],
  ];

  for (const [label, setup] of scenarios) {
    it(`${label}: response is identical to the pinned baseline`, async () => {
      setup();
      const res = await GET(req(`?chapterId=${OTHER}`));
      expect(res.status).toBe(200);
      const body = await res.json();
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
  }
});
