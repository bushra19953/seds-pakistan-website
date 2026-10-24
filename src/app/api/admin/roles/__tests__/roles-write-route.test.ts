/**
 * @jest-environment node
 *
 * POST /api/admin/roles/write - Founder-record immutability guard
 * (side-door item, plan section 3.1 / T-A). The guard moved here from
 * the /api/admin/roles/assign route so the protection survives that
 * route's fold into role-writes.
 */

jest.mock('@/lib/server/consent-gate', () => ({
  assertConsentFor: jest.fn().mockResolvedValue({ mode: 'record', outcome: 'passed' }),
  isCategoryBRole: jest.fn().mockResolvedValue(false),
  canonicaliseRoleKey: (k: string) => String(k ?? '').trim().toLowerCase(),
  consentGateHttpError: () => ({
    status: 500,
    body: { error: 'CONSENT_CHECK_UNAVAILABLE', code: 'CONSENT_CHECK_UNAVAILABLE' },
  }),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(true),
}));

jest.mock('@/lib/server/role-writes', () => {
  class RoleWriteError extends Error {
    code: string;
    httpStatus: number;
    constructor(code: string, httpStatus: number, message: string) {
      super(message);
      this.code = code;
      this.httpStatus = httpStatus;
    }
  }
  return {
    assignRole: jest.fn().mockResolvedValue({
      // AssignRoleResult shape (src/lib/server/role-writes.ts). The
      // route's contracts 3.2 echo reads result.roleDoc.expiresAt, so
      // the mock must carry a roleDoc; a plain assign stamps no
      // expiry, so expiresAt is null.
      roleDoc: { role: 'member', additionalRoles: [], expiresAt: null },
      previousEffectiveRole: null,
      newEffectiveRole: 'member',
      alreadyApplied: false,
    }),
    removeRole: jest.fn().mockResolvedValue({
      previousEffectiveRole: 'founder_patron',
      alreadyApplied: false,
    }),
    // Pre-gate validators (2026-10-24 defect fix): the route calls
    // these for founder actors only; the stub passes everything, the
    // real validation is pinned in write-pregate-validation.test.ts.
    validateAssignRoleInput: jest.fn().mockResolvedValue(undefined),
    validateRemoveRoleInput: jest.fn(),
    RoleWriteError,
  };
});

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/admin/roles/write/route';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { assertConsentFor } from '@/lib/server/consent-gate';
import { assignRole, removeRole } from '@/lib/server/role-writes';
import { FOUNDER_UID } from '@/config/founder';

const mockAuth = verifyAuthentication as jest.Mock;
const mockGate = assertConsentFor as jest.Mock;
const mockAssign = assignRole as jest.Mock;
const mockRemove = removeRole as jest.Mock;

function makeDb() {
  return {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => ({
          exists: true,
          id,
          data: () => (name === 'users' ? { role: 'president_national' } : { role: 'member' }),
        }),
      }),
    }),
  };
}

function req(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/admin/roles/write', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * The REAL verifyAuthentication success shape (src/lib/auth-middleware.ts):
 * the AuthContext carries the uid at `userId` ONLY. There is no top-level
 * `uid` - the decoded token (which has `uid`) is nested at `user.user`.
 * Earlier versions of this mock supplied a top-level `uid`, which masked
 * the route reading `.uid` and 401ing every real caller (live
 * verification, 2026-10-23). These mocks pin the real shape.
 */
function realAuthShape(uid: string, role: string) {
  return {
    authenticated: true,
    user: {
      user: { uid, email: 'admin@example.com', email_verified: true, name: 'Test Admin' },
      userId: uid,
      email: 'admin@example.com',
      displayName: 'Test Admin',
      emailVerified: true,
      role,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDbHolder.db = makeDb();
  mockAuth.mockResolvedValue(realAuthShape('admin-1', 'president_national'));
});

it('non-founder actor assigning the Founder record gets 403 and nothing is called', async () => {
  const res = await POST(
    req({ action: 'assign', uid: FOUNDER_UID, role: 'member', reason: 'Attempted founder change' }),
  );
  expect(res.status).toBe(403);
  const json = await res.json();
  expect(json.error).toBe('The Founder role is immutable');
  expect(mockAssign).not.toHaveBeenCalled();
  expect(mockGate).not.toHaveBeenCalled();
});

it('non-founder actor removing the Founder record gets 403 and nothing is called', async () => {
  const res = await POST(
    req({ action: 'remove', uid: FOUNDER_UID, reason: 'Attempted founder removal' }),
  );
  expect(res.status).toBe(403);
  const json = await res.json();
  expect(json.error).toBe('The Founder role is immutable');
  expect(mockRemove).not.toHaveBeenCalled();
  expect(mockGate).not.toHaveBeenCalled();
});

it('the Founder acting on their own record passes the guard', async () => {
  mockAuth.mockResolvedValue(realAuthShape(FOUNDER_UID, 'founder_patron'));
  const res = await POST(
    req({ action: 'assign', uid: FOUNDER_UID, role: 'president_national', reason: 'Founder self update' }),
  );
  expect(res.status).toBe(200);
  expect(mockAssign).toHaveBeenCalled();
});

it('a non-founder actor on an ordinary user passes the guard', async () => {
  const res = await POST(
    req({ action: 'assign', uid: 'user-9', role: 'member', reason: 'Ordinary role change' }),
  );
  expect(res.status).toBe(200);
  expect(mockAssign).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ uid: 'user-9', role: 'member' }),
  );
});

it('REGRESSION (live defect 2026-10-23): actor resolves from userId under the real verifyAuthentication shape, which has NO top-level uid', async () => {
  // realAuthShape (used in beforeEach) deliberately carries no top-level
  // `uid` on the AuthContext - exactly what the deployed
  // verifyAuthentication returns. The pre-fix route read `.uid`, resolved
  // the actor to '', and returned 401 "Actor could not be resolved" for
  // every caller, founder included.
  const res = await POST(
    req({ action: 'assign', uid: 'user-9', role: 'member', reason: 'Actor resolution pin' }),
  );
  expect(res.status).toBe(200);
  expect(mockAssign).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ actorUid: 'admin-1' }),
  );
});

it('REGRESSION (live defect 2026-10-23): the Founder token resolves its actor under the real shape too', async () => {
  mockAuth.mockResolvedValue(realAuthShape(FOUNDER_UID, 'founder_patron'));
  const res = await POST(
    req({ action: 'assign', uid: 'user-9', role: 'member', reason: 'Founder assigns member' }),
  );
  expect(res.status).toBe(200);
  expect(mockAssign).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ actorUid: FOUNDER_UID }),
  );
});
