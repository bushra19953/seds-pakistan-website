/**
 * @jest-environment node
 *
 * Governor admin route authorization (spec C.7 case 23 + editor matrix).
 * The register module is stubbed; these tests pin the HTTP gate in http.ts:
 * readers vs editors vs everyone else.
 */

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(),
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => ({ __fake: true }),
  ensureAdminInitialized: () => true,
}));

jest.mock('@/lib/server/governors/register', () => {
  class GovernorOpError extends Error {
    code: string;
    httpStatus: number;
    constructor(code: string, httpStatus: number, message: string) {
      super(message);
      this.code = code;
      this.httpStatus = httpStatus;
    }
  }
  return {
    GovernorOpError,
    getRegister: jest.fn().mockResolvedValue({
      seats: [],
      stats: { total: 9, seated: 1, vacant: 8, quorum: 'q', byCategory: {} },
    }),
    assignSeat: jest.fn().mockResolvedValue({ seatKey: 'seat_fa_1', status: 'seated' }),
    vacateSeat: jest.fn(),
    removeSeat: jest.fn(),
    updateSeatNotes: jest.fn(),
    seedGovernors: jest.fn(),
  };
});

import { NextRequest } from 'next/server';
import { GET as registerGET } from '@/app/api/admin/governors/register/route';
import { POST as assignPOST } from '@/app/api/admin/governors/assign/route';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { FOUNDER_UID } from '@/lib/roles';

const mockAuth = verifyAuthentication as jest.Mock;

function asUser(userId: string, role: string) {
  mockAuth.mockResolvedValue({ authenticated: true, user: { userId, role } });
}

function getReq() {
  return new NextRequest('http://localhost/api/admin/governors/register', { method: 'GET' });
}

function postReq(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/admin/governors/assign', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => jest.clearAllMocks());

it('unauthenticated callers get 401', async () => {
  mockAuth.mockResolvedValue({ authenticated: false, user: null });
  const res = await registerGET(getReq());
  expect(res.status).toBe(401);
});

it('the CTO (canAccessAdmin holder) gets 403 on the register', async () => {
  asUser('cto-1', 'chief_technology_officer');
  const res = await registerGET(getReq());
  expect(res.status).toBe(403);
});

it('an ordinary member gets 403', async () => {
  asUser('member-1', 'member');
  const res = await registerGET(getReq());
  expect(res.status).toBe(403);
});

it('a seated Governor reads with canEdit false', async () => {
  asUser('gov-1', 'governor_seat_co_1');
  const res = await registerGET(getReq());
  expect(res.status).toBe(200);
  expect((await res.json()).canEdit).toBe(false);
});

it('the NGS reads with canEdit true', async () => {
  asUser('ngs-1', 'national_general_secretary');
  const res = await registerGET(getReq());
  expect(res.status).toBe(200);
  expect((await res.json()).canEdit).toBe(true);
});

it('the Founder reads with canEdit true by UID', async () => {
  asUser(FOUNDER_UID, 'founder');
  const res = await registerGET(getReq());
  expect(res.status).toBe(200);
  expect((await res.json()).canEdit).toBe(true);
});

it('a Governor (reader, not editor) cannot assign', async () => {
  asUser('gov-1', 'governor_seat_co_1');
  const res = await assignPOST(
    postReq({ seatKey: 'seat_fa_1', holderName: 'X', expectedVersion: 1 }),
  );
  expect(res.status).toBe(403);
});

it('the Founder Patron reads but cannot assign', async () => {
  asUser('patron-1', 'founder_patron');
  const read = await registerGET(getReq());
  expect(read.status).toBe(200);
  const write = await assignPOST(
    postReq({ seatKey: 'seat_fa_1', holderName: 'X', expectedVersion: 1 }),
  );
  expect(write.status).toBe(403);
});
