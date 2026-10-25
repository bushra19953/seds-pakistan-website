/**
 * @jest-environment node
 *
 * Read-burn F2 regression: GET /api/users/picker caches its projected
 * rows server-side per chapterId filter (5-min TTL, the /api/admin/users
 * directory pattern). Repeat calls inside the window must not re-read
 * the users collection or the roles overlay; q and limit are applied
 * per request against the cached rows.
 */

import { NextRequest } from 'next/server';

const counters = { usersGets: 0, rolesGets: 0 };

const userRows = [
  { id: 'u-ayesha', data: { displayName: 'Ayesha Khan', role: 'member', chapterId: 'seds-ist-chapter' } },
  { id: 'u-bilal', data: { displayName: 'Bilal Ahmed', role: 'member', chapterId: 'seds-ist-chapter' } },
  { id: 'u-zara', data: { displayName: 'Zara Sheikh', role: 'chair_design', chapterId: 'seds-other-chapter' } },
];

const roleRows = [
  { id: 'u-zara', data: { role: 'president_chapter', additionalRoles: [] } },
];

function makeUsersChain(filters: Array<[string, any]> = []): any {
  return {
    where: (f: string, _op: string, v: any) => makeUsersChain([...filters, [f, v]]),
    get: async () => {
      counters.usersGets += 1;
      const matched = userRows.filter((r) => filters.every(([f, v]) => (r.data as any)[f] === v));
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
            counters.rolesGets += 1;
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
  getDb: jest.fn(() => mockDb),
  ensureAdminInitialized: jest.fn(() => true),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => ({
    authenticated: true,
    user: { userId: 'u-ayesha', role: 'member' },
  })),
}));

import { GET } from '@/app/api/users/picker/route';

function req(qs = '') {
  return new NextRequest(`http://localhost/api/users/picker${qs}`);
}

describe('GET /api/users/picker server cache (read-burn F2)', () => {
  it('repeat calls within the TTL reuse one build; q/limit still apply per request', async () => {
    const first = await (await GET(req('?limit=1000'))).json();
    expect(first.users).toHaveLength(3);
    expect(counters.usersGets).toBe(1);
    const rolesGetsAfterFirst = counters.rolesGets;
    expect(rolesGetsAfterFirst).toBeGreaterThan(0);

    const second = await (await GET(req('?limit=1000'))).json();
    expect(second.users).toHaveLength(3);
    expect(counters.usersGets).toBe(1);
    expect(counters.rolesGets).toBe(rolesGetsAfterFirst);

    const byQ = await (await GET(req('?q=zara'))).json();
    expect(byQ.users.map((u: any) => u.uid)).toEqual(['u-zara']);
    expect(byQ.users[0].role).toBe('president_chapter');

    const limited = await (await GET(req('?limit=1'))).json();
    expect(limited.users).toHaveLength(1);

    // Still no further Firestore work after all those calls.
    expect(counters.usersGets).toBe(1);
    expect(counters.rolesGets).toBe(rolesGetsAfterFirst);
  });

  it('a different chapterId filter builds (and caches) separately', async () => {
    const before = counters.usersGets;
    const byChapter = await (await GET(req('?chapterId=seds-other-chapter'))).json();
    expect(byChapter.users.map((u: any) => u.uid)).toEqual(['u-zara']);
    expect(counters.usersGets).toBe(before + 1);

    const again = await (await GET(req('?chapterId=seds-other-chapter'))).json();
    expect(again.users).toHaveLength(1);
    expect(counters.usersGets).toBe(before + 1);
  });
});
