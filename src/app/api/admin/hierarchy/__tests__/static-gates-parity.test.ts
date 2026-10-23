/**
 * @jest-environment node
 *
 * Family A parity tests (permission-parity fix program, inventory
 * sites A6-A13): the hierarchy routes and the depart/reinstate routes
 * must admit a caller whose PRIMARY role is the plain catalog role
 * `member` when the caller holds an unexpired custom grant carrying
 * the gate key in `additionalRoles`. A6/A7/A8 previously presented
 * only the primary role to hasServerPermission; A9-A13 are the five
 * D-STATIC conversions, which previously consulted ONLY the static
 * config map (hasPermissionForRole) and never saw a dynamic Firestore
 * grant at all — the holder cases below therefore prove a DYNAMIC
 * grant now admits the caller.
 *
 * The same caller is denied, with each route's original denial, when
 * the grant is expired or absent.
 *
 * End-to-end style: the REAL hasServerPermissionForUser runs against
 * a FakeFirestore seeded with roles/{uid}, users/{uid} and
 * roleDefinitions/{slug} docs. Auth mocks use the real
 * verifyAuthentication shape: userId (NOT uid) at the top level, the
 * decoded token nested at user.user.
 *
 * For A12/A13 the [uid] route param is the TARGET ('target-1', which
 * holds no grant). The holder cases pass only if the gate is scoped
 * to the CALLER's uid (auth.user.userId), never the target's.
 */

import { NextRequest } from 'next/server';

const CALLER = 'parity-caller';
const TARGET = 'target-1';
const CUSTOM = 'custom_verify_design_aide';

const holder: { db: any } = { db: null };

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
}));

// The hierarchy write helpers and the member-lifecycle service are
// not the gate under test; stub them at their module boundary so the
// suites isolate the permission decision.
jest.mock('@/lib/server/hierarchy', () => ({
  wouldCreateCycle: jest.fn(async () => ({ hasCycle: false })),
  syncDirectRelationship: jest.fn(async () => ({})),
}));

jest.mock('@/lib/server/member-lifecycle', () => ({
  departUser: jest.fn(async () => ({ memberStatus: 'departed' })),
  reinstateUser: jest.fn(async () => ({ memberStatus: 'active' })),
  InvalidMemberTransitionError: class InvalidMemberTransitionError extends Error {},
  MemberNotFoundError: class MemberNotFoundError extends Error {},
}));

import {
  createFakeDb,
  FakeCollectionRef,
} from '@/lib/server/__tests__/fake-firestore';
import { POST as relationshipsPOST, DELETE as relationshipsDELETE } from '@/app/api/admin/hierarchy/relationships/route';
import { GET as hierarchyUsersGET } from '@/app/api/admin/hierarchy/users/route';
import { POST as addExistingPOST } from '@/app/api/admin/hierarchy/add-existing/route';
import { POST as movePOST } from '@/app/api/admin/hierarchy/move/route';
import { POST as shellUserPOST } from '@/app/api/admin/hierarchy/user/route';
import { POST as departPOST } from '@/app/api/admin/users/[uid]/depart/route';
import { POST as reinstatePOST } from '@/app/api/admin/users/[uid]/reinstate/route';
import { departUser, reinstateUser } from '@/lib/server/member-lifecycle';

// FakeFirestore's collection refs have no add(); the relationships
// POST creates via collection().add(). Patch it onto the prototype
// (set via an auto-id doc ref, same semantics).
(FakeCollectionRef.prototype as any).add = async function (data: Record<string, unknown>) {
  const ref = this.doc();
  await ref.set(data);
  return ref;
};

type Grant = 'active' | 'expired' | 'none';

function seed(grant: Grant, gateKey: string) {
  const db = createFakeDb();
  const rolesDoc: Record<string, unknown> = { role: 'member' };
  if (grant !== 'none') {
    rolesDoc.additionalRoles = [CUSTOM];
    db.seed('roleDefinitions', CUSTOM, {
      isCustom: true,
      permissions: [gateKey],
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
  // Relationship / hierarchy fixtures.
  db.seed('users', 'sub-1', { displayName: 'Sub One', email: 'sub@example.com' });
  db.seed('users', 'mgr-1', { displayName: 'Mgr One', email: 'mgr@example.com' });
  db.seed('users', TARGET, {
    displayName: 'Target One',
    email: 'target@example.com',
    role: 'member',
  });
  holder.db = db;
  return db;
}

function jsonReq(url: string, method: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('A8: GET /api/admin/hierarchy/users (canViewHierarchy)', () => {
  const url = 'http://localhost/api/admin/hierarchy/users?chapterId=all';

  it('admits a member holding a dynamic custom grant for canViewHierarchy', async () => {
    seed('active', 'canViewHierarchy');
    const res = await hierarchyUsersGET(new NextRequest(url));
    expect(res.status).toBe(200);
  });

  it('denies the same holder when the grant is expired', async () => {
    seed('expired', 'canViewHierarchy');
    const res = await hierarchyUsersGET(new NextRequest(url));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Permission denied' });
  });

  it('denies a member with no grant', async () => {
    seed('none', 'canViewHierarchy');
    const res = await hierarchyUsersGET(new NextRequest(url));
    expect(res.status).toBe(403);
  });
});

describe('A6: POST /api/admin/hierarchy/relationships (canManageUsers)', () => {
  const body = { subordinateId: 'sub-1', managerId: 'mgr-1', type: 'direct' };
  const url = 'http://localhost/api/admin/hierarchy/relationships';

  it('admits a member holding a dynamic custom grant for canManageUsers', async () => {
    seed('active', 'canManageUsers');
    const res = await relationshipsPOST(jsonReq(url, 'POST', body));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.created).toBe(true);
  });

  it('denies the same holder when the grant is expired', async () => {
    seed('expired', 'canManageUsers');
    const res = await relationshipsPOST(jsonReq(url, 'POST', body));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Permission denied' });
  });

  it('denies a member with no grant', async () => {
    seed('none', 'canManageUsers');
    const res = await relationshipsPOST(jsonReq(url, 'POST', body));
    expect(res.status).toBe(403);
  });
});

describe('A7: DELETE /api/admin/hierarchy/relationships (canManageUsers)', () => {
  const body = { subordinateId: 'sub-1', managerId: 'mgr-1' };
  const url = 'http://localhost/api/admin/hierarchy/relationships';

  it('admits a member holding a dynamic custom grant for canManageUsers', async () => {
    seed('active', 'canManageUsers');
    const res = await relationshipsDELETE(jsonReq(url, 'DELETE', body));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it('denies the same holder when the grant is expired', async () => {
    seed('expired', 'canManageUsers');
    const res = await relationshipsDELETE(jsonReq(url, 'DELETE', body));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Permission denied' });
  });

  it('denies a member with no grant', async () => {
    seed('none', 'canManageUsers');
    const res = await relationshipsDELETE(jsonReq(url, 'DELETE', body));
    expect(res.status).toBe(403);
  });
});

describe('A9 (D-STATIC): POST /api/admin/hierarchy/add-existing (canManageUsers)', () => {
  const url = 'http://localhost/api/admin/hierarchy/add-existing';
  const body = { userId: TARGET };

  it('admits a member holding a DYNAMIC custom grant (the static map never saw it)', async () => {
    seed('active', 'canManageUsers');
    const res = await addExistingPOST(jsonReq(url, 'POST', body));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it('denies the same holder when the grant is expired', async () => {
    seed('expired', 'canManageUsers');
    const res = await addExistingPOST(jsonReq(url, 'POST', body));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Permission denied' });
  });

  it('denies a member with no grant', async () => {
    seed('none', 'canManageUsers');
    const res = await addExistingPOST(jsonReq(url, 'POST', body));
    expect(res.status).toBe(403);
  });
});

describe('A10 (D-STATIC): POST /api/admin/hierarchy/move (canManageUsers)', () => {
  const url = 'http://localhost/api/admin/hierarchy/move';
  const body = { userId: TARGET, newManagerId: null };

  it('admits a member holding a DYNAMIC custom grant (the static map never saw it)', async () => {
    seed('active', 'canManageUsers');
    const res = await movePOST(jsonReq(url, 'POST', body));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it('denies the same holder when the grant is expired', async () => {
    seed('expired', 'canManageUsers');
    const res = await movePOST(jsonReq(url, 'POST', body));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Permission denied' });
  });

  it('denies a member with no grant', async () => {
    seed('none', 'canManageUsers');
    const res = await movePOST(jsonReq(url, 'POST', body));
    expect(res.status).toBe(403);
  });
});

describe('A11 (D-STATIC): POST /api/admin/hierarchy/user shell-create (canManageUsers)', () => {
  const url = 'http://localhost/api/admin/hierarchy/user';
  const body = { email: 'brand-new@example.com', displayName: 'Brand New' };

  it('admits a member holding a DYNAMIC custom grant (the static map never saw it)', async () => {
    seed('active', 'canManageUsers');
    const res = await shellUserPOST(jsonReq(url, 'POST', body));
    expect(res.status).toBe(200);
  });

  it('denies the same holder when the grant is expired', async () => {
    seed('expired', 'canManageUsers');
    const res = await shellUserPOST(jsonReq(url, 'POST', body));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Permission denied' });
  });

  it('denies a member with no grant', async () => {
    seed('none', 'canManageUsers');
    const res = await shellUserPOST(jsonReq(url, 'POST', body));
    expect(res.status).toBe(403);
  });
});

describe('A12 (D-STATIC): POST /api/admin/users/[uid]/depart (caller gate, canManageUsers)', () => {
  const url = `http://localhost/api/admin/users/${TARGET}/depart`;
  const body = { reason: 'Leaving the society this term' };
  const mockDepart = departUser as jest.Mock;

  it('admits the CALLER holding a dynamic custom grant; the TARGET uid holds no grant', async () => {
    seed('active', 'canManageUsers');
    const res = await departPOST(jsonReq(url, 'POST', body), {
      params: { uid: TARGET },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    // The lifecycle service received the TARGET uid and the CALLER uid.
    expect(mockDepart).toHaveBeenCalledWith(
      expect.anything(),
      TARGET,
      CALLER,
      'Leaving the society this term',
    );
  });

  it('denies the same caller when the grant is expired, and never reaches the lifecycle service', async () => {
    seed('expired', 'canManageUsers');
    const res = await departPOST(jsonReq(url, 'POST', body), {
      params: { uid: TARGET },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Permission denied' });
    expect(mockDepart).not.toHaveBeenCalled();
  });

  it('denies a member with no grant', async () => {
    seed('none', 'canManageUsers');
    const res = await departPOST(jsonReq(url, 'POST', body), {
      params: { uid: TARGET },
    });
    expect(res.status).toBe(403);
    expect(mockDepart).not.toHaveBeenCalled();
  });
});

describe('A13 (D-STATIC): POST /api/admin/users/[uid]/reinstate (caller gate, canManageUsers)', () => {
  const url = `http://localhost/api/admin/users/${TARGET}/reinstate`;
  const mockReinstate = reinstateUser as jest.Mock;

  it('admits the CALLER holding a dynamic custom grant; the TARGET uid holds no grant', async () => {
    seed('active', 'canManageUsers');
    const res = await reinstatePOST(jsonReq(url, 'POST'), {
      params: { uid: TARGET },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(mockReinstate).toHaveBeenCalledWith(
      expect.anything(),
      TARGET,
      CALLER,
    );
  });

  it('denies the same caller when the grant is expired, and never reaches the lifecycle service', async () => {
    seed('expired', 'canManageUsers');
    const res = await reinstatePOST(jsonReq(url, 'POST'), {
      params: { uid: TARGET },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Permission denied' });
    expect(mockReinstate).not.toHaveBeenCalled();
  });

  it('denies a member with no grant', async () => {
    seed('none', 'canManageUsers');
    const res = await reinstatePOST(jsonReq(url, 'POST'), {
      params: { uid: TARGET },
    });
    expect(res.status).toBe(403);
    expect(mockReinstate).not.toHaveBeenCalled();
  });
});
