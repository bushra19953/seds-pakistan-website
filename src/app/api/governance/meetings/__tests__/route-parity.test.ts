/**
 * @jest-environment node
 *
 * Family G parity tests for the governance meetings routes (G1/G2/G3).
 *
 * The gates live in FILE-LOCAL requirePermission helpers
 * (meetings/route.ts, meetings/[meetingId]/route.ts) and in the
 * attendance POST other-person arm. They now resolve through
 * hasServerPermissionForUser, so a holder whose PRIMARY role is the
 * plain catalog role `member` and whose custom grant sits in
 * additionalRoles (contracts K2) is admitted; an expired grant and a
 * missing grant keep the original 403 body byte-identical.
 *
 * The REAL @/lib/server/permissions resolver runs against an in-memory
 * FakeFirestore (the parity claim is a Firestore-shape claim). Only
 * auth, firebase-admin, and the meetings service are mocked.
 */

const HOLDER = 'holder-1';
const CUSTOM = 'custom_verify_design_aide';

const state = {
  authResult: null as any,
};

function authFor(uid: string) {
  return {
    authenticated: true,
    user: {
      user: { uid },
      userId: uid,
      email: 'holder@example.test',
      displayName: 'Holder One',
      emailVerified: true,
      role: 'member',
    },
  };
}

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDbHolder.db,
  admin: {
    firestore: {
      FieldValue: { serverTimestamp: () => 'ts', delete: () => 'del' },
    },
  },
}));

const mockMeeting = {
  id: 'meeting-1',
  bodyId: 'body-1',
  type: 'general',
  title: 'General Meeting',
  status: 'scheduled',
  scheduledAt: new Date('2026-11-01T10:00:00Z'),
  noticeSentAt: null,
  deemedReceivedAt: null,
  quorumVerifiedAt: null,
  createdAt: new Date('2026-10-20T10:00:00Z'),
  updatedAt: new Date('2026-10-20T10:00:00Z'),
};

jest.mock('@/lib/server/governance/meetings', () => ({
  createMeeting: jest.fn(async () => ({
    meetingId: 'meeting-new',
    status: 'scheduled',
    quorumRequired: 3,
    warnings: [],
  })),
  listMeetings: jest.fn(async () => []),
  getMeeting: jest.fn(async () => mockMeeting),
  cancelMeeting: jest.fn(async () => undefined),
  listAttendance: jest.fn(async () => []),
  recordAttendance: jest.fn(async (_db: unknown, input: any) => ({
    uid: input.uid,
    mode: input.mode,
    checkedInAt: new Date('2026-11-01T10:05:00Z'),
    updatedAt: new Date('2026-11-01T10:05:00Z'),
  })),
  MeetingServiceError: class MeetingServiceError extends Error {
    status = 422;
    error_code = 'meeting_error';
    earliestAllowed = null;
  },
}));

import { NextRequest } from 'next/server';
import { createFakeDb, type FakeDb } from '@/lib/server/__tests__/fake-firestore';
import { GET as listGET, POST as listPOST } from '../route';
import { GET as detailGET } from '../[meetingId]/route';
import { POST as attendancePOST } from '../[meetingId]/attendance/route';
import { recordAttendance } from '@/lib/server/governance/meetings';

const mockRecordAttendance = recordAttendance as jest.Mock;

function seedHolder(db: FakeDb, permissions: string[], expired = false) {
  db.seed('roles', HOLDER, {
    role: 'member',
    additionalRoles: [CUSTOM],
    ...(expired
      ? {
          expiresAt: new Date(Date.now() - 60_000),
          expiresRoleKey: CUSTOM,
        }
      : {}),
  });
  db.seed('roleDefinitions', CUSTOM, {
    isCustom: true,
    permissions,
  });
}

function req(method: string, url: string, body?: Record<string, unknown>) {
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const meetingCtx = { params: Promise.resolve({ meetingId: 'meeting-1' }) };

beforeEach(() => {
  jest.clearAllMocks();
  state.authResult = authFor(HOLDER);
  mockDbHolder.db = createFakeDb();
});

describe('G1/G2 meetings requirePermission helper parity', () => {
  it('holder with canManageMeetings via custom grant can list meetings (GET /meetings)', async () => {
    seedHolder(mockDbHolder.db as FakeDb, ['canManageMeetings']);
    const res = await listGET(req('GET', 'http://localhost/api/governance/meetings'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ meetings: [] });
  });

  it('holder with canViewGovernance via custom grant can read one meeting (GET /meetings/[id], first of the two helper calls)', async () => {
    seedHolder(mockDbHolder.db as FakeDb, ['canViewGovernance']);
    const res = await detailGET(
      req('GET', 'http://localhost/api/governance/meetings/meeting-1'),
      meetingCtx,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).meeting.id).toBe('meeting-1');
  });

  it('holder with canManageMeetings via custom grant can create a meeting (POST /meetings)', async () => {
    seedHolder(mockDbHolder.db as FakeDb, ['canManageMeetings']);
    const res = await listPOST(
      req('POST', 'http://localhost/api/governance/meetings', {
        bodyId: 'body-1',
        type: 'general',
        title: 'General Meeting',
        scheduledAt: '2026-11-01T10:00:00Z',
      }),
    );
    expect(res.status).toBe(201);
  });

  it('expired custom grant keeps the original 403 denial body', async () => {
    seedHolder(mockDbHolder.db as FakeDb, ['canManageMeetings', 'canViewGovernance'], true);
    const res = await listGET(req('GET', 'http://localhost/api/governance/meetings'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Permission denied',
      error_code: 'permission_denied',
    });
  });

  it('no custom grant keeps the original 403 denial body', async () => {
    (mockDbHolder.db as FakeDb).seed('roles', HOLDER, { role: 'member' });
    const res = await detailGET(
      req('GET', 'http://localhost/api/governance/meetings/meeting-1'),
      meetingCtx,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Permission denied',
      error_code: 'permission_denied',
    });
  });
});

describe('G3 attendance other-person check-in parity', () => {
  it('holder manager (canManageMeetings via custom grant) can check in another person', async () => {
    seedHolder(mockDbHolder.db as FakeDb, ['canManageMeetings']);
    const res = await attendancePOST(
      req('POST', 'http://localhost/api/governance/meetings/meeting-1/attendance', {
        uid: 'other-1',
        mode: 'in_person',
      }),
      meetingCtx,
    );
    expect(res.status).toBe(201);
    expect(mockRecordAttendance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ uid: 'other-1', actorUid: HOLDER }),
    );
  });

  it('non-holder cannot check in another person: original 403, no attendance recorded', async () => {
    (mockDbHolder.db as FakeDb).seed('roles', HOLDER, { role: 'member' });
    const res = await attendancePOST(
      req('POST', 'http://localhost/api/governance/meetings/meeting-1/attendance', {
        uid: 'other-1',
        mode: 'in_person',
      }),
      meetingCtx,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Permission denied',
      error_code: 'permission_denied',
    });
    expect(mockRecordAttendance).not.toHaveBeenCalled();
  });

  it('expired custom grant cannot check in another person', async () => {
    seedHolder(mockDbHolder.db as FakeDb, ['canManageMeetings'], true);
    const res = await attendancePOST(
      req('POST', 'http://localhost/api/governance/meetings/meeting-1/attendance', {
        uid: 'other-1',
        mode: 'electronic',
      }),
      meetingCtx,
    );
    expect(res.status).toBe(403);
    expect(mockRecordAttendance).not.toHaveBeenCalled();
  });

  it('self check-in stays ungated: a grant-less member can check themselves in', async () => {
    (mockDbHolder.db as FakeDb).seed('roles', HOLDER, { role: 'member' });
    const res = await attendancePOST(
      req('POST', 'http://localhost/api/governance/meetings/meeting-1/attendance', {
        mode: 'in_person',
      }),
      meetingCtx,
    );
    expect(res.status).toBe(201);
    expect(mockRecordAttendance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ uid: HOLDER, actorUid: HOLDER }),
    );
  });
});
