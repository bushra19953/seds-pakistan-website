/**
 * @jest-environment node
 *
 * POST /api/admin/roles/assign tests - FOLDED route (Custom Roles Fix
 * Program, contracts section 3.3). The envelope, auth, founder
 * immutability and Category B consent behaviour of the pre-fold route
 * are preserved; every write is delegated to role-writes
 * assignRole/removeRole and the route itself performs NO direct
 * writes to the role stores (asserted via the fake db's write log).
 */

jest.mock('@/lib/server/consent-gate', () => {
  const types = jest.requireActual('@/lib/server/consent-gate-types');
  return {
    assertConsentFor: jest.fn(),
    isCategoryBRole: jest.fn(),
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

jest.mock('@/lib/server/governance-audit', () => ({
  writeGovernanceAuditOrThrow: jest.fn().mockResolvedValue('audit-1'),
  GovernanceAuditError: class GovernanceAuditError extends Error {},
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
      this.name = 'RoleWriteError';
      this.code = code;
      this.httpStatus = httpStatus;
    }
  }
  return {
    assignRole: jest.fn(),
    removeRole: jest.fn(),
    RoleWriteError,
  };
});

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/admin/roles/assign/route';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { assertConsentFor, isCategoryBRole } from '@/lib/server/consent-gate';
import { assignRole, removeRole, RoleWriteError } from '@/lib/server/role-writes';
import { ConsentRequiredError } from '@/lib/server/consent-gate-types';
import { FOUNDER_UID } from '@/lib/roles';

const mockAuth = verifyAuthentication as jest.Mock;
const mockPerm = hasServerPermission as jest.Mock;
const mockGate = assertConsentFor as jest.Mock;
const mockIsCatB = isCategoryBRole as jest.Mock;
const mockAssign = assignRole as jest.Mock;
const mockRemove = removeRole as jest.Mock;

interface FakeRef {
  __col: string;
  __id: string;
}

function makeDb(state: Record<string, Record<string, Record<string, unknown>>>) {
  const writes: Array<{ op: string; ref: FakeRef; data?: unknown }> = [];
  const db = {
    __writes: writes,
    collection: (name: string) => ({
      doc: (id: string) => {
        const ref: FakeRef & { get: () => Promise<unknown> } = {
          __col: name,
          __id: id,
          get: async () => {
            const data = state[name]?.[id];
            return { exists: data !== undefined, id, data: () => data };
          },
        };
        return ref;
      },
    }),
    batch: () => {
      const ops: Array<{ op: string; ref: FakeRef; data?: unknown }> = [];
      return {
        set: (ref: FakeRef, data: unknown) => ops.push({ op: 'set', ref, data }),
        delete: (ref: FakeRef) => ops.push({ op: 'delete', ref }),
        commit: async () => {
          writes.push(...ops);
        },
      };
    },
  };
  return db;
}

function req(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/admin/roles/assign', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

const CATB = new Set(['president_national', 'national_treasurer']);

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({
    authenticated: true,
    user: { userId: 'admin-1', role: 'executive_director' },
  });
  mockPerm.mockResolvedValue(true);
  mockIsCatB.mockImplementation(async (_db: unknown, key: string) => CATB.has(key));
  mockGate.mockResolvedValue({ mode: 'hard', outcome: 'consented', consentRequestId: 'cr-1' });
  mockAssign.mockImplementation(async (_db: unknown, input: { role: string }) => ({
    newEffectiveRole: input.role,
    alreadyApplied: false,
  }));
  mockRemove.mockResolvedValue({ previousEffectiveRole: 'member', alreadyApplied: false });
  mockDbHolder.db = makeDb({
    users: { 'user-1': { role: 'chair_events' } },
    roles: { 'user-1': { role: 'chair_events' } },
  });
});

it('non-Category-B appoint delegates to assignRole with no gate call and no direct writes', async () => {
  const res = await POST(
    req({ targetUid: 'user-1', role: 'member', reason: 'Rotation off committee' }),
  );
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json).toEqual({ ok: true, role: 'member' });
  expect(mockGate).not.toHaveBeenCalled();
  expect(mockAssign).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      uid: 'user-1',
      role: 'member',
      actorUid: 'admin-1',
      source: 'admin_ui',
    }),
  );
  const db = mockDbHolder.db as ReturnType<typeof makeDb>;
  expect(db.__writes).toHaveLength(0);
});

it('member to Category B without consent returns 409 CONSENT_REQUIRED and delegates nothing', async () => {
  mockGate.mockRejectedValue(
    new ConsentRequiredError({
      matterKey: 'catb_officer',
      subjectRef: { type: 'user_role', targetUid: 'user-1', roleKey: 'president_national', action: 'appoint' },
      consentRequestId: null,
      reason: 'missing',
    }),
  );
  const res = await POST(
    req({ targetUid: 'user-1', role: 'president_national', reason: 'AGM election result' }),
  );
  expect(res.status).toBe(409);
  const json = await res.json();
  expect(json.code).toBe('CONSENT_REQUIRED');
  expect(json.reason).toBe('missing');
  expect(mockAssign).not.toHaveBeenCalled();
});

it('member to Category B with consent passes and the gate subject matches the appointment', async () => {
  const res = await POST(
    req({
      targetUid: 'user-1',
      role: 'president_national',
      reason: 'AGM election result',
      consentRequestId: 'cr-1',
    }),
  );
  expect(res.status).toBe(200);
  expect(mockGate).toHaveBeenCalledWith(
    expect.objectContaining({
      actorUid: 'admin-1',
      matterKey: 'catb_officer',
      consentRequestId: 'cr-1',
      subjectRef: {
        type: 'user_role',
        targetUid: 'user-1',
        roleKey: 'president_national',
        action: 'appoint',
      },
    }),
  );
  expect(mockAssign).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ uid: 'user-1', role: 'president_national' }),
  );
});

it('Category B removal (revoke) gates on the current role and strips to member via assignRole', async () => {
  mockDbHolder.db = makeDb({
    users: { 'user-1': { role: 'president_national' } },
    roles: { 'user-1': { role: 'president_national', additionalRoles: ['chapter_design_chair'] } },
  });
  const res = await POST(
    req({ targetUid: 'user-1', action: 'revoke', reason: 'Term ended at AGM', consentRequestId: 'cr-1' }),
  );
  expect(res.status).toBe(200);
  expect(mockGate).toHaveBeenCalledWith(
    expect.objectContaining({
      subjectRef: {
        type: 'user_role',
        targetUid: 'user-1',
        roleKey: 'president_national',
        action: 'remove',
      },
    }),
  );
  expect(mockAssign).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ uid: 'user-1', role: 'member', additionalRoles: [] }),
  );
});

it('delete delegates to removeRole and reports the member_basic floor', async () => {
  const res = await POST(
    req({ targetUid: 'user-1', action: 'delete', reason: 'Account cleanup after departure' }),
  );
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json).toEqual({ ok: true, role: 'member_basic' });
  expect(mockRemove).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ uid: 'user-1', actorUid: 'admin-1', source: 'admin_ui' }),
  );
  expect(mockAssign).not.toHaveBeenCalled();
});

it('Category B to Category B change without consent returns 409', async () => {
  mockDbHolder.db = makeDb({
    users: { 'user-1': { role: 'president_national' } },
    roles: { 'user-1': { role: 'president_national' } },
  });
  mockGate.mockRejectedValue(
    new ConsentRequiredError({
      matterKey: 'catb_officer',
      subjectRef: { type: 'user_role', targetUid: 'user-1', roleKey: 'national_treasurer', action: 'appoint' },
      consentRequestId: null,
      reason: 'missing',
    }),
  );
  const res = await POST(
    req({ targetUid: 'user-1', role: 'national_treasurer', reason: 'Cabinet reshuffle' }),
  );
  expect(res.status).toBe(409);
  expect(mockAssign).not.toHaveBeenCalled();
});

it('an invented slug is delegated to role-writes and its unknown_role refusal surfaces', async () => {
  mockAssign.mockRejectedValue(
    new RoleWriteError('unknown_role', 400, 'Role "media_lead" is not in the catalog'),
  );
  const res = await POST(
    req({ targetUid: 'user-1', role: 'media_lead', reason: 'Invented slug probe' }),
  );
  expect(res.status).toBe(400);
  const json = await res.json();
  expect(json.code).toBe('unknown_role');
  expect(mockAssign).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ uid: 'user-1', role: 'media_lead' }),
  );
  const db = mockDbHolder.db as ReturnType<typeof makeDb>;
  expect(db.__writes).toHaveLength(0);
});

it('a custom slug is translated: current catalog primary kept, slug appended to additionalRoles', async () => {
  mockDbHolder.db = makeDb({
    users: { 'user-1': { role: 'chapter_design_chair' } },
    roles: { 'user-1': { role: 'chapter_design_chair', additionalRoles: [] } },
  });
  const res = await POST(
    req({ targetUid: 'user-1', role: 'custom_poster_team_lead', reason: 'Temporary poster team' }),
  );
  expect(res.status).toBe(200);
  expect(mockAssign).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      uid: 'user-1',
      role: 'chapter_design_chair',
      additionalRoles: ['custom_poster_team_lead'],
    }),
  );
});

it('a custom slug for a holder with no roles doc bootstraps the primary to member_basic', async () => {
  mockDbHolder.db = makeDb({
    users: { 'user-1': { role: 'member' } },
    roles: {},
  });
  const res = await POST(
    req({ targetUid: 'user-1', role: 'custom_poster_team_lead', reason: 'Temporary poster team' }),
  );
  expect(res.status).toBe(200);
  expect(mockAssign).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      uid: 'user-1',
      role: 'member_basic',
      additionalRoles: ['custom_poster_team_lead'],
    }),
  );
});

it('unauthenticated caller gets 401', async () => {
  mockAuth.mockResolvedValue({ authenticated: false });
  const res = await POST(
    req({ targetUid: 'user-1', role: 'member', reason: 'Rotation off committee' }),
  );
  expect(res.status).toBe(401);
});

it('caller without canManageRoles gets 403 and the gate is not consulted', async () => {
  mockPerm.mockResolvedValue(false);
  const res = await POST(
    req({ targetUid: 'user-1', role: 'president_national', reason: 'AGM election result' }),
  );
  expect(res.status).toBe(403);
  expect(mockGate).not.toHaveBeenCalled();
  expect(mockAssign).not.toHaveBeenCalled();
});

it('short reason gets 400', async () => {
  const res = await POST(req({ targetUid: 'user-1', role: 'member', reason: 'short' }));
  expect(res.status).toBe(400);
});

it('superadmin cannot be assigned through this route', async () => {
  const res = await POST(
    req({ targetUid: 'user-1', role: 'superadmin', reason: 'Attempted reservation breach' }),
  );
  expect(res.status).toBe(403);
  expect(mockAssign).not.toHaveBeenCalled();
});

it('the Founder role record is immutable for non-Founder callers', async () => {
  const res = await POST(
    req({ targetUid: FOUNDER_UID, role: 'member', reason: 'Attempted founder change' }),
  );
  expect(res.status).toBe(403);
  expect(mockAssign).not.toHaveBeenCalled();
});
