/**
 * @jest-environment node
 *
 * Email + role search for GET /api/users/picker (Zubair requirement,
 * 2026-10-26; audit TS-P30).
 *
 * The picker's placeholder has always promised "search by name or
 * email", but the route never serialized email and q matched
 * displayName only, so email search found nobody and same-name people
 * were indistinguishable. These tests pin the fix:
 *
 *  - q matches displayName (unchanged), email (substring + exact), and
 *    role (primary slug, display phrase, and additionalRoles).
 *  - Email is SERIALIZED only for unmask-privileged callers
 *    (canUnmaskContacts: chairs / presidents / executives, the same
 *    gate /api/users/search uses). Plain members keep the exact
 *    pre-fix payload: no email key anywhere.
 *  - Search MATCHING is not gated (mirrors /api/users/search): a
 *    member who types an email finds the person; they just do not
 *    see the address.
 */

import { NextRequest } from 'next/server';

type Row = { id: string; data: Record<string, any> };

const state = {
  authResult: { authenticated: false } as any,
};

// Two users share the display name "Ahmed Khan" on purpose: telling
// them apart is the whole point of this suite.
// Contact-gating fix (2026-10-28): the addresses live in the gated
// CONTACT records (mockContactEmails, served through the mocked
// doorway below), NOT on the user docs - the docs carry no email at
// all. u-ahmed-1's doc keeps a legacy whatsapp field as a trap: the
// picker must never serialize it, for anyone.
const mockContactEmails: Record<string, string> = {
  'u-ahmed-1': 'ahmed.khan@sedsmail.example',
  'u-ahmed-2': 'a.khan.chapter@sedsmail.example',
  'u-ayesha': 'ayesha@sedsmail.example',
  'u-bilal': 'bilal@sedsmail.example',
  'u-zara': 'zara@sedsmail.example',
};

const userRows: Row[] = [
  { id: 'u-ahmed-1', data: { displayName: 'Ahmed Khan', whatsapp: '03001111111', role: 'member', chapterId: 'seds-ist-chapter' } },
  { id: 'u-ahmed-2', data: { displayName: 'Ahmed Khan', role: 'member', chapterId: 'seds-ist-chapter' } },
  { id: 'u-ayesha', data: { displayName: 'Ayesha Khan', role: 'member', chapterId: 'seds-ist-chapter' } },
  { id: 'u-bilal', data: { displayName: 'Bilal Ahmed', role: 'member', chapterId: 'seds-ist-chapter' } },
  { id: 'u-zara', data: { displayName: 'Zara Sheikh', role: 'chair_design', chapterId: 'seds-other-chapter' } },
];

jest.mock('@/lib/server/user-contact', () => {
  const shared = jest.requireActual('@/lib/user-contact-shared');
  return {
    ...shared,
    getUserContacts: async (_db: any, uids: string[]) => {
      const map = new Map<string, any>();
      for (const uid of uids) {
        const email = mockContactEmails[uid];
        if (email) map.set(uid, { email, email_lowercase: email.toLowerCase() });
      }
      return map;
    },
  };
});

const roleRows: Row[] = [
  { id: 'u-ahmed-2', data: { role: 'chapter_events_chair', additionalRoles: [] } },
  { id: 'u-ayesha', data: { role: 'member', additionalRoles: ['custom_poster_team_lead'] } },
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

function asCaller(role: string) {
  state.authResult = { authenticated: true, user: { userId: 'u-caller', role } };
}

beforeEach(() => {
  asCaller('member');
  jest.clearAllMocks();
});

describe('picker email serialization (unmask gate)', () => {
  it('1. unmask-privileged caller receives email on every row; same-name rows carry distinct emails', async () => {
    asCaller('chapter_president');
    const body = await (await GET(req())).json();
    expect(body.users).toHaveLength(5);
    for (const row of body.users) {
      expect(typeof row.email).toBe('string');
      expect(row.email).toContain('@');
    }
    const ahmeds = body.users.filter((u: any) => u.displayName === 'Ahmed Khan');
    expect(ahmeds).toHaveLength(2);
    expect(ahmeds.map((u: any) => u.email).sort()).toEqual([
      'a.khan.chapter@sedsmail.example',
      'ahmed.khan@sedsmail.example',
    ]);
  });

  it('1b. the founder role is unmask-privileged too', async () => {
    asCaller('founder_patron');
    const body = await (await GET(req('?q=zara'))).json();
    expect(body.users).toHaveLength(1);
    expect(body.users[0].email).toBe('zara@sedsmail.example');
  });

  it('2. plain member: payload is byte-compatible with the pre-fix allowlist (no email key, no address anywhere)', async () => {
    const body = await (await GET(req())).json();
    expect(body.users).toHaveLength(5);
    for (const row of body.users) {
      expect(Object.keys(row).sort()).toEqual(
        ['additionalRoles', 'chapterId', 'displayName', 'isOnVacation', 'photoURL', 'role', 'uid'].sort()
      );
    }
    expect(JSON.stringify(body)).not.toContain('@sedsmail.example');
  });
});

describe('picker q: email matching', () => {
  it('3. q matches an email substring', async () => {
    asCaller('chapter_president');
    const body = await (await GET(req('?q=ahmed.khan@'))).json();
    expect(body.users.map((u: any) => u.uid)).toEqual(['u-ahmed-1']);
  });

  it('4. q matches a full email exactly, picking the right same-name person', async () => {
    asCaller('chapter_president');
    const body = await (await GET(req('?q=a.khan.chapter@sedsmail.example'))).json();
    expect(body.users.map((u: any) => u.uid)).toEqual(['u-ahmed-2']);
    expect(body.users[0].email).toBe('a.khan.chapter@sedsmail.example');
  });

  it('5. member caller can FIND by email via q, but the address stays hidden', async () => {
    const body = await (await GET(req('?q=zara@sedsmail'))).json();
    expect(body.users.map((u: any) => u.uid)).toEqual(['u-zara']);
    expect(body.users[0]).not.toHaveProperty('email');
  });
});

describe('picker q: role matching', () => {
  it('6. q matches a primary role held via the roles doc (roles-first)', async () => {
    const body = await (await GET(req('?q=president'))).json();
    expect(body.users.map((u: any) => u.uid)).toEqual(['u-zara']);
  });

  it('7. q matches a multi-word role phrase (spaced slug / display title)', async () => {
    const body = await (await GET(req('?q=events%20chair'))).json();
    expect(body.users.map((u: any) => u.uid)).toEqual(['u-ahmed-2']);
  });

  it('8. q matches a role held only in additionalRoles', async () => {
    const body = await (await GET(req('?q=poster'))).json();
    expect(body.users.map((u: any) => u.uid)).toEqual(['u-ayesha']);
  });

  it('9. q matches an additionalRoles slug written with spaces', async () => {
    const body = await (await GET(req('?q=poster%20team'))).json();
    expect(body.users.map((u: any) => u.uid)).toEqual(['u-ayesha']);
  });
});

describe('picker q: name regression', () => {
  it('10. name substring search is unchanged', async () => {
    const body = await (await GET(req('?q=khan'))).json();
    expect(body.users.map((u: any) => u.uid)).toEqual(['u-ahmed-1', 'u-ahmed-2', 'u-ayesha']);
  });
});
