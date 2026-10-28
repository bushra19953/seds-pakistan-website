/**
 * @jest-environment node
 *
 * Permission gate + contact doorway for GET
 * /api/v1/users/certificate-eligible (contact-gating fix,
 * 2026-10-28).
 *
 * Before the fix this route required only a valid ID token and
 * returned every user's email — any signed-in user could dump the
 * full directory's addresses. It now carries the certificates
 * surface's standing gate (hasServerPermissionForUser with
 * 'canManageCertificates', the same check as certificates/issue,
 * certificates/bulk-issue and certificates/[id]):
 *
 *  1. An unprivileged caller gets 403 and no user data.
 *  2. A privileged caller gets the rows, with emails resolved
 *     through the gated contact records (the mocked doorway), never
 *     from the user doc — the fixtures carry a stale doc email as a
 *     trap, and the displayName fallback no longer uses email.
 *  3. Email search matches against the resolved addresses.
 */

import { NextRequest } from 'next/server';

type Row = { id: string; data: Record<string, any> };

const mockState = {
  canManageCertificates: false,
  usersGets: 0,
};

// u-nodocname carries a stale doc email as a trap: neither the row
// email nor the displayName may come from it.
const userRows: Row[] = [
  { id: 'u-1', data: { displayName: 'Ayesha Khan', role: 'member', chapterId: 'ch-1' } },
  { id: 'u-nodocname', data: { email: 'stale-doc@example.com', role: 'member', chapterId: 'ch-1' } },
];
const roleRows: Row[] = [];
const chapterRows: Row[] = [{ id: 'ch-1', data: { name: 'IST Chapter' } }];

const mockContactEmails: Record<string, string> = {
  'u-1': 'ayesha@example.com',
  'u-nodocname': 'resolved@example.com',
};

function snapOf(rows: Row[]) {
  const docs = rows.map((r) => ({ id: r.id, data: () => ({ ...r.data }) }));
  return {
    docs,
    size: docs.length,
    empty: docs.length === 0,
    forEach: (fn: (d: any) => void) => docs.forEach(fn),
  };
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'users') {
      return {
        orderBy: () => ({
          get: async () => {
            mockState.usersGets++;
            return snapOf(userRows);
          },
        }),
      };
    }
    if (name === 'roles') return { get: async () => snapOf(roleRows) };
    if (name === 'chapters') return { get: async () => snapOf(chapterRows) };
    throw new Error(`unexpected collection: ${name}`);
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() => mockDb),
  admin: {
    auth: () => ({
      verifyIdToken: async (_token: string) => ({ uid: 'caller-1' }),
    }),
  },
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => mockState.canManageCertificates),
}));

jest.mock('@/lib/server/user-contact', () => {
  const shared = jest.requireActual('@/lib/user-contact-shared');
  return {
    ...shared,
    resolveUserEmails: async (_db: any, uids: string[]) => {
      const map = new Map<string, string>();
      for (const uid of uids) {
        const email = mockContactEmails[uid];
        if (email) map.set(uid, email);
      }
      return map;
    },
  };
});

import { GET } from '@/app/api/v1/users/certificate-eligible/route';

function req(qs = '') {
  return new NextRequest(`http://localhost/api/v1/users/certificate-eligible${qs}`, {
    headers: { authorization: 'Bearer test-token' },
  });
}

beforeEach(() => {
  mockState.canManageCertificates = false;
  mockState.usersGets = 0;
});

describe('GET /api/v1/users/certificate-eligible gate', () => {
  it('1. unprivileged caller gets 403 and the directory is never read', async () => {
    const res = await GET(req());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden: insufficient privileges');
    expect(body.users).toBeUndefined();
    expect(mockState.usersGets).toBe(0);
  });

  it('2. privileged caller gets rows whose emails come from the contact doorway, not the doc', async () => {
    mockState.canManageCertificates = true;
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    const byUid = new Map(body.users.map((u: any) => [u.uid, u]));
    const first: any = byUid.get('u-1');
    expect(first.email).toBe('ayesha@example.com');
    const trap: any = byUid.get('u-nodocname');
    expect(trap.email).toBe('resolved@example.com');
    // The displayName fallback dropped its email arm entirely.
    expect(trap.displayName).toBe('Unknown');
    expect(JSON.stringify(body)).not.toContain('stale-doc@example.com');
  });

  it('3. email search matches against the resolved addresses', async () => {
    mockState.canManageCertificates = true;
    const res = await GET(req('?q=resolved@example.com'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.map((u: any) => u.uid)).toEqual(['u-nodocname']);
  });
});
