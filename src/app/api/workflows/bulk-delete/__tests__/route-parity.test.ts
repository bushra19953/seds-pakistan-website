/**
 * @jest-environment node
 *
 * Permission-parity (Family E, E13): bulk-delete gate must use
 * hasServerPermissionForUser. Canonical holder: primary `member` +
 * custom_verify_design_aide canManageTasks grant. Auth mock uses the real
 * shape (userId, NOT uid).
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
    user: { user: { uid: HOLDER }, userId: HOLDER, email: 'h@example.com', displayName: 'H', emailVerified: true, role: 'member' },
  }),
}));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(false),
  hasServerPermissionForUser: (...args: any[]) => mockForUser(...args),
}));
jest.mock('@/lib/server/workflow-cascade', () => ({ deleteWorkflowCascade: jest.fn() }));
jest.mock('@/lib/server/workflow-audit', () => ({ logWorkflowAudit: jest.fn().mockResolvedValue(undefined) }));

import { POST } from '../route';

function makeRequest(body: any): any { return { json: async () => body }; }
beforeEach(() => { jest.clearAllMocks(); });

it('custom grant holder passes the gate (reaches body validation)', async () => {
  mockForUser.mockResolvedValue(true);
  const res: any = await POST(makeRequest({ ids: [], confirm: true }));
  expect(res.status).toBe(400);
  expect(mockForUser).toHaveBeenCalledWith(mockDb, HOLDER, 'canManageTasks');
});

it('no/expired grant is denied with the original body', async () => {
  mockForUser.mockResolvedValue(false);
  const res: any = await POST(makeRequest({ ids: ['wf-1'], confirm: true }));
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: 'Forbidden: task management permission required' });
});
