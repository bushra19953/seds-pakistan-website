/**
 * @jest-environment node
 *
 * MSG40 — Non-admin rejection for the removal shape.
 *
 * A grant removal travels as a removal-shaped assign: POST
 * /api/admin/roles/write with action 'assign', the primary unchanged,
 * and additionalRoles reduced. The gate that decides it is the route's
 * admin-only gate (Founder or a canManageRoles holder), not the body
 * shape — so a non-admin posting exactly that shape must get 403 and
 * no write, while an admin posting it passes through.
 *
 * Mock setup mirrors roles-write-route.test.ts (same seams, own file
 * so the pinned suite is untouched).
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
      roleDoc: { role: 'member', additionalRoles: [], expiresAt: null },
      previousEffectiveRole: null,
      newEffectiveRole: 'member',
      alreadyApplied: false,
    }),
    removeRole: jest.fn().mockResolvedValue({
      previousEffectiveRole: 'founder_patron',
      alreadyApplied: false,
    }),
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
import { assignRole } from '@/lib/server/role-writes';
import { hasServerPermission } from '@/lib/server/permissions';

const mockAuth = verifyAuthentication as jest.Mock;
const mockAssign = assignRole as jest.Mock;
const mockPerm = hasServerPermission as jest.Mock;

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

/** A removal-shaped assign: primary unchanged, grant list reduced to []. */
function removalBody() {
  return {
    action: 'assign',
    uid: 'user-9',
    role: 'member',
    additionalRoles: [],
    chapterId: 'seds-ist-chapter',
    reason: 'Founder-ordered deputy strip, November 2026 review',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDbHolder.db = makeDb();
  mockAuth.mockResolvedValue(realAuthShape('admin-1', 'president_national'));
  mockPerm.mockResolvedValue(true);
});

describe('MSG40 removal-shaped assign gate', () => {
  it('a non-admin posting the removal shape gets 403 and no write happens', async () => {
    mockPerm.mockResolvedValue(false);
    const res = await POST(req(removalBody()));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('Forbidden: role management permission required');
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it('an admin posting the removal shape passes through to the write', async () => {
    const res = await POST(req(removalBody()));
    expect(res.status).toBe(200);
    expect(mockAssign).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ uid: 'user-9', role: 'member', additionalRoles: [] }),
    );
  });
});
