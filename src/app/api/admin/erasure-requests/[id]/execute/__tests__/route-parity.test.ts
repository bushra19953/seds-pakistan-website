/**
 * @jest-environment node
 *
 * Family B parity test for POST /api/admin/erasure-requests/[id]/execute
 * (B14; canManageUsers). No pre-existing suite covered this route.
 *
 * A holder whose PRIMARY role is `member` with the key granted via a
 * custom role in additionalRoles (contracts K2) passes the gate (the
 * erasure executor itself is stubbed — the gate is the subject here);
 * an expired grant and a missing grant keep the original 403 body.
 *
 * The REAL @/lib/server/permissions resolver runs against FakeFirestore.
 * Auth, firebase-admin and the erasure executor deps are mocked. Auth
 * mocks use the real shape (userId, NOT uid; nested token at user.user).
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

jest.mock('@/lib/retention/server-deps', () => ({
  createErasureDeps: jest.fn(() => ({})),
}));

jest.mock('@/lib/retention/erasure', () => ({
  executeErasure: jest.fn(async () => ({ erased: true })),
  ERASURE_PROMISE_TEXT: 'stub',
}));

import { NextRequest } from 'next/server';
import { createFakeDb, type FakeDb } from '@/lib/server/__tests__/fake-firestore';
import { POST } from '../route';

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
}

function req() {
  return new NextRequest('http://localhost/api/admin/erasure-requests/req-1/execute', {
    method: 'POST',
  });
}

const ctx = { params: { id: 'req-1' } };

beforeEach(() => {
  jest.clearAllMocks();
  state.authResult = authFor(HOLDER);
  mockDbHolder.db = createFakeDb();
});

describe('B14 POST /api/admin/erasure-requests/[id]/execute parity', () => {
  it('custom canManageUsers holder passes the gate and executes', async () => {
    seedHolder(mockDbHolder.db as FakeDb);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it('expired grant is denied with the original 403 body', async () => {
    seedHolder(mockDbHolder.db as FakeDb, true);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('no grant is denied unchanged', async () => {
    (mockDbHolder.db as FakeDb).seed('roles', HOLDER, { role: 'member' });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });
});
