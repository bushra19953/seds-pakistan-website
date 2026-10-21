/**
 * @jest-environment node
 *
 * sync-user-role reduction tests (spec B.7 case 7): the route repairs the
 * users mirror only; it never performs a role write.
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
              matter: err.matterKey,
              reason: err.reason,
              subject: err.subjectRef,
              consentRequestId: err.consentRequestId,
              fileRequestUrl: err.fileRequestUrl,
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

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/admin/sync-user-role/route';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { assertConsentFor, isCategoryBRole } from '@/lib/server/consent-gate';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { ConsentRequiredError } from '@/lib/server/consent-gate-types';

const mockAuth = verifyAuthentication as jest.Mock;
const mockGate = assertConsentFor as jest.Mock;
const mockIsCatB = isCategoryBRole as jest.Mock;
const mockAudit = writeGovernanceAuditOrThrow as jest.Mock;

function makeDb(rolesRole: string | null) {
  const userSets: Array<{ id: string; data: Record<string, unknown> }> = [];
  const db = {
    __userSets: userSets,
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          if (name === 'roles') {
            return rolesRole === null
              ? { exists: false, id, data: () => undefined }
              : { exists: true, id, data: () => ({ role: rolesRole }) };
          }
          return { exists: true, id, data: () => ({}) };
        },
        set: async (data: Record<string, unknown>) => {
          if (name === 'users') userSets.push({ id, data });
        },
      }),
    }),
  };
  return db;
}

function req(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/admin/sync-user-role', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({
    authenticated: true,
    user: { userId: 'admin-1', role: 'executive_director' },
  });
  mockIsCatB.mockImplementation(async (_db: unknown, key: string) => key === 'president_national');
  mockGate.mockResolvedValue({ mode: 'hard', outcome: 'consented', consentRequestId: 'cr-1' });
  mockAudit.mockResolvedValue('audit-1');
});

it('role mismatch (non-Category B) is refused with ROLE_WRITE_ROUTE_REQUIRED and writes nothing', async () => {
  const db = makeDb('member');
  mockDbHolder.db = db;
  const res = await POST(req({ uid: 'user-1', role: 'chair_events' }));
  expect(res.status).toBe(409);
  const json = await res.json();
  expect(json.code).toBe('ROLE_WRITE_ROUTE_REQUIRED');
  expect(db.__userSets).toHaveLength(0);
  expect(mockGate).not.toHaveBeenCalled();
});

it('Category B mismatch without consent hits the gate first (CONSENT_REQUIRED wins)', async () => {
  const db = makeDb('member');
  mockDbHolder.db = db;
  mockGate.mockRejectedValue(
    new ConsentRequiredError({
      matterKey: 'catb_officer',
      subjectRef: { type: 'user_role', targetUid: 'user-1', roleKey: 'president_national', action: 'appoint' },
      consentRequestId: null,
      reason: 'missing',
    }),
  );
  const res = await POST(req({ uid: 'user-1', role: 'president_national' }));
  expect(res.status).toBe(409);
  const json = await res.json();
  expect(json.code).toBe('CONSENT_REQUIRED');
  expect(db.__userSets).toHaveLength(0);
});

it('Category B mismatch with a passing gate is STILL refused (no write path through sync)', async () => {
  const db = makeDb('member');
  mockDbHolder.db = db;
  const res = await POST(req({ uid: 'user-1', role: 'president_national', consentRequestId: 'cr-1' }));
  expect(res.status).toBe(409);
  const json = await res.json();
  expect(json.code).toBe('ROLE_WRITE_ROUTE_REQUIRED');
  expect(db.__userSets).toHaveLength(0);
});

it('matching role performs the mirror repair and audits it as role_mirror_repair', async () => {
  const db = makeDb('chair_events');
  mockDbHolder.db = db;
  const res = await POST(req({ uid: 'user-1', role: 'chair_events' }));
  expect(res.status).toBe(200);
  expect(db.__userSets).toHaveLength(1);
  expect(db.__userSets[0].data.role).toBe('chair_events');
  expect(mockGate).not.toHaveBeenCalled();
  expect(mockAudit).toHaveBeenCalledWith(
    db,
    expect.objectContaining({ action: 'role_mirror_repair' }),
  );
});
