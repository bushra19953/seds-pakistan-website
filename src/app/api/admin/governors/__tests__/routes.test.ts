/**
 * @jest-environment node
 *
 * Governor admin route authorization (spec C.7 cases 22-27). The register
 * module is stubbed; these tests pin the HTTP gates in http.ts and the
 * export keeper restriction.
 */

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(),
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => ({ __fake: true }),
  ensureAdminInitialized: () => true,
}));

jest.mock('@/lib/server/governance-audit', () => ({
  writeGovernanceAuditOrThrow: jest.fn().mockResolvedValue('audit-1'),
  GovernanceAuditError: class GovernanceAuditError extends Error {},
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
      summary: { seatedCount: 1, vacantCount: 8, expiringWithin90Days: 0, quorum: 'q' },
    }),
    assignSeat: jest.fn().mockResolvedValue({ seatKey: 'seat_fa_1', effectiveStatus: 'seated' }),
    vacateSeat: jest.fn(),
    removeSeat: jest.fn(),
    updateSeatNotes: jest.fn(),
    seedGovernors: jest.fn(),
  };
});

import { NextRequest } from 'next/server';
import { GET as registerGET } from '@/app/api/admin/governors/register/route';
import { POST as assignPOST } from '@/app/api/admin/governors/seats/[seatKey]/assign/route';
import { GET as exportGET } from '@/app/api/admin/governors/export/route';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { FOUNDER_UID } from '@/lib/roles';

const mockAuth = verifyAuthentication as jest.Mock;
const mockAudit = writeGovernanceAuditOrThrow as jest.Mock;

function asUser(userId: string, role: string) {
  mockAuth.mockResolvedValue({ authenticated: true, user: { userId, role } });
}

function getReq(url = 'http://localhost/api/admin/governors/register') {
  return new NextRequest(url, { method: 'GET' });
}

function assignReq(seatKey: string) {
  return new NextRequest(`http://localhost/api/admin/governors/seats/${seatKey}/assign`, {
    method: 'POST',
    body: JSON.stringify({ holderName: 'X', expectedVersion: 1 }),
  });
}

const seatParams = (seatKey: string) => ({ params: Promise.resolve({ seatKey }) });

beforeEach(() => jest.clearAllMocks());

it('register GET rejects an unauthenticated request 401 (case 22)', async () => {
  mockAuth.mockResolvedValue({ authenticated: false, user: null });
  const res = await registerGET(getReq());
  expect(res.status).toBe(401);
});

it('register GET rejects a CTO with no governor or NGS role 403 (case 23)', async () => {
  asUser('cto-1', 'chief_technology_officer');
  const res = await registerGET(getReq());
  expect(res.status).toBe(403);
});

it('register GET rejects a chapter officer 403 (case 23)', async () => {
  asUser('officer-1', 'chapter_president');
  const res = await registerGET(getReq());
  expect(res.status).toBe(403);
});

it('register GET allows the NGS, a Governor, and the Founder (case 24)', async () => {
  asUser('ngs-1', 'national_general_secretary');
  expect((await registerGET(getReq())).status).toBe(200);
  asUser('gov-1', 'governor_coopted');
  expect((await registerGET(getReq())).status).toBe(200);
  asUser(FOUNDER_UID, 'founder');
  expect((await registerGET(getReq())).status).toBe(200);
});

it('register GET marks canEdit false for a non-Founder Governor (case 25)', async () => {
  asUser('gov-1', 'governor_member');
  const res = await registerGET(getReq());
  expect(res.status).toBe(200);
  expect((await res.json()).canEdit).toBe(false);
});

it('a Governor (reader, not editor) cannot assign; the Founder Patron cannot assign either', async () => {
  asUser('gov-1', 'governor_coopted');
  expect((await assignPOST(assignReq('seat_fa_1'), seatParams('seat_fa_1'))).status).toBe(403);
  asUser('patron-1', 'founder_patron');
  expect((await assignPOST(assignReq('seat_fa_1'), seatParams('seat_fa_1'))).status).toBe(403);
});

it('an unknown seat key on assign is a 404', async () => {
  asUser('ngs-1', 'national_general_secretary');
  const res = await assignPOST(assignReq('seat_nope'), seatParams('seat_nope'));
  expect(res.status).toBe(404);
});

it('export rejects a non-Founder Governor and allows the NGS, writing an audit entry (case 27)', async () => {
  asUser('gov-1', 'governor_founder');
  const denied = await exportGET(getReq('http://localhost/api/admin/governors/export?format=csv'));
  expect(denied.status).toBe(403);

  asUser('ngs-1', 'national_general_secretary');
  const allowed = await exportGET(getReq('http://localhost/api/admin/governors/export?format=csv'));
  expect(allowed.status).toBe(200);
  expect(allowed.headers.get('Content-Type')).toContain('text/csv');
  expect(mockAudit).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ action: 'governors_exported', details: { format: 'csv' } }),
  );
});
