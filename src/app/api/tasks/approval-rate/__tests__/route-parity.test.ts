/**
 * @jest-environment node
 *
 * Permission-parity (Family E, E7): approval-rate gate must use
 * hasServerPermissionForUser(getDb(), auth.user.userId, 'canManageTasks').
 * Canonical holder: primary `member` + custom_verify_design_aide grant.
 * Auth mock uses the real shape (userId, NOT uid).
 */
const HOLDER = 'holder-1';
const mockForUser = jest.fn();
const mockDb = { __db: true };

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number; private payload: any;
    constructor(payload: any, init?: { status?: number }) { this.payload = payload; this.status = init?.status ?? 200; }
    static json(payload: any, init?: { status?: number }) { return new MockNextResponse(payload, init); }
    async json() { return this.payload; }
  }
  return { NextRequest: class {}, NextResponse: MockNextResponse };
});
jest.mock('@/lib/server/firebase-admin', () => ({ ensureAdminInitialized: () => true, getDb: () => mockDb }));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({
    authenticated: true,
    user: { user: { uid: HOLDER }, userId: HOLDER, email: 'holder@example.com', displayName: 'Holder', emailVerified: true, role: 'member' },
  }),
}));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(false),
  hasServerPermissionForUser: (...args: any[]) => mockForUser(...args),
}));
jest.mock('@/lib/server/task-approval-rate', () => ({
  getLast10ApprovalRate: async () => ({ decidedCount: 0, approvedCount: 0, approvalRate: null }),
}));

import { GET } from '../route';

function makeRequest(): any { return { url: `http://localhost/api/tasks/approval-rate?uid=submitter-1` }; }

beforeEach(() => { jest.clearAllMocks(); });

it('custom grant holder passes the gate', async () => {
  mockForUser.mockResolvedValue(true);
  const res: any = await GET(makeRequest());
  expect(res.status).toBe(200);
  expect(mockForUser).toHaveBeenCalledWith(mockDb, HOLDER, 'canManageTasks');
});

it('no/expired grant is denied with the original body', async () => {
  mockForUser.mockResolvedValue(false);
  const res: any = await GET(makeRequest());
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "Forbidden: 'canManageTasks' access required" });
});
