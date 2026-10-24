/**
 * @jest-environment node
 *
 * Agent 14 (Test Author B): requireGovPermission gate tests for the
 * minutes route family (Fix 2 repaired files):
 *   - GET   /api/governance/minutes                          (canViewGovernance)
 *   - GET   /api/governance/minutes/[minutesId]              (canViewGovernance)
 *   - PATCH /api/governance/minutes/[minutesId]              (canManageMeetings)
 *   - POST  /api/governance/minutes/[minutesId]/circulate    (canManageMeetings)
 *   - POST  /api/governance/minutes/[minutesId]/approve-link (canManageMeetings)
 *   - POST  /api/governance/minutes/[minutesId]/sign         (canSignMinutes)
 *
 * REAL route-helpers; auth / firebase-admin / holder-scoped permission
 * check / governance-enabled / route deps / minutes service mocked at
 * the same seams as route-helpers.test.ts. The permission mock is
 * KEY-AWARE (mockState.held), so each case also pins the route's key.
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
    minutesStore: {
      listMinutes: jest.fn(async () => [{ id: 'minutes-1' }]),
      getMinutes: jest.fn(async () => ({ id: 'minutes-1', meetingId: 'meeting-1' })),
    },
    attendance: { listPresentUids: jest.fn(async () => ['holder-1']) },
    motions: {},
    minutesPdfPipeline: {},
  })),
  toDate: (v: unknown) => (v instanceof Date ? v : null),
}));

jest.mock('@/lib/server/governance/minutes', () => ({
  editMinutes: jest.fn(async () => ({ id: 'minutes-1' })),
  circulateMinutesService: jest.fn(async () => ({ id: 'minutes-1', status: 'circulated' })),
  linkMinutesApproval: jest.fn(async () => ({ id: 'minutes-1', status: 'approved' })),
  signMinutesService: jest.fn(async () => ({
    record: { id: 'minutes-1', status: 'signed_locked' },
    pdf: { fileId: 'file-1' },
  })),
}));

import { NextRequest } from 'next/server';
import { FOUNDER_UID } from '@/lib/roles';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { GET as listGET } from '../route';
import { GET as detailGET, PATCH as detailPATCH } from '../[minutesId]/route';
import { POST as circulatePOST } from '../[minutesId]/circulate/route';
import { POST as approveLinkPOST } from '../[minutesId]/approve-link/route';
import { POST as signPOST } from '../[minutesId]/sign/route';

const mockPerm = hasServerPermissionForUser as jest.Mock;
const ctx = { params: Promise.resolve({ minutesId: 'minutes-1' }) };
const BASE = 'http://localhost/api/governance/minutes';

function req(opts: { token?: string; method?: string; url?: string; body?: unknown } = {}) {
  return new NextRequest(opts.url ?? BASE, {
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

/** The full gate quartet for one handler: holder / non-holder / founder / unauthenticated. */
function quartet(
  name: string,
  key: string,
  okStatus: number,
  call: (r: NextRequest) => Promise<Response>,
  makeReq: (token?: string) => NextRequest,
) {
  describe(name, () => {
    it(`holder of ${key} passes the gate (${okStatus}, not the old always-403)`, async () => {
      as('holder-1', [key]);
      const res = await call(makeReq('tok'));
      expect(res.status).toBe(okStatus);
      expect(mockPerm).toHaveBeenCalledWith(expect.anything(), 'holder-1', key);
    });
    it(`authenticated holder WITHOUT ${key} gets 403 forbidden`, async () => {
      as('holder-1', ['canViewGovernance', 'canManageMeetings', 'canSignMinutes'].filter((k) => k !== key));
      const res = await call(makeReq('tok'));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: `Missing permission: ${key}`,
        error_code: 'forbidden',
      });
    });
    it('founder passes with NO permission lookup', async () => {
      as(FOUNDER_UID);
      const res = await call(makeReq('tok'));
      expect(res.status).toBe(okStatus);
      expect(mockPerm).not.toHaveBeenCalled();
    });
    it('unauthenticated gets 401 unauthorized', async () => {
      const res = await call(makeReq(undefined));
      expect(res.status).toBe(401);
      expect((await res.json()).error_code).toBe('unauthorized');
    });
    void req;
  });
}

quartet(
  'GET /minutes (canViewGovernance)',
  'canViewGovernance',
  200,
  (r) => listGET(r),
  (token) => req({ token }),
);

quartet(
  'GET /minutes/[minutesId] (canViewGovernance)',
  'canViewGovernance',
  200,
  (r) => detailGET(r, ctx),
  (token) => req({ token, url: `${BASE}/minutes-1` }),
);

quartet(
  'PATCH /minutes/[minutesId] (canManageMeetings)',
  'canManageMeetings',
  200,
  (r) => detailPATCH(r, ctx),
  (token) => req({ token, method: 'PATCH', url: `${BASE}/minutes-1`, body: { venue: 'Room 131' } }),
);

quartet(
  'POST /minutes/[minutesId]/circulate (canManageMeetings)',
  'canManageMeetings',
  200,
  (r) => circulatePOST(r, ctx),
  (token) => req({ token, method: 'POST', url: `${BASE}/minutes-1/circulate` }),
);

quartet(
  'POST /minutes/[minutesId]/approve-link (canManageMeetings)',
  'canManageMeetings',
  200,
  (r) => approveLinkPOST(r, ctx),
  (token) =>
    req({ token, method: 'POST', url: `${BASE}/minutes-1/approve-link`, body: { approvalMotionId: 'motion-1' } }),
);

quartet(
  'POST /minutes/[minutesId]/sign (canSignMinutes)',
  'canSignMinutes',
  200,
  (r) => signPOST(r, ctx),
  (token) => req({ token, method: 'POST', url: `${BASE}/minutes-1/sign` }),
);
