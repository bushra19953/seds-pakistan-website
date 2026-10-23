/**
 * @jest-environment node
 *
 * Family B parity tests for /api/admin/bug-reports (B5 GET, B6 PATCH,
 * B7 DELETE; canManageBugReports). These were D-PAIR sites: the
 * resolveUserRole derivation existed solely for the gate and is gone;
 * the gate is now hasServerPermissionForUser(getDb(), callerUid, key).
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
      FieldValue: {
        serverTimestamp: () => 'ts',
        delete: () => 'del',
        arrayUnion: (v: unknown) => ({ __arrayUnion: v }),
        increment: (n: number) => ({ __increment: n }),
      },
    },
  },
}));

import { NextRequest } from 'next/server';
import {
  createFakeDb,
  FakeDocRef,
  type FakeDb,
} from '@/lib/server/__tests__/fake-firestore';
import { GET, PATCH, DELETE } from '../route';

// FakeDb's FakeDocRef has no delete(); the DELETE handler needs one.
if (!(FakeDocRef.prototype as any).delete) {
  (FakeDocRef.prototype as any).delete = async function (this: FakeDocRef) {
    (this.db as any).store.get(this.collectionPath)?.delete(this.id);
  };
}

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
    permissions: ['canManageBugReports'],
  });
  db.seed('bug_reports', 'r1', { status: 'open', createdAt: new Date('2026-10-01T00:00:00Z') });
}

beforeEach(() => {
  jest.clearAllMocks();
  state.authResult = authFor(HOLDER);
  mockDbHolder.db = createFakeDb();
});

describe('B5 GET /api/admin/bug-reports parity', () => {
  it('custom canManageBugReports holder can list reports', async () => {
    seedHolder(mockDbHolder.db as FakeDb);
    const res = await GET(new NextRequest('http://localhost/api/admin/bug-reports'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
  });

  it('expired grant is denied with the original 403 body', async () => {
    seedHolder(mockDbHolder.db as FakeDb, true);
    const res = await GET(new NextRequest('http://localhost/api/admin/bug-reports'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Permission denied' });
  });

  it('no grant is denied unchanged', async () => {
    (mockDbHolder.db as FakeDb).seed('roles', HOLDER, { role: 'member' });
    const res = await GET(new NextRequest('http://localhost/api/admin/bug-reports'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Permission denied' });
  });
});

describe('B6 PATCH /api/admin/bug-reports parity', () => {
  it('custom holder can update a report', async () => {
    seedHolder(mockDbHolder.db as FakeDb);
    const res = await PATCH(
      new NextRequest('http://localhost/api/admin/bug-reports', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportId: 'r1', status: 'resolved' }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it('expired grant is denied with the original 403 body', async () => {
    seedHolder(mockDbHolder.db as FakeDb, true);
    const res = await PATCH(
      new NextRequest('http://localhost/api/admin/bug-reports', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportId: 'r1', status: 'resolved' }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Permission denied' });
  });
});

describe('B7 DELETE /api/admin/bug-reports parity', () => {
  it('custom holder can delete a report', async () => {
    seedHolder(mockDbHolder.db as FakeDb);
    const res = await DELETE(
      new NextRequest('http://localhost/api/admin/bug-reports?reportId=r1', { method: 'DELETE' }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it('no grant is denied unchanged', async () => {
    (mockDbHolder.db as FakeDb).seed('roles', HOLDER, { role: 'member' });
    const res = await DELETE(
      new NextRequest('http://localhost/api/admin/bug-reports?reportId=r1', { method: 'DELETE' }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Permission denied' });
  });
});
