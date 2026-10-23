/**
 * @jest-environment node
 *
 * Permission-parity (Family E, E5): batch-delete gate. Claims arm unset, so
 * the Firestore arm must use hasServerPermissionForUser for the canonical
 * holder (primary `member` + custom_verify_design_aide canManageTasks grant).
 */
const HOLDER = 'holder-1';
const mockForUser = jest.fn();

const mockDb = {
  collection: (name: string) => {
    if (name === 'roles') return { doc: () => ({ get: async () => ({ exists: true, data: () => ({ role: 'member', additionalRoles: ['custom_verify_design_aide'] }) }) }) };
    if (name === 'tasks') return { doc: (id: string) => ({ id }) };
    if (name === 'users') return { doc: (id: string) => ({ id }) };
    throw new Error(`unexpected collection ${name}`);
  },
  getAll: async () => [{ exists: false }],
  batch: () => ({ delete: () => undefined, set: () => undefined, commit: async () => undefined }),
};

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number; private payload: any;
    constructor(payload: any, init?: { status?: number }) { this.payload = payload; this.status = init?.status ?? 200; }
    static json(payload: any, init?: { status?: number }) { return new MockNextResponse(payload, init); }
    async json() { return this.payload; }
  }
  return { NextRequest: class {}, NextResponse: MockNextResponse };
});
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDb,
  admin: { firestore: { FieldValue: { increment: (n: number) => ({ __fv: 'increment', n }) } } },
}));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({
    authenticated: true,
    // Real AuthContext shape: userId at top level, decoded token nested at user.user.
    user: { user: { uid: HOLDER }, userId: HOLDER, email: 'holder@example.com', displayName: 'Holder', emailVerified: true, role: 'member' },
  }),
}));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(false),
  hasServerPermissionForUser: (...args: any[]) => mockForUser(...args),
}));

import { DELETE } from '../route';

function makeRequest(body: any): any { return { json: async () => body }; }

beforeEach(() => { jest.clearAllMocks(); });

it('custom grant holder passes the gate', async () => {
  mockForUser.mockResolvedValue(true);
  const res: any = await DELETE(makeRequest({ taskIds: ['t1'] }));
  expect(res.status).toBe(200);
  expect(mockForUser).toHaveBeenCalledWith(mockDb, HOLDER, 'canManageTasks');
});

it('no/expired grant is denied with the original body', async () => {
  mockForUser.mockResolvedValue(false);
  const res: any = await DELETE(makeRequest({ taskIds: ['t1'] }));
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: 'Forbidden: insufficient privileges' });
});
