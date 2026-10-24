/**
 * @jest-environment node
 *
 * Fix 2 (plan 4.3a): requireGovPermission in route-helpers.ts.
 *
 * On the base tree the helper resolves the role through the 1-arg
 * resolveUserRole(uid) deny-all branch, so EVERY authenticated caller —
 * founder included — gets the 403 below. The repaired helper must:
 *   - pass the Founder by UID (isFounder, real module) with NO permission
 *     lookup at all;
 *   - evaluate everyone else holder-scoped via
 *     hasServerPermissionForUser(getDb(), uid, key);
 *   - keep the exact pre-change 403 GovernanceServiceError shape for a
 *     non-holder, the 401 for no token, and answer 503 when there is no
 *     db handle.
 *
 * Mocking follows the neighbouring governance suites: verifySession,
 * firebase-admin and permissions are module mocks; @/lib/roles is REAL
 * so the founder test exercises the real isFounder/FOUNDER_UID wiring.
 */

const mockState: { uid: string | null; db: unknown } = {
  uid: 'admin-1',
  db: { __fakeDb: true },
};

jest.mock('@/lib/auth/verifySession', () => ({
  extractBearerToken: (req: { headers: { get(name: string): string | null } }) => {
    const header = req.headers.get('authorization');
    return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  },
  verifyIdTokenString: jest.fn(async () => ({ uid: mockState.uid })),
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockState.db,
}));

jest.mock('@/lib/server/permissions', () => ({
  // Present so the BASE implementation (1-arg resolveUserRole +
  // hasServerPermission) still loads and runs in this suite: on the base
  // tree these two produce the always-403 behaviour the founder and
  // holder cases below fail against, for the right reason.
  resolveUserRole: jest.fn(async () => null),
  hasServerPermission: jest.fn(async () => false),
  hasServerPermissionForUser: jest.fn(),
}));

jest.mock('@/lib/server/governance/firestore-stores', () => ({
  getGovernanceRouteDeps: jest.fn(() => ({
    consents: { listDecidedConsents: jest.fn(async () => [{ id: 'consent-1' }]) },
    minutesStore: { listMinutes: jest.fn(async () => [{ id: 'minutes-1' }]) },
  })),
  toDate: (v: unknown) => (v instanceof Date ? v : null),
}));

import { NextRequest } from 'next/server';
import { FOUNDER_UID } from '@/lib/roles';
import { requireGovPermission } from '@/lib/server/governance/route-helpers';
import { GovernanceServiceError } from '@/lib/server/governance/shared';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { GET as decidedConsentsGET } from '@/app/api/governance/consents/decided/route';
import { GET as minutesGET } from '@/app/api/governance/minutes/route';

const mockPermForUser = hasServerPermissionForUser as jest.Mock;

function req(token?: string) {
  return new NextRequest('http://localhost/api/governance/x', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function expectGovError(promise: Promise<unknown>, code: string, status: number) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GovernanceServiceError);
  expect((err as GovernanceServiceError).code).toBe(code);
  expect((err as GovernanceServiceError).status).toBe(status);
  return err as GovernanceServiceError;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState.uid = 'admin-1';
  mockState.db = { __fakeDb: true };
  mockPermForUser.mockResolvedValue(false);
});

describe('requireGovPermission (Fix 2)', () => {
  it('no token rejects 401 unauthorized and never touches the permission helper', async () => {
    await expectGovError(requireGovPermission(req(), 'canViewGovernance'), 'unauthorized', 401);
    expect(mockPermForUser).not.toHaveBeenCalled();
  });

  it('founder UID resolves with NO permission lookup (UID arm never depends on stored roles)', async () => {
    mockState.uid = FOUNDER_UID;
    await expect(requireGovPermission(req('tok'), 'canViewGovernance')).resolves.toBe(FOUNDER_UID);
    expect(mockPermForUser).not.toHaveBeenCalled();
  });

  it('a holder of the required key passes, evaluated holder-scoped with (db, uid, key)', async () => {
    mockPermForUser.mockResolvedValue(true);
    await expect(requireGovPermission(req('tok'), 'canViewGovernance')).resolves.toBe('admin-1');
    expect(mockPermForUser).toHaveBeenCalledTimes(1);
    expect(mockPermForUser).toHaveBeenCalledWith(mockState.db, 'admin-1', 'canViewGovernance');
  });

  it('a non-holder gets the identical pre-change 403 shape', async () => {
    mockPermForUser.mockResolvedValue(false);
    const err = await expectGovError(
      requireGovPermission(req('tok'), 'canManageMeetings'),
      'forbidden',
      403,
    );
    expect(err.message).toBe('Missing permission: canManageMeetings');
  });

  it('missing db for a non-founder rejects 503 firestore_unavailable', async () => {
    mockState.db = null;
    const err = await expectGovError(
      requireGovPermission(req('tok'), 'canViewGovernance'),
      'firestore_unavailable',
      503,
    );
    expect(err.message).toBe('Admin SDK is not configured');
    expect(mockPermForUser).not.toHaveBeenCalled();
  });

  it('missing db does NOT block the founder (short-circuit runs before the db guard)', async () => {
    mockState.uid = FOUNDER_UID;
    mockState.db = null;
    await expect(requireGovPermission(req('tok'), 'canViewGovernance')).resolves.toBe(FOUNDER_UID);
  });

  it.each(['canViewGovernance', 'canManageMeetings', 'canSignMinutes'] as const)(
    'passes the key %s through verbatim to the holder-scoped check',
    async (key) => {
      mockPermForUser.mockResolvedValue(true);
      await expect(requireGovPermission(req('tok'), key)).resolves.toBe('admin-1');
      expect(mockPermForUser).toHaveBeenCalledWith(mockState.db, 'admin-1', key);
    },
  );
});

// Representative consumers of the 13 repaired route files (plan 4.3 /
// task brief): the routes themselves are unchanged — only the shared
// helper's verdict changes, from always-403 to permission-checked.
describe('representative consumers through the real route-helpers', () => {
  it('F5 GET /api/governance/consents/decided: founder reaches the service (200)', async () => {
    mockState.uid = FOUNDER_UID;
    const res = await decidedConsentsGET(req('tok'));
    expect(res.status).toBe(200);
    expect((await res.json()).consents).toEqual([{ id: 'consent-1' }]);
  });

  it('F5 GET /api/governance/consents/decided: a canViewGovernance holder reaches the service (200)', async () => {
    mockPermForUser.mockResolvedValue(true);
    const res = await decidedConsentsGET(req('tok'));
    expect(res.status).toBe(200);
  });

  it('F5 GET /api/governance/consents/decided: a non-holder keeps the exact 403 body', async () => {
    const res = await decidedConsentsGET(req('tok'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Missing permission: canViewGovernance',
      error_code: 'forbidden',
    });
  });

  it('F14 GET /api/governance/minutes: a canViewGovernance holder reaches the service (200)', async () => {
    mockPermForUser.mockResolvedValue(true);
    const res = await minutesGET(req('tok'));
    expect(res.status).toBe(200);
    expect((await res.json()).minutes).toEqual([{ id: 'minutes-1' }]);
  });

  it('F14 GET /api/governance/minutes: unauthenticated stays 401', async () => {
    const res = await minutesGET(req());
    expect(res.status).toBe(401);
    expect((await res.json()).error_code).toBe('unauthorized');
  });
});
