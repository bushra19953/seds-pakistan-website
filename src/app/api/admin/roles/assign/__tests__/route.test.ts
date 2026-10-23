/**
 * @jest-environment node
 *
 * POST /api/admin/roles/assign - FOLD tests (Custom Roles Fix Program,
 * contracts section 3.3; side-door plan section 4, T-A as reconciled
 * to the fold). The route keeps its envelope but performs NO write
 * itself: every action delegates to assignRole / removeRole from
 * role-writes, validation failures surface as role-writes'
 * RoleWriteError ({ error, code } at its httpStatus), a definition-
 * backed custom_ slug is translated to an additionalRoles entry with
 * the primary unchanged, and junk / invented slugs fail with
 * unknown_role. role-writes is mocked here; its own validation
 * behaviour (incl. custom-definition checks, contracts section 3.2)
 * is assign-path's suite. What THIS suite pins is the fold itself:
 * delegation shape, envelope, gate, and zero direct writes.
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
        const ref: FakeRef & {
          get: () => Promise<unknown>;
          set: (data: unknown) => Promise<void>;
          update: (data: unknown) => Promise<void>;
        } = {
          __col: name,
          __id: id,
          get: async () => {
            const data = state[name]?.[id];
            return { exists: data !== undefined, id, data: () => data };
          },
          set: async (data: unknown) => {
            writes.push({ op: 'set', ref, data });
          },
          update: async (data: unknown) => {
            writes.push({ op: 'update', ref, data });
          },
        };
        return ref;
      },
    }),
    batch: () => {
      const ops: Array<{ op: string; ref: FakeRef; data?: unknown }> = [];
      return {
        set: (ref: FakeRef, data: unknown) => ops.push({ op: 'set', ref, data }),
        update: (ref: FakeRef, data: unknown) => ops.push({ op: 'update', ref, data }),
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

function directWrites() {
  const db = mockDbHolder.db as ReturnType<typeof makeDb>;
  return db.__writes;
}

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
    roles: { 'user-1': { role: 'chair_events', additionalRoles: [] } },
  });
});

it('a catalog appoint delegates to assignRole and the route writes nothing itself', async () => {
  const res = await POST(
    req({ targetUid: 'user-1', role: 'member', reason: 'Rotation off committee' }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, role: 'member' });
  expect(mockGate).not.toHaveBeenCalled();
  expect(mockAssign).toHaveBeenCalledTimes(1);
  expect(mockAssign).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      uid: 'user-1',
      role: 'member',
      additionalRoles: [],
      actorUid: 'admin-1',
      reason: 'Rotation off committee',
      source: 'admin_ui',
    }),
  );
  expect(mockRemove).not.toHaveBeenCalled();
  expect(directWrites()).toHaveLength(0);
});

it('a primary change passes the holder\u2019s existing additionalRoles through untouched', async () => {
  mockDbHolder.db = makeDb({
    users: { 'user-1': { role: 'chair_events' } },
    roles: { 'user-1': { role: 'chair_events', additionalRoles: ['cubesat_team'] } },
  });
  const res = await POST(
    req({ targetUid: 'user-1', role: 'chapter_treasurer', reason: 'Committee rotation' }),
  );
  expect(res.status).toBe(200);
  expect(mockAssign).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ role: 'chapter_treasurer', additionalRoles: ['cubesat_team'] }),
  );
  expect(directWrites()).toHaveLength(0);
});

it('member to Category B without consent returns 409 CONSENT_REQUIRED and role-writes is never called', async () => {
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
  expect(mockRemove).not.toHaveBeenCalled();
  expect(directWrites()).toHaveLength(0);
});

it('member to Category B with consent passes the gate and delegates', async () => {
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
  expect(directWrites()).toHaveLength(0);
});

it('Category B removal (revoke) gates on the current role and delegates as an assign to member with additionals stripped', async () => {
  mockDbHolder.db = makeDb({
    users: { 'user-1': { role: 'president_national' } },
    roles: { 'user-1': { role: 'president_national', additionalRoles: ['cubesat_team'] } },
  });
  const res = await POST(
    req({ targetUid: 'user-1', action: 'revoke', reason: 'Term ended at AGM', consentRequestId: 'cr-1' }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, role: 'member' });
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
  expect(mockRemove).not.toHaveBeenCalled();
  expect(directWrites()).toHaveLength(0);
});

it('delete delegates to removeRole and answers the member_basic floor', async () => {
  const res = await POST(
    req({ targetUid: 'user-1', action: 'delete', reason: 'Duplicate profile cleanup' }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, role: 'member_basic' });
  expect(mockRemove).toHaveBeenCalledTimes(1);
  expect(mockRemove).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ uid: 'user-1', actorUid: 'admin-1', source: 'admin_ui' }),
  );
  expect(mockAssign).not.toHaveBeenCalled();
  expect(directWrites()).toHaveLength(0);
});

it('Category B to Category B change without consent returns 409 and role-writes is never called', async () => {
  mockDbHolder.db = makeDb({
    users: { 'user-1': { role: 'president_national' } },
    roles: { 'user-1': { role: 'president_national', additionalRoles: [] } },
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
  expect(directWrites()).toHaveLength(0);
});

it('an invented slug fails with role-writes\u2019 unknown_role, surfaced unchanged', async () => {
  mockAssign.mockRejectedValue(
    new RoleWriteError('unknown_role', 400, 'Role "media_lead" is not in the catalog'),
  );
  const res = await POST(
    req({ targetUid: 'user-1', role: 'media_lead', reason: 'New media committee lead' }),
  );
  expect(res.status).toBe(400);
  const json = await res.json();
  expect(json.code).toBe('unknown_role');
  expect(mockAssign).toHaveBeenCalledTimes(1);
  expect(directWrites()).toHaveLength(0);
});

it('a junk slug fails identically (unknown_role), never stored verbatim', async () => {
  mockAssign.mockRejectedValue(
    new RoleWriteError('unknown_role', 400, 'Role "pakistan-president" is not in the catalog'),
  );
  const res = await POST(
    req({ targetUid: 'user-1', role: 'pakistan-president', reason: 'Attempted junk assignment' }),
  );
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe('unknown_role');
  expect(directWrites()).toHaveLength(0);
});

it('a definition-backed custom slug is translated: primary unchanged, slug appended to additionalRoles', async () => {
  mockDbHolder.db = makeDb({
    users: { 'user-1': { role: 'chapter_design_chair' } },
    roles: { 'user-1': { role: 'chapter_design_chair', additionalRoles: [] } },
  });
  const res = await POST(
    req({ targetUid: 'user-1', role: 'custom_poster_team_lead', reason: 'Poster team for induction' }),
  );
  expect(res.status).toBe(200);
  expect(mockAssign).toHaveBeenCalledTimes(1);
  expect(mockAssign).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      uid: 'user-1',
      role: 'chapter_design_chair',
      additionalRoles: ['custom_poster_team_lead'],
    }),
  );
  expect(directWrites()).toHaveLength(0);
});

it('a custom slug for a holder with no roles doc lands on the member_basic primary', async () => {
  mockDbHolder.db = makeDb({
    users: { 'user-1': { role: 'member' } },
    roles: {},
  });
  const res = await POST(
    req({ targetUid: 'user-1', role: 'custom_poster_team_lead', reason: 'Poster team for induction' }),
  );
  expect(res.status).toBe(200);
  expect(mockAssign).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      role: 'member_basic',
      additionalRoles: ['custom_poster_team_lead'],
    }),
  );
});

it('a custom slug role-writes cannot validate (no definition) fails unknown_role', async () => {
  mockAssign.mockRejectedValue(
    new RoleWriteError('unknown_role', 400, 'Role "custom_ghost" is not in the catalog'),
  );
  const res = await POST(
    req({ targetUid: 'user-1', role: 'custom_ghost', reason: 'Attempted ghost team role' }),
  );
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe('unknown_role');
  expect(directWrites()).toHaveLength(0);
});

it('superadmin stays refused with 403 before the gate and before role-writes', async () => {
  const res = await POST(
    req({ targetUid: 'user-1', role: 'superadmin', reason: 'Attempted reservation breach' }),
  );
  expect(res.status).toBe(403);
  expect(mockGate).not.toHaveBeenCalled();
  expect(mockAssign).not.toHaveBeenCalled();
  expect(directWrites()).toHaveLength(0);
});

it('unauthenticated caller gets 401', async () => {
  mockAuth.mockResolvedValue({ authenticated: false });
  const res = await POST(
    req({ targetUid: 'user-1', role: 'member', reason: 'Rotation off committee' }),
  );
  expect(res.status).toBe(401);
  expect(mockAssign).not.toHaveBeenCalled();
});

it('caller without canManageRoles gets 403 and neither the gate nor role-writes is consulted', async () => {
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
  expect(mockAssign).not.toHaveBeenCalled();
});

it('the Founder role record is immutable for non-Founder callers', async () => {
  const res = await POST(
    req({ targetUid: FOUNDER_UID, role: 'member', reason: 'Attempted founder change' }),
  );
  expect(res.status).toBe(403);
  expect(mockGate).not.toHaveBeenCalled();
  expect(mockAssign).not.toHaveBeenCalled();
  expect(mockRemove).not.toHaveBeenCalled();
});

it('a target with no users doc gets 404 and role-writes is never called', async () => {
  const res = await POST(
    req({ targetUid: 'ghost-user', role: 'member', reason: 'Rotation off committee' }),
  );
  expect(res.status).toBe(404);
  expect(mockAssign).not.toHaveBeenCalled();
  expect(directWrites()).toHaveLength(0);
});
