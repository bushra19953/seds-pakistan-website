/**
 * @jest-environment node
 *
 * Permission-parity (Family E, sites E1-E4): the tasks route gates must
 * consult hasServerPermissionForUser (holder-scoped: primary role UNION
 * held custom grants) instead of the primary-only hasServerPermission.
 *
 * Canonical holder fixture: primary `member` (no canManageTasks),
 * additionalRoles ['custom_verify_design_aide'] whose definition grants
 * canManageTasks. The permissions module is mocked so each test sets the
 * holder-scoped answer directly (grant held -> true, no/expired grant ->
 * false); the claims arm stays unset so the Firestore arm is exercised.
 */

const HOLDER = 'holder-1';

const mockForUser = jest.fn();
let mockTaskData: any = { assigneeId: 'other-user', assignerId: 'other-user', status: 'pending' };
const mockTaskDelete = jest.fn(async () => undefined);

const queryChain: any = {
  where: () => queryChain,
  orderBy: () => queryChain,
  limit: () => queryChain,
  startAfter: () => queryChain,
  get: async () => ({ docs: [] }),
};

const mockDb = {
  collection: (name: string) => {
    if (name === 'roles') {
      return {
        doc: (uid: string) => ({
          get: async () => ({
            exists: true,
            data: () => ({ role: 'member', additionalRoles: ['custom_verify_design_aide'] }),
          }),
        }),
      };
    }
    if (name === 'tasks') {
      return {
        ...queryChain,
        doc: (id: string) => ({
          id,
          get: async () => ({ exists: true, data: () => mockTaskData, ref: { id } }),
          delete: mockTaskDelete,
          update: async () => undefined,
          collection: () => ({ doc: () => ({ set: async () => undefined }) }),
        }),
      };
    }
    if (name === 'users') {
      return {
        doc: (uid: string) => ({
          get: async () => ({ exists: false, data: () => undefined }),
          set: async () => undefined,
        }),
      };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
  batch: () => ({ set: () => undefined, update: () => undefined, delete: () => undefined, commit: async () => undefined }),
};

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number;
    private payload: any;
    constructor(payload: any, init?: { status?: number }) {
      this.payload = payload;
      this.status = init?.status ?? 200;
    }
    static json(payload: any, init?: { status?: number }) {
      return new MockNextResponse(payload, init);
    }
    async json() {
      return this.payload;
    }
  }
  return { NextRequest: class {}, NextResponse: MockNextResponse };
});

jest.mock('@/lib/server/firebase-admin', () => {
  const FieldValue = {
    delete: () => ({ __fv: 'delete' }),
    serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
    arrayUnion: (...vals: any[]) => ({ __fv: 'arrayUnion', vals }),
    increment: (n: number) => ({ __fv: 'increment', n }),
  };
  return {
    admin: {
      firestore: {
        Timestamp: {
          now: () => ({ __ts: 'now' }),
          fromDate: (d: Date) => ({ __ts: 'fromDate', ms: d.getTime() }),
          fromMillis: (ms: number) => ({ __ts: 'fromMillis', ms }),
        },
        FieldValue,
      },
      messaging: () => ({ sendEachForMulticast: async () => ({ successCount: 0 }) }),
    },
    getDb: () => mockDb,
  };
});

jest.mock('@/lib/auth/verifySession', () => {
  class MockSessionError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 401) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  return {
    extractBearerToken: () => 'test-bearer-token',
    // No claims permissions: the Firestore (holder-scoped) arm must decide.
    verifyIdTokenString: async () => ({ uid: HOLDER, email: 'holder@example.com' }),
    SessionError: MockSessionError,
  };
});

jest.mock('@/lib/mailer', () => ({ sendEmailNotification: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/server/user-status', () => ({ validateUserStatus: jest.fn().mockResolvedValue({ isValid: true }) }));
jest.mock('@/lib/server/gamification-transaction', () => ({ executeGamificationTransaction: jest.fn() }));
jest.mock('@/lib/server/hierarchy-utils', () => ({
  isManagerAbove: jest.fn().mockResolvedValue(false),
  getDirectSubordinates: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/server/hierarchy', () => ({
  canValidateTask: jest.fn(),
  getValidatorChainUids: jest.fn().mockResolvedValue([]),
  resolveDisplayName: jest.fn().mockResolvedValue('Test User'),
}));
jest.mock('@/lib/server/validation-notifications', () => ({
  notifyValidatorsOnSubmission: jest.fn(),
  notifyOnDecision: jest.fn(),
  notifyAcceptanceRequest: jest.fn(),
  notifyChainOnDecline: jest.fn(),
}));
jest.mock('@/lib/server/validation-audit', () => ({
  logValidationDecision: jest.fn(),
  logDeniedValidationAttempt: jest.fn(),
}));
jest.mock('@/lib/server/discipline/suspension', () => ({ suspensionBlock: jest.fn().mockResolvedValue(null) }));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(false),
  hasServerPermissionForUser: (...args: any[]) => mockForUser(...args),
  resolveUserRole: jest.fn().mockResolvedValue('member'),
  assertChapterAccess: jest.fn().mockResolvedValue({ allowed: true }),
}));

import { GET, POST, PATCH, DELETE } from '../route';

function makeRequest(body?: any, url = 'http://localhost/api/tasks'): any {
  const req: any = {
    json: async () => body ?? {},
    nextUrl: new URL(url),
    url,
    headers: { get: () => null },
    cookies: { get: () => undefined },
  };
  req.clone = () => req;
  return req;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockForUser.mockResolvedValue(false);
  mockTaskData = { assigneeId: 'other-user', assignerId: 'other-user', status: 'pending' };
});

describe('E3 GET /api/tasks parity', () => {
  it('custom canManageTasks grant holder (primary member) is allowed', async () => {
    mockForUser.mockResolvedValue(true);
    const res: any = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(mockForUser).toHaveBeenCalledWith(mockDb, HOLDER, 'canManageTasks');
  });

  it('no grant (or expired grant) is denied with the original body', async () => {
    mockForUser.mockResolvedValue(false);
    const res: any = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: insufficient privileges' });
  });
});

describe('E2 POST /api/tasks parity', () => {
  it('no grant is denied with the original body', async () => {
    mockForUser.mockResolvedValue(false);
    const res: any = await POST(makeRequest({ title: 'x' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: insufficient privileges to create tasks' });
    expect(mockForUser).toHaveBeenCalledWith(mockDb, HOLDER, 'canManageTasks');
  });
});

describe('E1 PATCH /api/tasks parity', () => {
  it('no grant and no other arm: denied', async () => {
    mockForUser.mockResolvedValue(false);
    const res: any = await PATCH(makeRequest({ taskId: 'task-1', updates: { title: 'New title' } }));
    expect(res.status).toBe(403);
    expect(mockForUser).toHaveBeenCalledWith(mockDb, HOLDER, 'canManageTasks');
  });
});

describe('E4 DELETE /api/tasks parity', () => {
  it('custom grant holder may delete (assigner arm untouched)', async () => {
    mockForUser.mockResolvedValue(true);
    mockTaskData = { assignerId: 'other-user', status: 'pending' };
    const res: any = await DELETE(makeRequest({ taskId: 'task-1' }));
    expect(res.status).toBe(200);
    expect(mockTaskDelete).toHaveBeenCalled();
    expect(mockForUser).toHaveBeenCalledWith(mockDb, HOLDER, 'canManageTasks');
  });

  it('no grant and not the assigner: denied with the original body', async () => {
    mockForUser.mockResolvedValue(false);
    mockTaskData = { assignerId: 'other-user', status: 'pending' };
    const res: any = await DELETE(makeRequest({ taskId: 'task-1' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: you do not have permission to delete this task' });
  });
});
