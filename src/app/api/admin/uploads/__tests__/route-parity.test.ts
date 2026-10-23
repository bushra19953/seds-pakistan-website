/**
 * @jest-environment node
 *
 * Family B parity test for GET /api/admin/uploads (B17; canViewUploads).
 * This was a D-PAIR site: the resolveUserRole derivation existed solely
 * for the gate and is gone. No pre-existing suite covered this route.
 *
 * A holder whose PRIMARY role is `member` with the key granted via a
 * custom role in additionalRoles (contracts K2) is admitted; an expired
 * grant and a missing grant keep the original 403 body.
 *
 * The REAL @/lib/server/permissions resolver runs against FakeFirestore.
 * Only the session verifier and firebase-admin are mocked.
 */

const HOLDER = 'holder-1';
const CUSTOM = 'custom_verify_design_aide';

jest.mock('@/lib/auth/verifySession', () => ({
  extractBearerToken: jest.fn(() => 'test-token'),
  verifyIdTokenString: jest.fn(async () => ({ uid: HOLDER })),
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDbHolder.db,
  admin: {
    firestore: {
      FieldValue: { serverTimestamp: () => 'ts', delete: () => 'del' },
    },
  },
}));

import { NextRequest } from 'next/server';
import { createFakeDb, type FakeDb } from '@/lib/server/__tests__/fake-firestore';
import { GET } from '../route';

function seedHolder(db: FakeDb, expired = false) {
  db.seed('roles', HOLDER, {
    role: 'member',
    additionalRoles: [CUSTOM],
    ...(expired
      ? { expiresAt: new Date(Date.now() - 60_000), expiresRoleKey: CUSTOM }
      : {}),
  });
  db.seed('roleDefinitions', CUSTOM, {
    isCustom: true,
    permissions: ['canViewUploads'],
  });
  db.seed('upload_logs', 'up-1', {
    userId: HOLDER,
    fileName: 'proof.png',
    status: 'completed',
    uploadedAt: new Date('2026-10-01T00:00:00Z'),
  });
}

function req() {
  return new NextRequest('http://localhost/api/admin/uploads', {
    headers: { authorization: 'Bearer test-token' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDbHolder.db = createFakeDb();
});

describe('B17 GET /api/admin/uploads parity', () => {
  it('custom canViewUploads holder can read upload logs', async () => {
    seedHolder(mockDbHolder.db as FakeDb);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.uploads).toHaveLength(1);
  });

  it('expired grant is denied with the original 403 body', async () => {
    seedHolder(mockDbHolder.db as FakeDb, true);
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('no grant is denied unchanged', async () => {
    (mockDbHolder.db as FakeDb).seed('roles', HOLDER, { role: 'member' });
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });
});
