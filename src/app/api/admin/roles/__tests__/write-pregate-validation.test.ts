/**
 * @jest-environment node
 *
 * Pinning test for the spec-auditor defect (2026-10-24) on
 * POST /api/admin/roles/write: the route used to run the consent gate
 * BEFORE assignRole's validation, so a founder request with an empty
 * uid, a short reason, or a bad expiry MINTED a founder-act consent
 * record + both founder-act audits inside assertConsentFor and only
 * then returned 400, with no rollback.
 *
 * The fix runs role-writes' own validation (validateAssignRoleInput /
 * validateRemoveRoleInput — the same checks assignRole/removeRole run)
 * BEFORE the gate for founder actors. This suite uses the REAL
 * role-writes validators (only assignRole/removeRole are spied) and a
 * gate mock that records calls: in production, consent records and
 * founder-act audits are written ONLY inside the gate
 * (consent-gate.ts founderActPass -> consent-service.ts
 * createFounderActConsent), so "gate never called + zero db writes"
 * is exactly "zero consent records / zero founder-act audits".
 */

jest.mock('@/lib/server/consent-gate', () => ({
  assertConsentFor: jest.fn().mockResolvedValue({
    mode: 'hard',
    outcome: 'founder_act',
    consentRequestId: 'cr-auto-1',
  }),
  isCategoryBRole: jest.fn(async (_db: unknown, key: string) => key === 'president_national'),
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
  const actual = jest.requireActual('@/lib/server/role-writes');
  return {
    ...actual,
    assignRole: jest.fn().mockResolvedValue({
      roleDoc: { role: 'president_national', additionalRoles: [], expiresAt: null },
      previousEffectiveRole: 'member_basic',
      newEffectiveRole: 'president_national',
      alreadyApplied: false,
    }),
    removeRole: jest.fn().mockResolvedValue({
      previousEffectiveRole: 'president_national',
      alreadyApplied: false,
    }),
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
import { POST } from '@/app/api/admin/roles/write/route';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { assertConsentFor, isCategoryBRole } from '@/lib/server/consent-gate';
import { assignRole, removeRole } from '@/lib/server/role-writes';
import { FOUNDER_UID } from '@/config/founder';

const mockAuth = verifyAuthentication as jest.Mock;
const mockGate = assertConsentFor as jest.Mock;
const mockIsCatB = isCategoryBRole as jest.Mock;
const mockAssign = assignRole as jest.Mock;
const mockRemove = removeRole as jest.Mock;

/** Every Firestore write the route/validators attempt lands here. */
const writes: Array<{ col: string; id?: string; data: unknown }> = [];

function makeDb() {
  return {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          if (name === 'roles') {
            return {
              exists: true,
              id,
              data: () => ({ role: 'member_basic', additionalRoles: [], chapterId: 'chapter-1' }),
            };
          }
          if (name === 'users') {
            return {
              exists: true,
              id,
              data: () => ({ role: 'member_basic', chapterId: 'chapter-1' }),
            };
          }
          return { exists: false, id, data: () => undefined };
        },
        set: async (data: unknown) => {
          writes.push({ col: name, id, data });
        },
      }),
      add: async (data: unknown) => {
        writes.push({ col: name, data });
        return { id: 'added-1' };
      },
    }),
  };
}

/** The REAL verifyAuthentication success shape (uid at userId only). */
function founderAuth() {
  return {
    authenticated: true,
    user: {
      user: { uid: FOUNDER_UID, email: 'founder@example.com', name: 'Founder' },
      userId: FOUNDER_UID,
      email: 'founder@example.com',
      displayName: 'Founder',
      role: 'founder_patron',
    },
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
  writes.length = 0;
  mockDbHolder.db = makeDb();
  mockAuth.mockResolvedValue(founderAuth());
  mockGate.mockResolvedValue({ mode: 'hard', outcome: 'founder_act', consentRequestId: 'cr-auto-1' });
  mockIsCatB.mockImplementation(async (_db: unknown, key: string) => key === 'president_national');
});

describe('founder pre-gate validation (defect 2026-10-24)', () => {
  it('short reason: 400 invalid_reason, gate never reached, zero consent records / zero founder-act audits', async () => {
    const res = await POST(
      req({ action: 'assign', uid: 'user-9', role: 'president_national', reason: 'short' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_reason');
    expect(mockIsCatB).not.toHaveBeenCalled();
    expect(mockGate).not.toHaveBeenCalled();
    expect(mockAssign).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('empty uid: 400 user_not_found, gate never reached, zero writes', async () => {
    const res = await POST(
      req({ action: 'assign', role: 'president_national', reason: 'A perfectly valid reason' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('user_not_found');
    expect(mockGate).not.toHaveBeenCalled();
    expect(mockAssign).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('bad expiry: 400 invalid_expiry, gate never reached, zero writes', async () => {
    const res = await POST(
      req({
        action: 'assign',
        uid: 'user-9',
        role: 'president_national',
        reason: 'A perfectly valid reason',
        expiresAt: '2020-01-01T00:00:00.000Z',
        expiresRoleKey: 'custom_test_role',
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_expiry');
    expect(mockGate).not.toHaveBeenCalled();
    expect(mockAssign).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('unknown role: 400 unknown_role, gate never reached, zero writes', async () => {
    const res = await POST(
      req({ action: 'assign', uid: 'user-9', role: 'not_a_real_role', reason: 'A perfectly valid reason' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('unknown_role');
    expect(mockGate).not.toHaveBeenCalled();
    expect(mockAssign).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('founder remove with a short reason: 400 invalid_reason, gate never reached, zero writes', async () => {
    const res = await POST(req({ action: 'remove', uid: 'user-9', reason: 'short' }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_reason');
    expect(mockGate).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('control: a VALID founder Category B assign passes pre-gate validation, reaches the gate, and proceeds', async () => {
    const res = await POST(
      req({ action: 'assign', uid: 'user-9', role: 'president_national', reason: 'Appointing the president' }),
    );
    expect(res.status).toBe(200);
    expect(mockGate).toHaveBeenCalledTimes(1);
    expect(mockAssign).toHaveBeenCalledTimes(1);
    expect(mockAssign).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ uid: 'user-9', role: 'president_national', actorUid: FOUNDER_UID }),
    );
  });
});
