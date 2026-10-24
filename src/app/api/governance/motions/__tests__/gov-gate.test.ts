/**
 * @jest-environment node
 *
 * Agent 14 (Test Author B): requireGovPermission gate tests for the
 * motions route files (Fix 2 repaired):
 *   - GET  /api/governance/meetings/[meetingId]/motions (canViewGovernance)
 *   - POST /api/governance/meetings/[meetingId]/motions (canManageMeetings)
 *   - POST /api/governance/motions/[motionId]/close     (canManageMeetings)
 *
 * REAL route-helpers; auth / firebase-admin / holder-scoped permission
 * check / governance-enabled / route deps / motions+minutes services
 * mocked at the same seams as route-helpers.test.ts. The permission
 * mock is KEY-AWARE (mockState.held), pinning each route's key.
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
    motions: {
      listMotionsByMeeting: jest.fn(async () => [{ id: 'motion-1' }]),
      getMotion: jest.fn(async () => null),
      nextId: () => 'motion-new',
    },
    minutesStore: {},
    ballots: {},
    meetings: {},
    attendance: {},
    bodies: {},
    classes: {},
    decisions: {},
    filingTasks: {},
    minutesPdfPipeline: {},
  })),
  toDate: (v: unknown) => (v instanceof Date ? v : null),
}));

jest.mock('@/lib/server/governance/motions', () => ({
  openMotion: jest.fn(async () => ({ motion: { id: 'motion-new' }, matrixWarning: null })),
  closeMotion: jest.fn(async () => ({ tied: false, status: 'closed_failed' })),
}));

jest.mock('@/lib/server/governance/minutes', () => ({
  linkMinutesApproval: jest.fn(async () => ({ id: 'minutes-1', status: 'approved' })),
}));

import { NextRequest } from 'next/server';
import { FOUNDER_UID } from '@/lib/roles';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { GET as meetingMotionsGET, POST as meetingMotionsPOST } from '../../meetings/[meetingId]/motions/route';
import { POST as closePOST } from '../[motionId]/close/route';

const mockPerm = hasServerPermissionForUser as jest.Mock;
const meetingCtx = { params: Promise.resolve({ meetingId: 'meeting-1' }) };
const motionCtx = { params: Promise.resolve({ motionId: 'motion-1' }) };
const LIST_URL = 'http://localhost/api/governance/meetings/meeting-1/motions';
const CLOSE_URL = 'http://localhost/api/governance/motions/motion-1/close';

function req(opts: { token?: string; method?: string; url?: string; body?: unknown } = {}) {
  return new NextRequest(opts.url ?? LIST_URL, {
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

describe('GET /meetings/[meetingId]/motions (canViewGovernance)', () => {
  it('holder passes the gate (200)', async () => {
    as('holder-1', ['canViewGovernance']);
    const res = await meetingMotionsGET(req({ token: 'tok' }), meetingCtx);
    expect(res.status).toBe(200);
    expect((await res.json()).motions).toEqual([{ id: 'motion-1' }]);
    expect(mockPerm).toHaveBeenCalledWith(expect.anything(), 'holder-1', 'canViewGovernance');
  });
  it('non-holder gets 403 with the exact body', async () => {
    as('holder-1', ['canManageMeetings']);
    const res = await meetingMotionsGET(req({ token: 'tok' }), meetingCtx);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Missing permission: canViewGovernance',
      error_code: 'forbidden',
    });
  });
  it('founder passes with NO permission lookup', async () => {
    as(FOUNDER_UID);
    const res = await meetingMotionsGET(req({ token: 'tok' }), meetingCtx);
    expect(res.status).toBe(200);
    expect(mockPerm).not.toHaveBeenCalled();
  });
  it('unauthenticated gets 401', async () => {
    const res = await meetingMotionsGET(req(), meetingCtx);
    expect(res.status).toBe(401);
    expect((await res.json()).error_code).toBe('unauthorized');
  });
});

describe('POST /meetings/[meetingId]/motions (canManageMeetings)', () => {
  const body = { text: 'That the budget be approved', decisionClassId: 'class-1', proposerUid: 'holder-1' };
  const call = (token?: string) =>
    meetingMotionsPOST(req({ token, method: 'POST', body }), meetingCtx);
  it('holder passes the gate (201)', async () => {
    as('holder-1', ['canManageMeetings']);
    const res = await call('tok');
    expect(res.status).toBe(201);
    expect(mockPerm).toHaveBeenCalledWith(expect.anything(), 'holder-1', 'canManageMeetings');
  });
  it('a canViewGovernance-only holder gets 403', async () => {
    as('holder-1', ['canViewGovernance']);
    const res = await call('tok');
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Missing permission: canManageMeetings');
  });
  it('founder passes (201)', async () => {
    as(FOUNDER_UID);
    const res = await call('tok');
    expect(res.status).toBe(201);
    expect(mockPerm).not.toHaveBeenCalled();
  });
  it('unauthenticated gets 401', async () => {
    const res = await call(undefined);
    expect(res.status).toBe(401);
  });
});

describe('POST /motions/[motionId]/close (canManageMeetings)', () => {
  const call = (token?: string) => closePOST(req({ token, method: 'POST', url: CLOSE_URL }), motionCtx);
  it('holder passes the gate (200)', async () => {
    as('holder-1', ['canManageMeetings']);
    const res = await call('tok');
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('closed_failed');
    expect(mockPerm).toHaveBeenCalledWith(expect.anything(), 'holder-1', 'canManageMeetings');
  });
  it('non-holder gets 403 with the exact body', async () => {
    const res = await call('tok');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Missing permission: canManageMeetings',
      error_code: 'forbidden',
    });
  });
  it('founder passes (200)', async () => {
    as(FOUNDER_UID);
    const res = await call('tok');
    expect(res.status).toBe(200);
    expect(mockPerm).not.toHaveBeenCalled();
  });
  it('unauthenticated gets 401', async () => {
    const res = await call(undefined);
    expect(res.status).toBe(401);
  });
});
