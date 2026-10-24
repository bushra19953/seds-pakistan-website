/**
 * @jest-environment node
 *
 * FIXED (adoption wave, pack 26 / GOV-05): POST /api/admin/partners/analyze
 * now gates with hasServerPermissionForUser(getDb(), uid,
 * 'canManageSponsorsPartners'), matching its sibling routes. The old
 * 1-arg resolveUserRole deny-all composition is gone: every holder of
 * the key (catalog role, Firestore grant, or unexpired custom grant)
 * reaches the AI layer; non-holders still 403 before it.
 *
 * These tests use the REAL permissions module against an in-memory
 * FakeFirestore (only the session and AI seams are mocked), so the
 * holder / non-holder / founder outcomes describe production behaviour.
 */

jest.mock('@/lib/auth/verifySession', () => ({
  extractBearerToken: (req: { headers: { get(name: string): string | null } }) => {
    const header = req.headers.get('authorization');
    return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  },
  verifyIdTokenString: jest.fn(async (token: string) => ({ uid: token })),
}));

const mockDbHolder: { db: unknown } = { db: null };
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
import { createFakeDb, type FakeDb } from '@/lib/server/__tests__/fake-firestore';
import { FOUNDER_UID } from '@/lib/roles';

const mockAI = executeWithFailover as jest.Mock;
const CUSTOM = 'custom_verify_design_aide';

function req(uid: string) {
  return new NextRequest('http://localhost/api/admin/partners/analyze', {
    method: 'POST',
    headers: { authorization: `Bearer ${uid}` },
    body: JSON.stringify({ partnerId: 'p-1', agreementText: 'Agreement text' }),
  });
}

function seedCustomGrant(db: FakeDb, uid: string, permissions: string[], expired = false) {
  db.seed('roles', uid, {
    role: 'member',
    additionalRoles: [CUSTOM],
    ...(expired
      ? { expiresAt: new Date(Date.now() - 60_000), expiresRoleKey: CUSTOM }
      : {}),
  });
  db.seed('roleDefinitions', CUSTOM, { isCustom: true, permissions });
}

beforeEach(() => {
  jest.clearAllMocks();
  const db = createFakeDb();
  db.seed('sponsors_partners', 'p-1', { organizationName: 'Partner One' });
  mockDbHolder.db = db;
});

describe('FIXED: partners/analyze gates on canManageSponsorsPartners (holder-scoped)', () => {
  it('a canManageSponsorsPartners holder via custom grant passes and reaches the AI layer (200)', async () => {
    const db = mockDbHolder.db as FakeDb;
    seedCustomGrant(db, 'holder-1', ['canManageSponsorsPartners']);
    const res = await POST(req('holder-1'));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(mockAI).toHaveBeenCalledTimes(1);
  });

  it('a catalog holder (founder_patron primary) passes (200)', async () => {
    const db = mockDbHolder.db as FakeDb;
    db.seed('roles', 'patron-1', { role: 'founder_patron' });
    const res = await POST(req('patron-1'));
    expect(res.status).toBe(200);
    expect(mockAI).toHaveBeenCalledTimes(1);
  });

  it('the Founder passes (200)', async () => {
    const db = mockDbHolder.db as FakeDb;
    db.seed('roles', FOUNDER_UID, { role: 'founder_patron' });
    const res = await POST(req(FOUNDER_UID));
    expect(res.status).toBe(200);
    expect(mockAI).toHaveBeenCalledTimes(1);
  });

  it('a non-holder gets 403 Forbidden and the AI layer is never reached', async () => {
    const db = mockDbHolder.db as FakeDb;
    db.seed('roles', 'member-1', { role: 'member' });
    const res = await POST(req('member-1'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(mockAI).not.toHaveBeenCalled();
  });

  it('an expired custom grant gets 403 and the AI layer is never reached', async () => {
    const db = mockDbHolder.db as FakeDb;
    seedCustomGrant(db, 'expired-1', ['canManageSponsorsPartners'], true);
    const res = await POST(req('expired-1'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(mockAI).not.toHaveBeenCalled();
  });

  it('a custom grant for a DIFFERENT key gets 403', async () => {
    const db = mockDbHolder.db as FakeDb;
    seedCustomGrant(db, 'other-key-1', ['canManageMeetings']);
    const res = await POST(req('other-key-1'));
    expect(res.status).toBe(403);
    expect(mockAI).not.toHaveBeenCalled();
  });

  it('no token still gets 401 Sign in required', async () => {
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
