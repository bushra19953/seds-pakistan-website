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
      newEffectiveRole: 'member',
      alreadyApplied: false,
    }),
    removeRole: jest.fn().mockResolvedValue({
      previousEffectiveRole: 'founder_patron',
      alreadyApplied: false,
    }),
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

beforeEach(() => {
  jest.clearAllMocks();
  mockDbHolder.db = makeDb();
  mockAuth.mockResolvedValue({
    authenticated: true,
    user: { uid: 'admin-1', userId: 'admin-1', role: 'president_national' },
  });
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
  mockAuth.mockResolvedValue({
    authenticated: true,
    user: { uid: FOUNDER_UID, userId: FOUNDER_UID, role: 'founder_patron' },
  });
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
