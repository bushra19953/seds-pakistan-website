/**
 * @jest-environment node
 *
 * Read-burn C2 regression: GET /api/tasks must NEVER fall back to an
 * unbounded full-collection read when its primary ordered list query
 * throws (the old code answered any failure with
 * db.collection('tasks').get(), a full tasks census shipped to the
 * client). Degradation ladder pinned here:
 *   tier 1: filters + orderBy + limit (primary)
 *   tier 2: filters + limit, sorted by createdAt desc in memory
 *   tier 3: orderBy + limit, no filters
 *   all tiers failing -> 503 loud (read-bleed train 2, census 04 T1;
 *   was an uncaught 500), still no unbounded read.
 *
 * The mock query chain records the shape of every .get() so the tests
 * can assert that every executed query carried a limit.
 */

const HOLDER = 'holder-1';

const mockForUser = jest.fn();

type QState = {
  wheres: string[];
  hasOrderBy: boolean;
  hasLimit: boolean;
  limitValue: number | null;
  hasStartAfter: boolean;
};

const EMPTY_STATE: QState = {
  wheres: [],
  hasOrderBy: false,
  hasLimit: false,
  limitValue: null,
  hasStartAfter: false,
};

const queryGetCalls: QState[] = [];
let tasksGetHandler: (state: QState) => Promise<any> = async () => ({ docs: [] });

function fakeTs(ms: number) {
  return {
    toMillis: () => ms,
    toDate: () => new Date(ms),
    seconds: Math.floor(ms / 1000),
  };
}

function makeDoc(id: string, createdMs: number) {
  const data: any = {
    title: `Task ${id}`,
    status: 'pending',
    projectId: 'proj-1',
    createdAt: fakeTs(createdMs),
  };
  return {
    id,
    data: () => data,
    get: (field: string) => data[field],
  };
}

function makeQuery(state: QState): any {
  return {
    where: (field: string) => makeQuery({ ...state, wheres: [...state.wheres, field] }),
    orderBy: () => makeQuery({ ...state, hasOrderBy: true }),
    limit: (n: number) => makeQuery({ ...state, hasLimit: true, limitValue: n }),
    startAfter: () => makeQuery({ ...state, hasStartAfter: true }),
    get: async () => {
      queryGetCalls.push(state);
      return tasksGetHandler(state);
    },
    doc: (id: string) => ({
      id,
      get: async () => ({ exists: false, data: () => undefined }),
    }),
  };
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'tasks') return makeQuery({ ...EMPTY_STATE });
    if (name === 'roles') {
      return {
        doc: () => ({
          get: async () => ({
            exists: true,
            data: () => ({ role: 'member', additionalRoles: [] }),
          }),
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

import { GET } from '../route';

function makeRequest(url = 'http://localhost/api/tasks?status=pending&projectId=proj-1&limit=50'): any {
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
  queryGetCalls.length = 0;
  tasksGetHandler = async () => ({ docs: [] });
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

describe('GET /api/tasks bounded degradation (read-burn C2)', () => {
  it('primary success: exactly one bounded query, no degradation', async () => {
    tasksGetHandler = async (state) => {
      if (!state.hasOrderBy) throw new Error('should not reach a fallback tier');
      return { docs: [makeDoc('a', 300), makeDoc('b', 100)] };
    };
    const res: any = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: any) => i.id)).toEqual(['a', 'b']);
    expect(queryGetCalls).toHaveLength(1);
    expect(queryGetCalls[0].hasLimit).toBe(true);
    expect(queryGetCalls[0].hasOrderBy).toBe(true);
  });

  it('primary throws (missing composite index): tier 2 serves filters + limit, sorted desc in memory', async () => {
    tasksGetHandler = async (state) => {
      if (state.hasOrderBy) throw new Error('FAILED_PRECONDITION: missing composite index');
      // Tier 2 shape: filters, no orderBy. Return deliberately unsorted docs.
      return { docs: [makeDoc('old', 100), makeDoc('new', 300), makeDoc('mid', 200)] };
    };
    const res: any = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: any) => i.id)).toEqual(['new', 'mid', 'old']);
    expect(body.nextCursor).toBe('100');

    expect(queryGetCalls).toHaveLength(2);
    const tier2 = queryGetCalls[1];
    expect(tier2.hasOrderBy).toBe(false);
    expect(tier2.wheres).toEqual(expect.arrayContaining(['status', 'projectId']));
    expect(tier2.hasLimit).toBe(true);
    expect(tier2.limitValue).toBe(50);
    // No executed query was ever unbounded.
    expect(queryGetCalls.every((s) => s.hasLimit)).toBe(true);
  });

  it('tiers 1-2 throw: tier 3 serves the bounded ordered query without filters', async () => {
    tasksGetHandler = async (state) => {
      if (state.hasOrderBy && state.wheres.length > 0) throw new Error('index missing');
      if (!state.hasOrderBy) throw new Error('tier 2 unavailable');
      return { docs: [makeDoc('x', 500)] };
    };
    const res: any = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: any) => i.id)).toEqual(['x']);
    expect(queryGetCalls).toHaveLength(3);
    const tier3 = queryGetCalls[2];
    expect(tier3.wheres).toEqual([]);
    expect(tier3.hasOrderBy).toBe(true);
    expect(tier3.hasLimit).toBe(true);
    expect(queryGetCalls.every((s) => s.hasLimit)).toBe(true);
  });

  it('every bounded tier throws: 503 loud, and still no unbounded read', async () => {
    tasksGetHandler = async () => {
      throw new Error('still broken');
    };
    const res: any = await GET(makeRequest());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error_code).toBe('tasks_list_unavailable');
    expect(queryGetCalls).toHaveLength(3);
    expect(queryGetCalls.every((s) => s.hasLimit)).toBe(true);
  });
});

/**
 * Perf program (2026-10-30): the ladder above is bounded in COUNT
 * (limit on every tier) but, pre-fix, not in TIME — each tier's
 * Firestore .get() carried no app-level deadline, so a degraded
 * Firestore could retry-storm every tier in sequence (GAPIC: 60 s
 * per RPC, 600 s total budget) and pin the single instance for
 * minutes before the 503 arrived. The ladder now shares ONE time
 * budget (TASKS_LIST_LADDER_BUDGET_MS): a hung tier consumes it, the
 * remaining tiers are refused WITHOUT issuing further reads, and the
 * same loud 503 answers. The assignee union's Firestore fallback
 * shares one list budget across its two parallel legs the same way;
 * its deadline lands in the branch's existing catch, which serves
 * the empty assignee page instead of hanging the request.
 */
describe('GET /api/tasks ladder time budget (perf program)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('a hung tier-1 read settles as the loud 503 at the ladder budget, issuing no further tier reads', async () => {
    tasksGetHandler = () => new Promise<never>(() => undefined);
    let res: any = null;
    const p = GET(makeRequest()).then((r: any) => {
      res = r;
    });
    await jest.advanceTimersByTimeAsync(15_001);
    await p;
    expect(res).not.toBeNull();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error_code).toBe('tasks_list_unavailable');
    // Tier 1 was issued once; tiers 2-3 were refused by the spent
    // budget and never reached Firestore.
    expect(queryGetCalls).toHaveLength(1);
    expect(queryGetCalls[0].hasLimit).toBe(true);
  });

  it('hung assignee fallback legs settle as the empty assignee page at the list deadline', async () => {
    tasksGetHandler = () => new Promise<never>(() => undefined);
    let res: any = null;
    const p = GET(
      makeRequest('http://localhost/api/tasks?assigneeId=holder-1&limit=50'),
    ).then((r: any) => {
      res = r;
    });
    await jest.advanceTimersByTimeAsync(10_001);
    await p;
    expect(res).not.toBeNull();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    // Both union legs were issued (in parallel) before the deadline.
    expect(queryGetCalls).toHaveLength(2);
    expect(queryGetCalls.every((s) => s.hasLimit)).toBe(true);
  });
});
