/** @jest-environment node */
/**
 * D1 parity (Permission-Parity Fix Program, Family D):
 * requireGovernancePermission is the shared gate for every
 * governance-records caller (7 call sites, 5 files, no caller edits).
 * These tests run the REAL server permission layer against an
 * in-memory Firestore, with the canonical holder fixture from the
 * inventory: primary `member` (no governance grants), a custom role
 * in `additionalRoles` only, and the custom definition carrying the
 * gate key. An expired grant and a grant-less caller must keep the
 * original denial, byte-identical.
 */
import { NextRequest } from 'next/server';

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  admin: {
    firestore: {
      FieldValue: { serverTimestamp: () => 'ts', delete: () => 'del' },
    },
  },
}));

const mockVerify = jest.fn();
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: (...args: unknown[]) => mockVerify(...args),
}));

import { FakeFirestore } from '@/lib/__tests__/helpers/fake-firestore';
import { requireGovernancePermission } from '../route-auth';

const CUSTOM = 'custom_verify_design_aide';
const HOLDER = 'holder-uid';
const EXPIRED_HOLDER = 'expired-holder-uid';
const PLAIN = 'plain-uid';

const MANAGE = 'canManageGovernanceRecords' as const;
const APPROVE = 'canApproveGovernanceRecords' as const;

let fake: FakeFirestore;

function authAs(uid: string) {
  // Real AuthContext shape: uid lives at userId, NOT uid.
  mockVerify.mockResolvedValue({
    authenticated: true,
    user: {
      user: { uid },
      userId: uid,
      email: 'holder@example.com',
      displayName: 'Holder',
      emailVerified: true,
      role: 'member',
    },
  });
}

function req() {
  return new NextRequest('http://test/api/admin/governance-records', {
    headers: { authorization: 'Bearer <redacted>' },
  });
}

beforeEach(() => {
  fake = new FakeFirestore();
  mockDbHolder.db = fake.asDb();
  mockVerify.mockReset();
  fake.seed('roleDefinitions', CUSTOM, {
    isCustom: true,
    permissions: [MANAGE],
  });
  fake.seed('roles', HOLDER, {
    role: 'member',
    additionalRoles: [CUSTOM],
  });
  fake.seed('roles', EXPIRED_HOLDER, {
    role: 'member',
    additionalRoles: [CUSTOM],
    expiresAt: new Date('2020-01-01T00:00:00.000Z'),
    expiresRoleKey: CUSTOM,
  });
  fake.seed('roles', PLAIN, { role: 'member', additionalRoles: [] });
});

describe('requireGovernancePermission — holder parity (D1)', () => {
  it('holder passes on the first-hit key and keeps the { uid, role } return shape', async () => {
    authAs(HOLDER);
    const res = await requireGovernancePermission(
      req(),
      fake.asDb() as never,
      [MANAGE, APPROVE],
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.auth.uid).toBe(HOLDER);
      expect(typeof res.auth.role).toBe('string');
      expect(res.auth.role).not.toBe('');
    }
  });

  it('holder also passes when the granted key is the second key in the loop', async () => {
    authAs(HOLDER);
    const res = await requireGovernancePermission(
      req(),
      fake.asDb() as never,
      [APPROVE, MANAGE],
    );
    expect(res.ok).toBe(true);
  });

  it('holder with neither requested key is denied with the original 403 body', async () => {
    authAs(HOLDER);
    const res = await requireGovernancePermission(
      req(),
      fake.asDb() as never,
      [APPROVE],
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(403);
      expect(await res.response.json()).toEqual({
        error: 'Forbidden: insufficient permissions',
      });
    }
  });

  it('a caller with no custom grant is denied unchanged', async () => {
    authAs(PLAIN);
    const res = await requireGovernancePermission(
      req(),
      fake.asDb() as never,
      [MANAGE, APPROVE],
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(403);
      expect(await res.response.json()).toEqual({
        error: 'Forbidden: insufficient permissions',
      });
    }
  });

  it('an expired custom grant contributes nothing: original denial', async () => {
    authAs(EXPIRED_HOLDER);
    const res = await requireGovernancePermission(
      req(),
      fake.asDb() as never,
      [MANAGE, APPROVE],
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(403);
      expect(await res.response.json()).toEqual({
        error: 'Forbidden: insufficient permissions',
      });
    }
  });

  it('unauthenticated callers still get 401', async () => {
    mockVerify.mockResolvedValue({ authenticated: false, error: 'Unauthorized' });
    const res = await requireGovernancePermission(
      req(),
      fake.asDb() as never,
      [MANAGE],
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(401);
  });
});
