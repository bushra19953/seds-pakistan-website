/**
 * @jest-environment node
 *
 * CHARACTERIZATION — FOUND-NOT-FIXED (coordinator adaptation of plan
 * 4.3b). POST /api/organizations resolves the caller's role through
 * resolveUserRole(uid) (1-arg, deny-all -> always null) and gates on
 * isSuperAdmin(role, uid). The defect is PARTIALLY MASKED here:
 * isSuperAdmin checks the founder UID first, so the Founder passes
 * today, while every stored-role superadmin-class holder (a stored
 * founder_patron / superadmin who is not the founder UID) always 403s
 * because their role is never resolved.
 *
 * The route is in the coordinator's withheld set; these tests pin its
 * CURRENT behaviour as documentation, using the REAL permissions and
 * roles modules (only the session and db seams are mocked). When a
 * future program repairs the route, update these tests in the same
 * change.
 */

jest.mock('@/lib/auth/verifySession', () => ({
  extractBearerToken: (req: { headers: { get(name: string): string | null } }) => {
    const header = req.headers.get('authorization');
    return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  },
  verifyIdTokenString: jest.fn(async (token: string) => ({ uid: token })),
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({
    collection: () => ({
      doc: () => ({ set: jest.fn(async () => undefined) }),
      add: jest.fn(async () => ({ id: 'org-1' })),
    }),
  }),
  admin: {},
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/organizations/route';
import { FOUNDER_UID } from '@/lib/roles';

function req(uid: string, body: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/organizations', {
    method: 'POST',
    headers: { authorization: `Bearer ${uid}` },
    body: JSON.stringify(body),
  });
}

describe('CHARACTERIZATION (found-not-fixed): organizations POST role resolution', () => {
  it('the Founder UID passes the auth gate today (masked defect) and reaches body validation: 400, not 403', async () => {
    const res = await POST(req(FOUNDER_UID, {}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Name and logo URL are required');
  });

  it('a non-founder caller always 403s, because the stored role is never resolved (1-arg deny-all)', async () => {
    const res = await POST(req('superadmin-holder-1', { name: 'Org', logoUrl: 'https://x/logo.png' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Forbidden');
  });

  it('an ordinary member gets the identical 403', async () => {
    const res = await POST(req('member-1', { name: 'Org', logoUrl: 'https://x/logo.png' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Forbidden');
  });

  it('no token still gets 401 Sign in required (that part works)', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/organizations', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(401);
  });
});
