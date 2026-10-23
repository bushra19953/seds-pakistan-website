/**
 * @jest-environment node
 *
 * Permission-parity (Family E, E11): single-workflow DELETE gate must use
 * hasServerPermissionForUser. Canonical holder: primary `member` +
 * custom_verify_design_aide canManageTasks grant. Auth mock uses the real
 * shape (userId, NOT uid).
 */
const HOLDER = 'holder-1';
const mockForUser = jest.fn();

const tasksQuery: any = {
  where: () => tasksQuery,
  limit: () => tasksQuery,
  get: async () => ({ empty: false, forEach: (_cb: any) => undefined }),
};
const mockDb = { collection: (name: string) => { if (name === 'tasks') return tasksQuery; throw new Error(`unexpected ${name}`); } };

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
jest.mock('@/lib/server/workflow-cascade', () => ({ deleteWorkflowCascade: jest.fn().mockResolvedValue({ deletedTasks: 1 }) }));
jest.mock('@/lib/server/workflow-audit', () => ({ logWorkflowAudit: jest.fn().mockResolvedValue(undefined) }));

import { DELETE } from '../route';

function makeRequest(): any { return { url: 'http://localhost/api/workflows/wf-1?confirm=wf-1' }; }
const params = { params: Promise.resolve({ id: 'wf-1' }) };

beforeEach(() => { jest.clearAllMocks(); });

it('custom grant holder passes the gate', async () => {
  mockForUser.mockResolvedValue(true);
  const res: any = await DELETE(makeRequest(), params);
  expect(res.status).toBe(200);
  expect(mockForUser).toHaveBeenCalledWith(mockDb, HOLDER, 'canManageTasks');
});

it('no/expired grant is denied with the original body', async () => {
  mockForUser.mockResolvedValue(false);
  const res: any = await DELETE(makeRequest(), params);
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: 'Forbidden' });
});
