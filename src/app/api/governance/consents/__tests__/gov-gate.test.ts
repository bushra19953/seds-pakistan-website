/**
 * @jest-environment node
 *
 * Agent 14 (Test Author B): completes the gate quartet for
 *   GET /api/governance/consents/decided (canViewGovernance)
 * at the route itself. route-helpers.test.ts already covers
 * founder / holder / non-holder for this route as a representative
 * consumer; the missing case was unauthenticated (401), pinned here
 * alongside a direct re-check of the other three so this route's
 * quartet lives in one place.
 *
 * REAL route-helpers; same mock seams and KEY-AWARE permission mock
 * (mockState.held) as the other gov-gate suites.
 */

const mockState: { uid: string; held: Set<string> } = {
  uid: 'holder-1',
  held: new Set(),
};

jest.mock('@/lib/auth/verifySession', () => ({
  extractBearerToken: (req: { headers: { get(name: string): string | null } }) => {
    const header = req.headers.get('authorization');
    return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  },
  verifyIdTokenString: jest.fn(async () => ({ uid: mockState.uid })),
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => ({ __fakeDb: true }),
}));

jest.mock('@/lib/server/permissions', () => ({
  resolveUserRole: jest.fn(async () => null),
  hasServerPermission: jest.fn(async () => false),
  hasServerPermissionForUser: jest.fn(
    async (_db: unknown, _uid: string, key: string) => mockState.held.has(key),
  ),
}));

jest.mock('@/lib/server/governance/firestore-stores', () => ({
  getGovernanceRouteDeps: jest.fn(() => ({
    consents: { listDecidedConsents: jest.fn(async () => [{ id: 'consent-1' }]) },
  })),
  toDate: (v: unknown) => (v instanceof Date ? v : null),
}));

import { NextRequest } from 'next/server';
import { FOUNDER_UID } from '@/lib/roles';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { GET } from '../decided/route';

const mockPerm = hasServerPermissionForUser as jest.Mock;
const URL = 'http://localhost/api/governance/consents/decided';

function req(token?: string) {
  return new NextRequest(URL, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function as(uid: string, held: string[] = []) {
  mockState.uid = uid;
  mockState.held = new Set(held);
}

beforeEach(() => {
  jest.clearAllMocks();
  as('holder-1');
});

describe('GET /consents/decided (canViewGovernance)', () => {
  it('holder passes the gate (200)', async () => {
    as('holder-1', ['canViewGovernance']);
    const res = await GET(req('tok'));
    expect(res.status).toBe(200);
    expect((await res.json()).consents).toEqual([{ id: 'consent-1' }]);
    expect(mockPerm).toHaveBeenCalledWith(expect.anything(), 'holder-1', 'canViewGovernance');
  });
  it('authenticated non-holder gets 403 with the exact body', async () => {
    const res = await GET(req('tok'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Missing permission: canViewGovernance',
      error_code: 'forbidden',
    });
  });
  it('founder passes with NO permission lookup', async () => {
    as(FOUNDER_UID);
    const res = await GET(req('tok'));
    expect(res.status).toBe(200);
    expect(mockPerm).not.toHaveBeenCalled();
  });
  it('unauthenticated gets 401 unauthorized (the previously missing case)', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect((await res.json()).error_code).toBe('unauthorized');
    expect(mockPerm).not.toHaveBeenCalled();
  });
});
