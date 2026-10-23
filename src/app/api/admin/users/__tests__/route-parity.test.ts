/**
 * @jest-environment node
 *
 * Family A parity tests (permission-parity fix program, inventory
 * sites A1 + A2): GET /api/admin/users and POST
 * /api/admin/users/restore-workload must admit a caller whose PRIMARY
 * role is the plain catalog role `member` when the caller holds an
 * unexpired custom grant carrying the gate key in `additionalRoles`
 * (the live step-3 failure shape), deny the same caller when that
 * grant is expired, and deny a caller with no grant with the route's
 * original denial body.
 *
 * End-to-end style: the REAL hasServerPermissionForUser runs against
 * a FakeFirestore seeded with roles/{uid}, users/{uid} and
 * roleDefinitions/{slug} docs. Auth mocks use the real
 * verifyAuthentication shape: userId (NOT uid) at the top level, the
 * decoded token nested at user.user.
 */

import { NextRequest } from 'next/server';

const CALLER = 'parity-caller';
const CUSTOM = 'custom_verify_design_aide';

const holder: { db: any } = { db: null };

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => new Date(),
    delete: () => ({ __fieldDelete: true }),
  },
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => holder.db,
  ensureAdminInitialized: () => true,
  admin: {},
}));

const authShape = () => ({
  authenticated: true,
  user: {
    user: {
      uid: CALLER,
      email: 'caller@example.com',
      displayName: 'Parity Caller',
      emailVerified: true,
    },
    userId: CALLER,
    email: 'caller@example.com',
    displayName: 'Parity Caller',
    emailVerified: true,
    role: 'member',
  },
});

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => authShape()),
  withAuth: jest.fn(async (_req: any, handler: any) =>
    handler({ userId: CALLER, role: 'member' }),
  ),
}));

import { createFakeDb } from '@/lib/server/__tests__/fake-firestore';
import { GET as usersGET } from '@/app/api/admin/users/route';
import { POST as restorePOST } from '@/app/api/admin/users/restore-workload/route';

type Grant = 'active' | 'expired' | 'none';

function seed(grant: Grant) {
  const db = createFakeDb();
  const rolesDoc: Record<string, unknown> = { role: 'member' };
  if (grant !== 'none') {
    rolesDoc.additionalRoles = [CUSTOM];
    db.seed('roleDefinitions', CUSTOM, {
      isCustom: true,
      permissions: ['canManageUsers'],
    });
  }
  if (grant === 'expired') {
    rolesDoc.expiresAt = new Date(Date.now() - 60_000);
    rolesDoc.expiresRoleKey = CUSTOM;
  }
  db.seed('roles', CALLER, rolesDoc);
  db.seed('users', CALLER, {
    displayName: 'Parity Caller',
    email: 'caller@example.com',
    role: 'member',
  });
  holder.db = db;
  return db;
}

function restoreReq() {
  return new NextRequest('http://localhost/api/admin/users/restore-workload', {
    method: 'POST',
    body: JSON.stringify({ uid: 'target-1' }),
    headers: { 'content-type': 'application/json' },
  });
}

describe('A1: GET /api/admin/users holder-scoped gate (canManageUsers)', () => {
  it('admits a member whose unexpired custom grant carries canManageUsers', async () => {
    seed('active');
    const res = await usersGET(new NextRequest('http://localhost/api/admin/users'));
    expect(res.status).toBe(200);
  });

  it('denies the same holder when the custom grant is expired, with the original 403 body', async () => {
    seed('expired');
    const res = await usersGET(new NextRequest('http://localhost/api/admin/users'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Unauthorized: Insufficient permissions to view users.',
    });
  });

  it('denies a member with no custom grant, unchanged', async () => {
    seed('none');
    const res = await usersGET(new NextRequest('http://localhost/api/admin/users'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Unauthorized: Insufficient permissions to view users.',
    });
  });
});

describe('A2: POST /api/admin/users/restore-workload holder-scoped gate (canManageUsers)', () => {
  it('admits a member whose unexpired custom grant carries canManageUsers', async () => {
    seed('active');
    const res = await restorePOST(restoreReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.restoredCount).toBe(0);
  });

  it('denies the same holder when the custom grant is expired, with the original 403 body', async () => {
    seed('expired');
    const res = await restorePOST(restoreReq());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Forbidden: Insufficient permissions to restore workload',
    });
  });

  it('denies a member with no custom grant, unchanged', async () => {
    seed('none');
    const res = await restorePOST(restoreReq());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Forbidden: Insufficient permissions to restore workload',
    });
  });
});
