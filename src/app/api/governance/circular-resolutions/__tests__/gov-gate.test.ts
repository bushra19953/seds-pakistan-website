/**
 * @jest-environment node
 *
 * Agent 14 (Test Author B): requireGovPermission gate tests for the
 * circular-resolutions route family (Fix 2 repaired files F-circ):
 *   - GET  /api/governance/circular-resolutions            (canViewGovernance)
 *   - POST /api/governance/circular-resolutions            (canManageMeetings)
 *   - GET  /api/governance/circular-resolutions/[id]       (canViewGovernance)
 *   - POST /api/governance/circular-resolutions/[id]/circulate (canManageMeetings)
 *
 * The REAL route-helpers runs; only auth, firebase-admin, the
 * holder-scoped permission check, governance-enabled, route deps and
 * the circular service are mocked (same seams as route-helpers.test.ts).
 * The permission mock is KEY-AWARE: a caller only passes when the route
 * asks for a key in mockState.held, so each case also pins the key.
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
  verifyIdTokenString: jest.fn(async () => ({
    uid: mockState.uid,
    name: 'Gate Tester',
    email: 'gate@tester.test',
  })),
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

jest.mock('@/lib/server/governance/settings', () => ({
  requireGovernanceEnabled: jest.fn(async () => undefined),
}));

jest.mock('@/lib/server/governance/firestore-stores', () => ({
  getGovernanceRouteDeps: jest.fn(() => ({
    circularStore: {
      listResolutions: jest.fn(async () => [{ id: 'res-1' }]),
      getResolution: jest.fn(async () => ({ id: 'res-1' })),
      nextId: () => 'res-new',
    },
    consents: { listDecidedConsents: jest.fn(async () => [{ id: 'consent-1' }]) },
    bodies: {},
    classes: {},
    decisions: {},
    filingTasks: {},
  })),
  toDate: (v: unknown) => (v instanceof Date ? v : null),
}));

jest.mock('@/lib/server/governance/circular', () => ({
  noopCircularNotifier: {},
  createCircularDraft: jest.fn(async () => ({ id: 'res-new' })),
  circulateCircular: jest.fn(async () => ({ id: 'res-1', status: 'circulating' })),
}));

import { NextRequest } from 'next/server';
import { FOUNDER_UID } from '@/lib/roles';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { GET as listGET, POST as createPOST } from '../route';
import { GET as detailGET } from '../[resolutionId]/route';
import { POST as circulatePOST } from '../[resolutionId]/circulate/route';

const mockPerm = hasServerPermissionForUser as jest.Mock;
const ctx = { params: Promise.resolve({ resolutionId: 'res-1' }) };
const URL_BASE = 'http://localhost/api/governance/circular-resolutions';

function req(opts: { token?: string; method?: string; url?: string; body?: unknown } = {}) {
  return new NextRequest(opts.url ?? URL_BASE, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
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

const CREATE_BODY = {
  bodyId: 'body-1',
  title: 'Approve the budget',
  decisionClassId: 'class-1',
  text: 'Resolved that the budget is approved.',
};

describe('GET /circular-resolutions (canViewGovernance)', () => {
  it('holder passes the gate (200, not the old always-403)', async () => {
    as('holder-1', ['canViewGovernance']);
    const res = await listGET(req({ token: 'tok' }));
    expect(res.status).toBe(200);
    expect((await res.json()).resolutions).toEqual([{ id: 'res-1' }]);
    expect(mockPerm).toHaveBeenCalledWith(expect.anything(), 'holder-1', 'canViewGovernance');
  });
  it('authenticated non-holder gets 403 forbidden with the exact body', async () => {
    as('holder-1', ['canManageMeetings']);
    const res = await listGET(req({ token: 'tok' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Missing permission: canViewGovernance',
      error_code: 'forbidden',
    });
  });
  it('founder passes with NO permission lookup', async () => {
    as(FOUNDER_UID);
    const res = await listGET(req({ token: 'tok' }));
    expect(res.status).toBe(200);
    expect(mockPerm).not.toHaveBeenCalled();
  });
  it('unauthenticated gets 401 unauthorized', async () => {
    const res = await listGET(req());
    expect(res.status).toBe(401);
    expect((await res.json()).error_code).toBe('unauthorized');
  });
});

describe('POST /circular-resolutions (canManageMeetings)', () => {
  it('holder passes the gate (201)', async () => {
    as('holder-1', ['canManageMeetings']);
    const res = await createPOST(req({ token: 'tok', method: 'POST', body: CREATE_BODY }));
    expect(res.status).toBe(201);
    expect(mockPerm).toHaveBeenCalledWith(expect.anything(), 'holder-1', 'canManageMeetings');
  });
  it('a canViewGovernance-only holder gets 403 (key is canManageMeetings)', async () => {
    as('holder-1', ['canViewGovernance']);
    const res = await createPOST(req({ token: 'tok', method: 'POST', body: CREATE_BODY }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Missing permission: canManageMeetings');
  });
  it('founder passes (201)', async () => {
    as(FOUNDER_UID);
    const res = await createPOST(req({ token: 'tok', method: 'POST', body: CREATE_BODY }));
    expect(res.status).toBe(201);
    expect(mockPerm).not.toHaveBeenCalled();
  });
  it('unauthenticated gets 401', async () => {
    const res = await createPOST(req({ method: 'POST', body: CREATE_BODY }));
    expect(res.status).toBe(401);
  });
});

describe('GET /circular-resolutions/[resolutionId] (canViewGovernance)', () => {
  it('holder passes the gate (200)', async () => {
    as('holder-1', ['canViewGovernance']);
    const res = await detailGET(req({ token: 'tok', url: `${URL_BASE}/res-1` }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).resolution).toEqual({ id: 'res-1' });
  });
  it('non-holder gets 403', async () => {
    const res = await detailGET(req({ token: 'tok', url: `${URL_BASE}/res-1` }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error_code).toBe('forbidden');
  });
  it('founder passes (200)', async () => {
    as(FOUNDER_UID);
    const res = await detailGET(req({ token: 'tok', url: `${URL_BASE}/res-1` }), ctx);
    expect(res.status).toBe(200);
  });
  it('unauthenticated gets 401', async () => {
    const res = await detailGET(req({ url: `${URL_BASE}/res-1` }), ctx);
    expect(res.status).toBe(401);
  });
});

describe('POST /circular-resolutions/[resolutionId]/circulate (canManageMeetings)', () => {
  const url = `${URL_BASE}/res-1/circulate`;
  it('holder passes the gate (200)', async () => {
    as('holder-1', ['canManageMeetings']);
    const res = await circulatePOST(req({ token: 'tok', method: 'POST', url }), ctx);
    expect(res.status).toBe(200);
    expect(mockPerm).toHaveBeenCalledWith(expect.anything(), 'holder-1', 'canManageMeetings');
  });
  it('non-holder gets 403', async () => {
    const res = await circulatePOST(req({ token: 'tok', method: 'POST', url }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Missing permission: canManageMeetings');
  });
  it('founder passes (200)', async () => {
    as(FOUNDER_UID);
    const res = await circulatePOST(req({ token: 'tok', method: 'POST', url }), ctx);
    expect(res.status).toBe(200);
  });
  it('unauthenticated gets 401', async () => {
    const res = await circulatePOST(req({ method: 'POST', url }), ctx);
    expect(res.status).toBe(401);
  });
});
