/**
 * @jest-environment node
 *
 * Agent 14 (Test Author B): requireGovPermission gate tests for
 *   GET /api/governance/decisions (canViewGovernance) — Fix 2 repaired.
 *
 * REAL route-helpers; auth and the holder-scoped permission check are
 * mocked at the route-helpers.test.ts seams. firebase-admin's getDb
 * returns an in-memory chain stub (ZERO live Firestore) that satisfies
 * both the helper's db guard and this route's own decisions query.
 * The permission mock is KEY-AWARE (mockState.held).
 */

const mockState: { uid: string; held: Set<string> } = {
  uid: 'holder-1',
  held: new Set(),
};

function mockMakeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain.where = () => chain;
  chain.orderBy = () => chain;
  chain.limit = () => chain;
  chain.get = async () => ({ docs: [] });
  chain.doc = (id: string) => ({
    get: async () => ({ exists: true, id, data: () => ({ title: 'A decision' }) }),
  });
  return chain;
}

jest.mock('@/lib/auth/verifySession', () => ({
  extractBearerToken: (req: { headers: { get(name: string): string | null } }) => {
    const header = req.headers.get('authorization');
    return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  },
  verifyIdTokenString: jest.fn(async () => ({ uid: mockState.uid })),
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => ({ __fakeDb: true, collection: () => mockMakeChain() }),
}));

jest.mock('@/lib/server/permissions', () => ({
  resolveUserRole: jest.fn(async () => null),
  hasServerPermission: jest.fn(async () => false),
  hasServerPermissionForUser: jest.fn(
    async (_db: unknown, _uid: string, key: string) => mockState.held.has(key),
  ),
}));

jest.mock('@/lib/server/governance/firestore-stores', () => ({
  getGovernanceRouteDeps: jest.fn(() => ({})),
  toDate: (v: unknown) => (v instanceof Date ? v : null),
}));

import { NextRequest } from 'next/server';
import { FOUNDER_UID } from '@/lib/roles';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { GET } from '../route';

const mockPerm = hasServerPermissionForUser as jest.Mock;
const URL = 'http://localhost/api/governance/decisions';

function req(token?: string, url = URL) {
  return new NextRequest(url, {
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

describe('GET /decisions (canViewGovernance)', () => {
  it('holder passes the gate (200, empty register)', async () => {
    as('holder-1', ['canViewGovernance']);
    const res = await GET(req('tok'));
    expect(res.status).toBe(200);
    expect((await res.json()).decisions).toEqual([]);
    expect(mockPerm).toHaveBeenCalledWith(expect.anything(), 'holder-1', 'canViewGovernance');
  });
  it('holder passes the gate on the single-read (?id=) arm too (200)', async () => {
    as('holder-1', ['canViewGovernance']);
    const res = await GET(req('tok', `${URL}?id=decision-1`));
    expect(res.status).toBe(200);
    expect((await res.json()).decision.id).toBe('decision-1');
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
  it('founder passes with NO permission lookup', async () => {
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
