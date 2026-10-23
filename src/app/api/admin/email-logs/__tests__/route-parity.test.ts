/**
 * @jest-environment node
 *
 * Family B parity tests for /api/admin/email-logs (B11 GET, B12 POST;
 * canViewEmailLogs — POST reuses the view key on purpose, per the
 * in-code comment, and the conversion keeps that key).
 *
 * A holder whose PRIMARY role is `member` with the key granted via a
 * custom role in additionalRoles (contracts K2) is admitted; an expired
 * grant and a missing grant keep the original 403 bodies.
 *
 * The REAL @/lib/server/permissions resolver runs against FakeFirestore.
 * Only auth, firebase-admin and the mailer are mocked. Auth mocks use
 * the real shape (userId, NOT uid; nested token at user.user).
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

jest.mock('@/lib/mailer', () => ({
  getEmailQuotaStatus: jest.fn(() => ({ used: 0, limit: 100 })),
  sendEmailNotification: jest.fn(async () => ({ success: true })),
}));

import { NextRequest } from 'next/server';
import { createFakeDb, type FakeDb } from '@/lib/server/__tests__/fake-firestore';
import { GET, POST } from '../route';

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
    permissions: ['canViewEmailLogs'],
  });
  db.seed('email_logs', 'log-1', { to: 'a@b.co', sentAt: new Date('2026-10-01T00:00:00Z') });
}

beforeEach(() => {
  jest.clearAllMocks();
  state.authResult = authFor(HOLDER);
  mockDbHolder.db = createFakeDb();
});

describe('B11 GET /api/admin/email-logs parity', () => {
  it('custom canViewEmailLogs holder can read email logs', async () => {
    seedHolder(mockDbHolder.db as FakeDb);
    const res = await GET(new NextRequest('http://localhost/api/admin/email-logs'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logs).toHaveLength(1);
  });

  it('expired grant is denied with the original 403 body', async () => {
    seedHolder(mockDbHolder.db as FakeDb, true);
    const res = await GET(new NextRequest('http://localhost/api/admin/email-logs'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Forbidden: Insufficient permissions to view email logs',
    });
  });

  it('no grant is denied unchanged', async () => {
    (mockDbHolder.db as FakeDb).seed('roles', HOLDER, { role: 'member' });
    const res = await GET(new NextRequest('http://localhost/api/admin/email-logs'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Forbidden: Insufficient permissions to view email logs',
    });
  });
});

describe('B12 POST /api/admin/email-logs parity (view key reused)', () => {
  function postReq() {
    return new NextRequest('http://localhost/api/admin/email-logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'admin@example.test' }),
    });
  }

  it('custom canViewEmailLogs holder can send a test email', async () => {
    seedHolder(mockDbHolder.db as FakeDb);
    const res = await POST(postReq());
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it('expired grant is denied with the original POST 403 body', async () => {
    seedHolder(mockDbHolder.db as FakeDb, true);
    const res = await POST(postReq());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Forbidden: Insufficient permissions to send test emails',
    });
  });
});
