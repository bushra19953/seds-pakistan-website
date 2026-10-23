/**
 * @jest-environment node
 *
 * CHARACTERIZATION — FOUND-NOT-FIXED (coordinator adaptation of plan
 * 4.3b). POST /api/admin/partners/analyze composes resolveUserRole(uid)
 * (1-arg, deny-all) with hasServerPermission, so its permission check
 * can NEVER pass: every authenticated caller, the Founder included,
 * gets 403 {error:"Forbidden"} and the AI layer is never reached.
 *
 * This file is deliberately NOT on the fixed path: the route is in the
 * coordinator's withheld set, and these tests pin its CURRENT behaviour
 * as documentation. They use the REAL permissions module (only the
 * session, db and AI seams are mocked) so the pin describes production
 * behaviour, not a mock. When a future program repairs the route,
 * update these tests in the same change.
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
    collection: () => ({
      doc: () => ({ update: jest.fn(async () => undefined) }),
    }),
  },
};
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  admin: {},
}));

jest.mock('@/lib/ai/key-manager', () => ({
  executeWithFailover: jest.fn(async () => ({ key_clauses: [] })),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/admin/partners/analyze/route';
import { executeWithFailover } from '@/lib/ai/key-manager';
import { FOUNDER_UID } from '@/lib/roles';

const mockAI = executeWithFailover as jest.Mock;

function req(uid: string) {
  return new NextRequest('http://localhost/api/admin/partners/analyze', {
    method: 'POST',
    headers: { authorization: `Bearer ${uid}` },
    body: JSON.stringify({ partnerId: 'p-1', agreementText: 'Agreement text' }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('CHARACTERIZATION (found-not-fixed): partners/analyze denies everyone', () => {
  it('the Founder UID gets 403 Forbidden and the AI layer is never reached', async () => {
    const res = await POST(req(FOUNDER_UID));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(mockAI).not.toHaveBeenCalled();
  });

  it('any other authenticated caller gets the identical 403 Forbidden', async () => {
    const res = await POST(req('patron-2'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(mockAI).not.toHaveBeenCalled();
  });

  it('no token still gets 401 Sign in required (that part works)', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/admin/partners/analyze', {
        method: 'POST',
        body: JSON.stringify({ partnerId: 'p-1', agreementText: 'x' }),
      }),
    );
    expect(res.status).toBe(401);
    expect(mockAI).not.toHaveBeenCalled();
  });
});
