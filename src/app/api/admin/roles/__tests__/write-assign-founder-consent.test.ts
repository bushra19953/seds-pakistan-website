/**
 * @jest-environment node
 *
 * Fix 1 Tier 2 (plan 4.2, G10/G11/G12): founder-act coverage for the two
 * role-write routes and the sync-user-role probe.
 *   G10 POST /api/admin/roles/assign  (catb_officer, current OR new CatB)
 *   G11 POST /api/admin/roles/write   (catb_officer, new CatB only)
 *   G12 POST /api/admin/sync-user-role (PROBE only: the route refuses
 *       the write either way; the founder probe must pass
 *       allowFounderAutoConsent:false so no consent record is written
 *       for an act that never happens — plan 3.1.6)
 * The gate is mocked; the real founder logic is Tier 1's job. Ordering
 * cases pin invariant (a): validation / permission / founder
 * immutability / reservation checks run BEFORE the gate, so a refused
 * request can never leave an auto-consent record.
 */

jest.mock('@/lib/server/consent-gate', () => {
  const types = jest.requireActual('@/lib/server/consent-gate-types');
  return {
    assertConsentFor: jest.fn(),
    isCategoryBRole: jest.fn(async (_db: unknown, key: string) => key === 'president_national'),
    canonicaliseRoleKey: (k: string) => String(k ?? '').trim().toLowerCase(),
    consentGateHttpError: (err: unknown) =>
      err instanceof types.ConsentRequiredError
        ? {
            status: 409,
            body: {
              error: 'CONSENT_REQUIRED',
              code: 'CONSENT_REQUIRED',
              matter: (err as import('@/lib/server/consent-gate-types').ConsentRequiredError).matterKey,
              reason: (err as import('@/lib/server/consent-gate-types').ConsentRequiredError).reason,
              subject: (err as import('@/lib/server/consent-gate-types').ConsentRequiredError).subjectRef,
              consentRequestId: (err as import('@/lib/server/consent-gate-types').ConsentRequiredError).consentRequestId,
              fileRequestUrl: (err as import('@/lib/server/consent-gate-types').ConsentRequiredError).fileRequestUrl,
            },
          }
        : { status: 500, body: { error: 'CONSENT_CHECK_UNAVAILABLE', code: 'CONSENT_CHECK_UNAVAILABLE' } },
  };
});

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(true),
  hasServerPermissionForUser: jest.fn().mockResolvedValue(true),
}));

jest.mock('@/lib/server/governance-audit', () => ({
  writeGovernanceAuditOrThrow: jest.fn().mockResolvedValue('audit-1'),
  GovernanceAuditError: class GovernanceAuditError extends Error {},
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
      roleDoc: { role: 'member_basic', additionalRoles: [], expiresAt: null },
      previousEffectiveRole: 'member_basic',
      newEffectiveRole: 'president_national',
      alreadyApplied: false,
    }),
    removeRole: jest.fn().mockResolvedValue({
      previousEffectiveRole: 'president_national',
      alreadyApplied: false,
    }),
    // Pre-gate validators (2026-10-24 defect fix): founder-actor-only
    // in the write route; stubbed to pass (real validation is pinned
    // in write-pregate-validation.test.ts).
    validateAssignRoleInput: jest.fn().mockResolvedValue(undefined),
    validateRemoveRoleInput: jest.fn(),
    RoleWriteError,
  };
});

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => 'ts',
    delete: () => '__delete__',
  },
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  admin: { firestore: { FieldValue: { serverTimestamp: () => 'ts' } } },
}));

import { NextRequest } from 'next/server';
import { POST as assignPOST } from '@/app/api/admin/roles/assign/route';
import { POST as writePOST } from '@/app/api/admin/roles/write/route';
import { POST as syncPOST } from '@/app/api/admin/sync-user-role/route';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { assertConsentFor } from '@/lib/server/consent-gate';
import { assignRole, removeRole } from '@/lib/server/role-writes';
import { ConsentRequiredError } from '@/lib/server/consent-gate-types';
import { FOUNDER_UID } from '@/config/founder';

const mockAuth = verifyAuthentication as jest.Mock;
const mockGate = assertConsentFor as jest.Mock;
const mockAssign = assignRole as jest.Mock;
const mockRemove = removeRole as jest.Mock;

/**
 * One fake db serving all three routes:
 *  - users/{uid}: the assign target exists; the write route's actor doc
 *    carries the mirror role; sync's users doc accepts the mirror set.
 *  - roles/{uid}: current primary is member_basic (non-CatB), so gated-
 *    ness is decided by the REQUESTED role in these cases.
 */
function makeDb() {
  const sets: Array<{ col: string; id: string; data: unknown }> = [];
  const db = {
    __sets: sets,
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          if (name === 'users') {
            return { exists: true, id, data: () => ({ role: 'president_national', displayName: 'Target' }) };
          }
          if (name === 'roles') {
            return { exists: true, id, data: () => ({ role: 'member_basic', additionalRoles: [] }) };
          }
          return { exists: false, id, data: () => undefined };
        },
        set: async (data: unknown) => {
          sets.push({ col: name, id, data });
        },
      }),
    }),
  };
  return db;
}

function req(url: string, body: Record<string, unknown>) {
  return new NextRequest(url, { method: 'POST', body: JSON.stringify(body) });
}

function asUser(userId: string, role = 'president_national') {
  mockAuth.mockResolvedValue({
    authenticated: true,
    user: {
      user: { uid: userId, email: 'admin@example.com', name: 'Test Admin' },
      userId,
      uid: userId,
      email: 'admin@example.com',
      displayName: 'Test Admin',
      role,
    },
  });
}

function gateMissing() {
  return new ConsentRequiredError({
    matterKey: 'catb_officer',
    subjectRef: { type: 'user_role', targetUid: 'user-9', roleKey: 'president_national', action: 'appoint' },
    consentRequestId: null,
    reason: 'missing',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGate.mockResolvedValue({
    mode: 'hard',
    outcome: 'founder_act',
    consentRequestId: 'cr-auto-1',
  });
  mockDbHolder.db = makeDb();
  asUser('admin-1');
});

describe('G10 POST /api/admin/roles/assign', () => {
  const url = 'http://localhost/api/admin/roles/assign';

  it('founder act: gate resolving founder_act lets a Category B appointment proceed to role-writes', async () => {
    const res = await assignPOST(
      req(url, { targetUid: 'user-9', role: 'president_national', reason: 'Appointing the president' }),
    );
    expect(res.status).toBe(200);
    expect(mockGate).toHaveBeenCalledTimes(1);
    expect(mockGate).toHaveBeenCalledWith(
      expect.objectContaining({
        matterKey: 'catb_officer',
        subjectRef: {
          type: 'user_role',
          targetUid: 'user-9',
          roleKey: 'president_national',
          action: 'appoint',
        },
      }),
    );
    expect(mockAssign).toHaveBeenCalled();
  });

  it('a non-Category B appointment never consults the gate', async () => {
    const res = await assignPOST(
      req(url, { targetUid: 'user-9', role: 'member_basic', reason: 'Ordinary member appointment' }),
    );
    expect(res.status).toBe(200);
    expect(mockGate).not.toHaveBeenCalled();
    expect(mockAssign).toHaveBeenCalled();
  });

  it('invalid: a justification under 10 chars returns 400 BEFORE the gate', async () => {
    const res = await assignPOST(
      req(url, { targetUid: 'user-9', role: 'president_national', reason: 'short' }),
    );
    expect(res.status).toBe(400);
    expect(mockGate).not.toHaveBeenCalled();
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it('invalid: the superadmin reservation returns 403 BEFORE the gate', async () => {
    const res = await assignPOST(
      req(url, { targetUid: 'user-9', role: 'superadmin', reason: 'Trying to grant superadmin' }),
    );
    expect(res.status).toBe(403);
    expect(mockGate).not.toHaveBeenCalled();
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it('non-founder without consent: the gate throw surfaces the exact 409 body and role-writes is never called', async () => {
    mockGate.mockRejectedValue(gateMissing());
    const res = await assignPOST(
      req(url, { targetUid: 'user-9', role: 'president_national', reason: 'Appointing the president' }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CONSENT_REQUIRED');
    expect(mockAssign).not.toHaveBeenCalled();
  });
});

describe('G11 POST /api/admin/roles/write', () => {
  const url = 'http://localhost/api/admin/roles/write';

  it('founder act: gate resolving founder_act lets a Category B assign proceed to role-writes', async () => {
    const res = await writePOST(
      req(url, { action: 'assign', uid: 'user-9', role: 'president_national', reason: 'Appointing the president' }),
    );
    expect(res.status).toBe(200);
    expect(mockGate).toHaveBeenCalledTimes(1);
    expect(mockGate).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectRef: {
          type: 'user_role',
          targetUid: 'user-9',
          roleKey: 'president_national',
          action: 'appoint',
        },
      }),
    );
    expect(mockAssign).toHaveBeenCalled();
  });

  it('founder immutability: a non-founder writing the Founder record returns 403 BEFORE the gate', async () => {
    const res = await writePOST(
      req(url, { action: 'assign', uid: FOUNDER_UID, role: 'member_basic', reason: 'Attempted founder change' }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('The Founder role is immutable');
    expect(mockGate).not.toHaveBeenCalled();
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it('a non-Category B assign never consults the gate', async () => {
    const res = await writePOST(
      req(url, { action: 'assign', uid: 'user-9', role: 'member_basic', reason: 'Ordinary member assignment' }),
    );
    expect(res.status).toBe(200);
    expect(mockGate).not.toHaveBeenCalled();
    expect(mockAssign).toHaveBeenCalled();
  });

  it('non-founder without consent: the gate throw surfaces the exact 409 body and role-writes is never called', async () => {
    mockGate.mockRejectedValue(gateMissing());
    const res = await writePOST(
      req(url, { action: 'assign', uid: 'user-9', role: 'president_national', reason: 'Appointing the president' }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CONSENT_REQUIRED');
    expect(mockAssign).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
  });
});

describe('G12 POST /api/admin/sync-user-role (probe, plan 3.1.6)', () => {
  const url = 'http://localhost/api/admin/sync-user-role';

  it('founder probe passes allowFounderAutoConsent:false and the route still refuses with 409 ROLE_WRITE_ROUTE_REQUIRED', async () => {
    mockGate.mockResolvedValue({ mode: 'hard', outcome: 'founder_actor' });
    const res = await syncPOST(
      req(url, { uid: 'user-9', role: 'president_national', displayRole: 'president_national' }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ROLE_WRITE_ROUTE_REQUIRED');
    expect(mockGate).toHaveBeenCalledTimes(1);
    expect(mockGate).toHaveBeenCalledWith(
      expect.objectContaining({ allowFounderAutoConsent: false }),
    );
  });

  it('non-founder CatB probe without consent still returns the exact 409 CONSENT_REQUIRED body', async () => {
    mockGate.mockRejectedValue(gateMissing());
    const res = await syncPOST(
      req(url, { uid: 'user-9', role: 'president_national', displayRole: 'president_national' }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CONSENT_REQUIRED');
  });

  it('a non-Category B mirror mismatch never consults the gate and still refuses with ROLE_WRITE_ROUTE_REQUIRED', async () => {
    const res = await syncPOST(
      req(url, { uid: 'user-9', role: 'chapter_events_chair', displayRole: 'chapter_events_chair' }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ROLE_WRITE_ROUTE_REQUIRED');
    expect(mockGate).not.toHaveBeenCalled();
  });
});
