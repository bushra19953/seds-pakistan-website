/**
 * @jest-environment node
 *
 * CHARACTERIZATION — FOUND-NOT-FIXED (coordinator adaptation of plan
 * 4.3b). Both sourcing inquiry routes resolve the caller's role
 * through resolveUserRole(uid) (1-arg, deny-all -> always null) and
 * gate on isSuperAdmin(role, uid). Same partially-masked shape as
 * organizations: the Founder UID passes today via isSuperAdmin's UID
 * arm; every stored-role superadmin-class holder always 403s because
 * their role is never resolved.
 *
 * These routes are in the coordinator's withheld set; the tests pin
 * their CURRENT behaviour as documentation, using the REAL
 * permissions and roles modules (only session, db and mailer seams
 * are mocked). The [id] route's authorizeSourcing helper is shared by
 * PATCH and POST, and both are pinned through PATCH. When a future
 * program repairs the routes, update these tests in the same change.
 */

jest.mock('@/lib/auth/verifySession', () => ({
  extractBearerToken: (req: { headers: { get(name: string): string | null } }) => {
    const header = req.headers.get('authorization');
    return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  },
  verifyIdTokenString: jest.fn(async (token: string) => ({ uid: token })),
}));

const mockDbHolder: { db: unknown } = {
  db: {
    collection: (name: string) => ({
      get: async () => ({ docs: [] }),
      orderBy: () => ({
        limit: () => ({ get: async () => ({ docs: [] }) }),
        get: async () => ({ docs: [] }),
      }),
      limit: () => ({ get: async () => ({ docs: [] }) }),
      doc: (id: string) => ({
        get: async () => ({ exists: false, id, data: () => undefined }),
        update: jest.fn(async () => undefined),
      }),
    }),
  },
};
jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDbHolder.db,
  admin: {},
}));

jest.mock('@/lib/mailer', () => ({
  sendRawEmail: jest.fn(async () => undefined),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/sourcing/inquiries/route';
import { PATCH } from '@/app/api/sourcing/inquiries/[id]/route';
import { FOUNDER_UID } from '@/lib/roles';

function getReq(uid: string) {
  return new NextRequest('http://localhost/api/sourcing/inquiries', {
    headers: { authorization: `Bearer ${uid}` },
  });
}

function patchReq(uid: string) {
  return new NextRequest('http://localhost/api/sourcing/inquiries/inq-1', {
    method: 'PATCH',
    headers: { authorization: `Bearer ${uid}` },
    body: JSON.stringify({ status: 'quoted' }),
  });
}

const patchParams = { params: Promise.resolve({ id: 'inq-1' }) };

describe('CHARACTERIZATION (found-not-fixed): sourcing inquiries role resolution', () => {
  it('GET: the Founder UID passes today (masked defect) and reaches the (empty) list', async () => {
    const res = await GET(getReq(FOUNDER_UID));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, inquiries: [], count: 0 });
  });

  it('GET: a non-founder caller always 403s, because the stored role is never resolved', async () => {
    const res = await GET(getReq('superadmin-holder-1'));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Forbidden');
  });

  it('PATCH [id]: the Founder UID passes authorizeSourcing and reaches the record lookup (404 for a missing inquiry)', async () => {
    const res = await PATCH(patchReq(FOUNDER_UID), patchParams);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Inquiry not found');
  });

  it('PATCH [id]: a non-founder caller always 403s with the route body', async () => {
    const res = await PATCH(patchReq('superadmin-holder-1'), patchParams);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Forbidden: sourcing management only');
  });
});
