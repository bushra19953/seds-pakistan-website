/**
 * @jest-environment node
 *
 * Read-bleed train 2 (census 23 B3 / census 04 T1): GET /api/tasks is
 * a Supabase-PRIMARY surface. When the seam adapter is present but
 * EVERY seam tier fails, the route must fail LOUD with 503 and must
 * NOT re-run the list on Firestore — that ladder (default 100 / cap
 * 500 reads per request on the busiest admin surface) is what turns
 * a Supabase outage into a Firestore quota outage.
 *
 * Harness mirrors route-list-fallback.test.ts, with the seam module
 * partially mocked: resolveTasksSupaAdapter returns an adapter whose
 * listDocs always throws, while listTasksDocs stays the real
 * implementation (so all three seam tiers genuinely run and fail).
 */

const HOLDER = 'holder-1';

const mockForUser = jest.fn();
const firestoreGetCalls: string[] = [];

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
  const makeQuery = (): any => ({
    where: () => makeQuery(),
    orderBy: () => makeQuery(),
    limit: () => makeQuery(),
    startAfter: () => makeQuery(),
    get: async () => {
      firestoreGetCalls.push('tasks-query');
      return { docs: [] };
    },
    doc: (id: string) => ({
      id,
      get: async () => {
        firestoreGetCalls.push('tasks-doc');
        return { exists: false, data: () => undefined };
      },
    }),
  });
  const mockDb = {
    collection: (name: string) => {
      if (name === 'tasks') return makeQuery();
      if (name === 'roles') {
        return {
          doc: () => ({
            get: async () => ({ exists: true, data: () => ({ role: 'member', additionalRoles: [] }) }),
          }),
        };
      }
      if (name === 'users') {
        return {
          doc: () => ({
            get: async () => ({ exists: false, data: () => undefined }),
            set: async () => undefined,
          }),
        };
      }
      throw new Error(`unexpected collection: ${name}`);
    },
    batch: () => ({ set: () => undefined, update: () => undefined, delete: () => undefined, commit: async () => undefined }),
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
    verifyIdTokenString: async () => ({ uid: HOLDER, email: 'holder@example.com' }),
    SessionError: MockSessionError,
  };
});

jest.mock('@/lib/mailer', () => ({ sendEmailNotification: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/server/user-status', () => ({
  validateUserStatus: jest.fn().mockResolvedValue({ isValid: true }),
  resolveUserDisplayName: jest.fn().mockResolvedValue(null),
}));
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
  resolveValidatorSubmissionAlerts: jest.fn(),
}));
jest.mock('@/lib/server/validation-audit', () => ({
  logValidationDecision: jest.fn(),
  logDeniedValidationAttempt: jest.fn(),
}));
jest.mock('@/lib/server/task-reviewer', () => ({ resolveTaskReviewerUids: jest.fn().mockReturnValue([]) }));
jest.mock('@/lib/server/discipline/suspension', () => ({ suspensionBlock: jest.fn().mockResolvedValue(null) }));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(false),
  hasServerPermissionForUser: (...args: any[]) => mockForUser(...args),
  resolveUserRole: jest.fn().mockResolvedValue('member'),
  assertChapterAccess: jest.fn().mockResolvedValue({ allowed: true }),
}));
jest.mock('@/lib/server/supa-roles-seam', () => ({
  supaGetDoc: jest.fn().mockResolvedValue({ exists: true, data: { role: 'founder' } }),
}));

const mockSeamListDocs = jest.fn(async () => {
  throw new Error('supabase down');
});
jest.mock('@/lib/supa/seam-tasks-route', () => {
  const actual = jest.requireActual('@/lib/supa/seam-tasks-route');
  return {
    ...actual,
    resolveTasksSupaAdapter: jest.fn(async () => ({ listDocs: mockSeamListDocs })),
  };
});

import { GET } from '../route';

function makeRequest(url = 'http://localhost/api/tasks?status=pending&limit=50'): any {
  const req: any = {
    json: async () => ({}),
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
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockForUser.mockResolvedValue(true);
  mockSeamListDocs.mockRejectedValue(new Error('supabase down'));
  firestoreGetCalls.length = 0;
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

describe('GET /api/tasks on total seam failure (train 2, census 23 B3)', () => {
  it('answers 503 loud and runs ZERO Firestore list reads', async () => {
    const res: any = await GET(makeRequest());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error_code).toBe('tasks_list_unavailable');
    // All three bounded seam tiers ran against the adapter...
    expect(mockSeamListDocs.mock.calls.length).toBe(3);
    // ...and the Firestore ladder never ran at all.
    expect(firestoreGetCalls).toEqual([]);
  });
});
