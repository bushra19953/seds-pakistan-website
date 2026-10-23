/**
 * @jest-environment node
 *
 * Family B parity test for GET /api/admin/erasure-requests (B13;
 * canManageUsers). No pre-existing suite covered this route.
 *
 * A holder whose PRIMARY role is `member` with the key granted via a
 * custom role in additionalRoles (contracts K2) is admitted; an expired
 * grant and a missing grant keep the original 403 body.
 *
 * The REAL @/lib/server/permissions resolver runs against FakeFirestore.
 * Only auth and firebase-admin are mocked. Auth mocks use the real
 * shape (userId, NOT uid; nested token at user.user).
 */

const HOLDER = 'holder-1';
const CUSTOM = 'custom_verify_design_aide';

const state = {
  authResult: null as any,
};

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
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

function authFor(uid: string) {
  return {
    authenticated: true,
    user: {
      user: { uid },
      userId: uid,
      email: 'holder@example.test',
      displayName: 'Holder One',
      emailVerified: true,
      role: 'member',
    },
  };
}

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
    permissions: ['canManageUsers'],
  });
  db.seed('erasure_requests', 'req-1', { requestedAt: new Date('2026-10-01T00:00:00Z') });
}

beforeEach(() => {
  jest.clearAllMocks();
  state.authResult = authFor(HOLDER);
  mockDbHolder.db = createFakeDb();
});

describe('B13 GET /api/admin/erasure-requests parity', () => {
  it('custom canManageUsers holder can read the erasure queue', async () => {
    seedHolder(mockDbHolder.db as FakeDb);
    const res = await GET(new NextRequest('http://localhost/api/admin/erasure-requests'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requests).toHaveLength(1);
  });

  it('expired grant is denied with the original 403 body', async () => {
    seedHolder(mockDbHolder.db as FakeDb, true);
    const res = await GET(new NextRequest('http://localhost/api/admin/erasure-requests'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('no grant is denied unchanged', async () => {
    (mockDbHolder.db as FakeDb).seed('roles', HOLDER, { role: 'member' });
    const res = await GET(new NextRequest('http://localhost/api/admin/erasure-requests'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });
});
