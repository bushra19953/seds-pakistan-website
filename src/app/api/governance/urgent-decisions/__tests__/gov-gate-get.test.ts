/**
 * @jest-environment node
 *
 * Agent 14 (Test Author B): requireGovPermission gate tests for the
 * GET arm of /api/governance/urgent-decisions (canViewGovernance) —
 * consumer F16 of the repaired helper (Fix 2).
 *
 * Scope: the POST arm of this file is the FOUND-NOT-FIXED
 * characterization pinned in the neighbouring route.test.ts (1-arg
 * resolveUserRole -> president_only for everyone, Founder refused BY
 * DESIGN). This file covers ONLY the repaired GET gate, directly at
 * the route (the pre-existing coverage was indirect, via the
 * representative consumers in route-helpers.test.ts).
 *
 * REAL route-helpers; auth / firebase-admin / holder-scoped permission
 * check / governance-enabled / route deps / urgent service mocked.
 * The permission mock is KEY-AWARE (mockState.held).
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
  // resolveUserRole is mocked here ONLY because this route file imports
  // it for its (untested-here) POST arm; the GET gate never calls it.
  resolveUserRole: jest.fn(async () => null),
  hasServerPermission: jest.fn(async () => false),
  hasServerPermissionForUser: jest.fn(
    async (_db: unknown, _uid: string, key: string) => mockState.held.has(key),
  ),
}));

jest.mock('@/lib/server/governance/settings', () => ({
  requireGovernanceEnabled: jest.fn(async () => undefined),
}));

jest.mock('@/lib/server/governance/firestore-stores', () => ({
  getGovernanceRouteDeps: jest.fn(() => ({
    urgentStore: {
      listDecisions: jest.fn(async () => [{ id: 'urgent-1' }]),
      nextId: () => 'urgent-new',
    },
    classes: {},
    decisions: {},
    bodies: {},
  })),
  toDate: (v: unknown) => (v instanceof Date ? v : null),
}));

jest.mock('@/lib/server/governance/urgent', () => ({
  noopUrgentNotifier: {},
  submitUrgentDecision: jest.fn(async () => ({ record: { id: 'urgent-new' } })),
}));

import { NextRequest } from 'next/server';
import { FOUNDER_UID } from '@/lib/roles';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { GET } from '../route';

const mockPerm = hasServerPermissionForUser as jest.Mock;
const URL = 'http://localhost/api/governance/urgent-decisions';

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

describe('GET /urgent-decisions (canViewGovernance, repaired F16)', () => {
  it('holder passes the gate (200, not the old always-403)', async () => {
    as('holder-1', ['canViewGovernance']);
    const res = await GET(req('tok'));
    expect(res.status).toBe(200);
    expect((await res.json()).decisions).toEqual([{ id: 'urgent-1' }]);
    expect(mockPerm).toHaveBeenCalledWith(expect.anything(), 'holder-1', 'canViewGovernance');
  });
  it('authenticated non-holder gets 403 with the exact body', async () => {
    as('holder-1', ['canManageMeetings']);
    const res = await GET(req('tok'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Missing permission: canViewGovernance',
      error_code: 'forbidden',
    });
  });
  it('founder passes the GET gate with NO permission lookup (unlike the POST president_only design)', async () => {
    as(FOUNDER_UID);
    const res = await GET(req('tok'));
    expect(res.status).toBe(200);
    expect(mockPerm).not.toHaveBeenCalled();
  });
  it('unauthenticated gets 401 unauthorized', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect((await res.json()).error_code).toBe('unauthorized');
  });
});
