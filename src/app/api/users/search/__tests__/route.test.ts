/**
 * @jest-environment node
 *
 * RBT2 item 3 pins for GET /api/users/search (Firestore fallback arm
 * of the seam build):
 *  - the old .limit(100) cap is gone: a user past position 100 in
 *    the directory can match;
 *  - the row build (users get + resolveUserEmails) runs ONCE and is
 *    then served from the route's 5-minute module cache, not
 *    ~200 reads per keystroke call;
 *  - the response shape and the canUnmaskContacts email gate are
 *    unchanged, and the gate is applied per request (not baked into
 *    the cached rows): an unprivileged caller finds a person by
 *    email but sees email: null, a privileged caller sees it.
 * All Firestore/Auth access is mocked; no live reads.
 */

import { NextRequest } from 'next/server';

const IST = 'seds-ist-chapter';

type Row = { id: string; data: Record<string, any> };

const fillerRows: Row[] = Array.from({ length: 110 }, (_, i) => {
  const n = String(i + 1).padStart(3, '0');
  return {
    id: `a${n}`,
    data: { displayName: `Filler Person ${n}`, role: 'member', chapterId: IST, photoURL: null, managerId: null },
  };
});

const fixtureRows: Row[] = [
  ...fillerRows,
  { id: 'zz-late', data: { displayName: 'Zebra Late', displayRole: 'Chapter Member', role: 'member', chapterId: IST, photoURL: 'http://x/z.png', managerId: 'a001' } },
  { id: 'zz-exact', data: { displayName: 'Exact Person', role: 'member', chapterId: 'seds-other-chapter' } },
];

const emailsById: Record<string, string> = {
  'zz-late': 'zebra@example.com',
  'zz-exact': 'exact@example.com',
  a001: 'filler001@example.com',
};

const counters = { usersGets: 0, emailResolutions: 0 };

const mockDb = {
  collection: (name: string) => {
    if (name !== 'users') throw new Error(`unexpected collection: ${name}`);
    return {
      get: async () => {
        counters.usersGets += 1;
        return { docs: fixtureRows.map((r) => ({ id: r.id, data: () => ({ ...r.data }) })) };
      },
    };
  },
};

const caller = { role: 'member' };

// See route-rbt2-directory.test.ts: the '@/lib/supa' gate is mocked
// (env-driven) because @supabase/supabase-js is not installed in this
// tree; with SUPA_SURFACES unset the seam correctly reports no
// adapter and this suite exercises the Firestore build arm.
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
    user: { userId: 'caller-1', role: caller.role },
  })),
}));

jest.mock('@/lib/server/user-contact', () => ({
  resolveUserEmails: async (_db: any, uids: string[]) => {
    counters.emailResolutions += 1;
    const map = new Map<string, string>();
    for (const uid of uids) {
      if (emailsById[uid]) map.set(uid, emailsById[uid]);
    }
    return map;
  },
}));

import { GET } from '@/app/api/users/search/route';

function req(qs = '') {
  return new NextRequest(`http://localhost/api/users/search${qs}`);
}

describe('GET /api/users/search (RBT2 seam build + 5-min cache)', () => {
  it('a query shorter than 2 chars returns no users and triggers no build', async () => {
    const body = await (await GET(req('?q=z'))).json();
    expect(body).toEqual({ users: [] });
    expect(counters.usersGets).toBe(0);
    expect(counters.emailResolutions).toBe(0);
  });

  it('finds a user beyond the old 100-doc cap, with the pinned shape and the email gate applied', async () => {
    caller.role = 'member';
    const { status, body } = await (async () => {
      const res = await GET(req(`?q=zebra&chapterId=${IST}`));
      return { status: res.status, body: await res.json() };
    })();
    expect(status).toBe(200);
    expect(counters.usersGets).toBe(1);
    expect(counters.emailResolutions).toBe(1);
    expect(body.users).toHaveLength(1);
    const hit = body.users[0];
    expect(Object.keys(hit).sort()).toEqual(
      ['chapterId', 'displayName', 'email', 'exactMatch', 'id', 'isInChapter', 'managerId', 'photoURL', 'role'].sort(),
    );
    expect(hit).toEqual({
      id: 'zz-late',
      displayName: 'Zebra Late',
      // Unprivileged caller: address was used for matching, never serialized.
      email: null,
      photoURL: 'http://x/z.png',
      role: 'Chapter Member',
      chapterId: IST,
      managerId: 'a001',
      isInChapter: true,
      exactMatch: false,
    });
  });

  it('repeat calls reuse the cached build (no new users get, no new email resolution)', async () => {
    const body = await (await GET(req('?q=filler&chapterId=all'))).json();
    expect(body.users).toHaveLength(10);
    expect(counters.usersGets).toBe(1);
    expect(counters.emailResolutions).toBe(1);
  });

  it('the email gate is per-request: a privileged caller sees the address from the same cached rows', async () => {
    caller.role = 'chapter_events_chair';
    const body = await (await GET(req(`?q=zebra@example.com&chapterId=${IST}`))).json();
    expect(body.users).toHaveLength(1);
    expect(body.users[0].id).toBe('zz-late');
    expect(body.users[0].email).toBe('zebra@example.com');
    expect(body.users[0].exactMatch).toBe(true);
    expect(counters.usersGets).toBe(1);
    caller.role = 'member';
  });
});
