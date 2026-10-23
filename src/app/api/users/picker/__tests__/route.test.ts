/**
 * @jest-environment node
 *
 * Tests for GET /api/users/picker (Item 6, spec 6(f)): the sanitised
 * picker that replaces client-side users lists for non-privileged
 * callers once the Batch 1 rules land.
 */

import { NextRequest } from 'next/server';

type Row = { id: string; data: Record<string, any> };

const state = {
  authResult: { authenticated: false } as any,
};

const userRows: Row[] = [
  { id: 'u-ayesha', data: { displayName: 'Ayesha Khan', email: 'ayesha@secret.example', whatsapp: '03001111111', points: 42, role: 'member', chapterId: 'seds-ist-chapter', photoURL: 'https://x/y.jpg', isOnVacation: false } },
  { id: 'u-bilal', data: { displayName: 'Bilal Ahmed', email: 'bilal@secret.example', whatsappNumber: '03002222222', points: 7, role: 'member', chapterId: 'seds-ist-chapter', additionalRoles: ['custom_events_helper', 42] } },
  { id: 'u-zara', data: { displayName: 'Zara Sheikh', email: 'zara@secret.example', whatsapp: '03009999999', points: 3, role: 'chair_design', chapterId: 'seds-other-chapter', vacationMode: true, additionalRoles: ['custom_mirror_only'] } },
  { id: 'u-norole', data: { displayName: 'No Role Person', email: 'norole@secret.example', chapterId: 'seds-ist-chapter', additionalRoles: 'custom_not_an_array' } },
];

const roleRows: Row[] = [
  { id: 'u-ayesha', data: { role: 'member', additionalRoles: ['custom_poster_team_lead'] } },
  // Zara's roles doc deliberately differs from her users mirror:
  // the roles doc must win (roles-first resolution).
  { id: 'u-zara', data: { role: 'president_chapter', additionalRoles: ['custom_design_helper'] } },
];

function makeUsersChain(filters: Array<[string, any]> = []): any {
  const chain: any = {
    where: (f: string, _op: string, v: any) => makeUsersChain([...filters, [f, v]]),
    get: async () => {
      const matched = userRows.filter((r) => filters.every(([f, v]) => r.data[f] === v));
      return {
        docs: matched.map((r) => ({ id: r.id, data: () => ({ ...r.data }) })),
        size: matched.length,
        empty: matched.length === 0,
      };
    },
  };
  return chain;
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'users') return makeUsersChain();
    if (name === 'roles') {
      return {
        where: (_f: string, _op: string, values: string[]) => ({
          get: async () => {
            const matched = roleRows.filter((r) => values.includes(r.id));
            return {
              docs: matched.map((r) => ({ id: r.id, data: () => ({ ...r.data }) })),
              size: matched.length,
              empty: matched.length === 0,
            };
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
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

import { GET } from '@/app/api/users/picker/route';

function req(qs = '') {
  return new NextRequest(`http://localhost/api/users/picker${qs}`);
}

beforeEach(() => {
  state.authResult = {
    authenticated: true,
    user: { userId: 'u-ayesha', role: 'member' },
  };
  jest.clearAllMocks();
});

describe('GET /api/users/picker (Item 6)', () => {
  it('1. unauthenticated: 401', async () => {
    state.authResult = { authenticated: false, error: 'Unauthorized' };
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('2. plain member: 200 with exactly the allowlisted fields and no contact/points data anywhere in the payload', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toHaveLength(4);
    for (const row of body.users) {
      expect(Object.keys(row).sort()).toEqual(
        ['additionalRoles', 'chapterId', 'displayName', 'isOnVacation', 'photoURL', 'role', 'uid'].sort()
      );
    }
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('@secret.example');
    expect(raw).not.toContain('03001111111');
    expect(raw).not.toContain('03002222222');
    expect(raw).not.toContain('03009999999');
    expect(raw).not.toContain('whatsapp');
    expect(raw).not.toContain('points');
  });

  it('3. q filters by displayName substring; chapterId filters; limit slices', async () => {
    const byQ = await (await GET(req('?q=kh'))).json();
    // 'kh' matches Khan AND Sheikh; sorted by displayName.
    expect(byQ.users.map((u: any) => u.uid)).toEqual(['u-ayesha', 'u-zara']);

    const shortQ = await (await GET(req('?q=k'))).json();
    expect(shortQ.users).toHaveLength(0);

    const byChapter = await (await GET(req('?chapterId=seds-other-chapter'))).json();
    expect(byChapter.users.map((u: any) => u.uid)).toEqual(['u-zara']);

    const limited = await (await GET(req('?limit=2'))).json();
    expect(limited.users).toHaveLength(2);

    const hugeLimit = await (await GET(req('?limit=5000'))).json();
    expect(hugeLimit.users).toHaveLength(4);
  });

  it('4. role comes from the roles doc when it differs from the users mirror', async () => {
    const body = await (await GET(req('?q=zara'))).json();
    expect(body.users[0].role).toBe('president_chapter');
    expect(body.users[0].isOnVacation).toBe(true);
  });

  it('5. no roles doc: falls back to the mirror; neither: role null, no error', async () => {
    const body = await (await GET(req('?q=bilal'))).json();
    expect(body.users[0].role).toBe('member');

    const noRole = await (await GET(req('?q=role'))).json();
    const person = noRole.users.find((u: any) => u.uid === 'u-norole');
    expect(person).toBeDefined();
    expect(person.role).toBeNull();
  });
});

describe('GET /api/users/picker additionalRoles (Custom Roles consumers, Surface 2)', () => {
  it('6. roles doc with additionalRoles: the entry carries them', async () => {
    const body = await (await GET(req('?q=ayesha'))).json();
    const person = body.users.find((u: any) => u.uid === 'u-ayesha');
    expect(person).toBeDefined();
    expect(person.additionalRoles).toEqual(['custom_poster_team_lead']);
  });

  it('7. roles-first precedence: the roles doc additionalRoles beat the users mirror, primary unchanged', async () => {
    const body = await (await GET(req('?q=zara'))).json();
    const person = body.users.find((u: any) => u.uid === 'u-zara');
    expect(person).toBeDefined();
    expect(person.role).toBe('president_chapter');
    expect(person.additionalRoles).toEqual(['custom_design_helper']);
    expect(person.additionalRoles).not.toContain('custom_mirror_only');
  });

  it('8. no roles doc: additionalRoles fall back to the users mirror, entries coerced to strings', async () => {
    const body = await (await GET(req('?q=bilal'))).json();
    const person = body.users.find((u: any) => u.uid === 'u-bilal');
    expect(person).toBeDefined();
    expect(person.additionalRoles).toEqual(['custom_events_helper', '42']);
  });

  it('9. non-array additionalRoles are ignored; an entry with neither source returns an empty array', async () => {
    const body = await (await GET(req('?q=role'))).json();
    const person = body.users.find((u: any) => u.uid === 'u-norole');
    expect(person).toBeDefined();
    expect(person.additionalRoles).toEqual([]);
  });

  it('10. every entry always carries additionalRoles as an array', async () => {
    const body = await (await GET(req())).json();
    expect(body.users).toHaveLength(4);
    for (const row of body.users) {
      expect(Array.isArray(row.additionalRoles)).toBe(true);
    }
  });
});
