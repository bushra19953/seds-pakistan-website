/**
 * @jest-environment node
 *
 * Permission-parity (Family E, E6): attach-upload gate is
 * !isAssignee && !canManage -> 403. Only the permission operand converts to
 * hasServerPermissionForUser; the ownership (assignee) arm is untouched.
 * Canonical holder: primary `member` + custom_verify_design_aide grant.
 */
const HOLDER = 'holder-1';
const mockForUser = jest.fn();
let mockTaskData: any = { assigneeId: 'other-user' };
const mockTaskUpdate = jest.fn(async () => undefined);

const mockDb = {
  collection: (name: string) => {
    if (name !== 'tasks') throw new Error(`unexpected collection ${name}`);
    return {
      doc: (id: string) => ({
        get: async () => ({ exists: true, data: () => mockTaskData }),
        update: mockTaskUpdate,
      }),
    };
  },
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
  admin: { firestore: { FieldValue: { serverTimestamp: () => ({ __fv: 'ts' }), arrayUnion: (...v: any[]) => ({ __fv: 'au', v }) } } },
}));
jest.mock('@/lib/auth/verifySession', () => {
  class MockSessionError extends Error { statusCode = 401; }
  return {
    extractBearerToken: () => 'tok',
    verifyIdTokenString: async () => {
      const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
      return { uid: HOLDER, iss: projectId ? `https://securetoken.google.com/${projectId}` : undefined, aud: projectId };
    },
    SessionError: MockSessionError,
  };
});
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(false),
  hasServerPermissionForUser: (...args: any[]) => mockForUser(...args),
  resolveUserRole: jest.fn().mockResolvedValue('member'),
}));
jest.mock('@/lib/server/bug4-proof-guards', () => ({ shouldAutoTransitionOnProofUpload: () => false }));

import { POST } from '../route';

function makeRequest(): any {
  return {
    json: async () => ({ taskId: 'task-1', file: { fileName: 'a.pdf', driveFileId: 'drive-1' } }),
    headers: { get: () => 'Bearer tok' },
    cookies: { get: () => undefined },
  };
}

beforeEach(() => { jest.clearAllMocks(); mockTaskData = { assigneeId: 'other-user' }; });

it('custom grant holder who is NOT the assignee passes via the permission operand', async () => {
  mockForUser.mockResolvedValue(true);
  const res: any = await POST(makeRequest());
  expect(res.status).toBe(200);
  expect(mockForUser).toHaveBeenCalledWith(mockDb, HOLDER, 'canManageTasks');
});

it('no/expired grant and not the assignee: denied with the original body', async () => {
  mockForUser.mockResolvedValue(false);
  const res: any = await POST(makeRequest());
  expect(res.status).toBe(403);
  expect((await res.json()).error_code).toBe('not_assigned');
});

it('ownership arm untouched: the assignee passes even without the grant', async () => {
  mockForUser.mockResolvedValue(false);
  mockTaskData = { assigneeId: HOLDER };
  const res: any = await POST(makeRequest());
  expect(res.status).toBe(200);
});
