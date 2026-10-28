/**
 * Route tests for /api/cron/leave-lifecycle: authorization shape
 * (CRON_SECRET bearer, or a signed-in caller with
 * canManageApplications) and the dry-run-by-default mode contract.
 * The engine itself is covered by
 * src/lib/server/__tests__/leave-lifecycle.test.ts; here it is
 * mocked so the mode the route computed can be asserted.
 */

const mockRunLeaveLifecycle = jest.fn(async (_db: any, opts: any) => ({
  mode: opts.mode,
  todayKarachi: '2026-10-28',
  scanned: 0,
  truncated: false,
  future: 0,
  alreadyActive: 0,
  activated: [],
  completed: [],
  deactivated: [],
  skipped: [],
}));

let mockAuth: any = { authenticated: false, user: null };
let mockCanManage = false;

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

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({}),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => mockAuth,
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: async () => mockCanManage,
}));

jest.mock('@/lib/server/leave-lifecycle', () => ({
  runLeaveLifecycle: mockRunLeaveLifecycle,
}));

import { GET, POST } from '../route';

function makeRequest(opts: { authz?: string | null; body?: any; query?: string } = {}): any {
  return {
    headers: {
      get: (name: string) => (name === 'authorization' ? (opts.authz ?? null) : null),
    },
    json: async () => opts.body ?? {},
    nextUrl: { searchParams: new URLSearchParams(opts.query ?? '') },
  };
}

const signedInAdmin = {
  authenticated: true,
  user: { userId: 'admin-1', role: 'admin' },
};

beforeEach(() => {
  mockRunLeaveLifecycle.mockClear();
  mockAuth = { authenticated: false, user: null };
  mockCanManage = false;
  process.env.CRON_SECRET = 'test-cron-secret';
});

afterAll(() => {
  delete process.env.CRON_SECRET;
});

describe('/api/cron/leave-lifecycle authorization', () => {
  test('cron bearer runs the sweep', async () => {
    const res: any = await GET(makeRequest({ authz: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    expect(mockRunLeaveLifecycle).toHaveBeenCalledTimes(1);
  });

  test('unauthenticated caller gets 401 and the sweep never runs', async () => {
    const res: any = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(mockRunLeaveLifecycle).not.toHaveBeenCalled();
  });

  test('signed-in caller without canManageApplications gets 403 and the sweep never runs', async () => {
    mockAuth = signedInAdmin;
    mockCanManage = false;
    const res: any = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect(mockRunLeaveLifecycle).not.toHaveBeenCalled();
  });

  test('signed-in caller with canManageApplications runs the sweep', async () => {
    mockAuth = signedInAdmin;
    mockCanManage = true;
    const res: any = await POST(makeRequest({ body: {} }));
    expect(res.status).toBe(200);
    expect(mockRunLeaveLifecycle).toHaveBeenCalledTimes(1);
  });

  test('a wrong cron secret is not treated as cron', async () => {
    const res: any = await GET(makeRequest({ authz: 'Bearer wrong-secret-value' }));
    expect(res.status).toBe(401);
    expect(mockRunLeaveLifecycle).not.toHaveBeenCalled();
  });
});

describe('/api/cron/leave-lifecycle mode contract', () => {
  test('defaults to dry-run with no mode anywhere', async () => {
    const res: any = await GET(makeRequest({ authz: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report.mode).toBe('dry-run');
    expect(mockRunLeaveLifecycle.mock.calls[0][1].mode).toBe('dry-run');
  });

  test("POST body mode 'repair' selects repair", async () => {
    await POST(makeRequest({ authz: 'Bearer test-cron-secret', body: { mode: 'repair' } }));
    expect(mockRunLeaveLifecycle.mock.calls[0][1].mode).toBe('repair');
  });

  test('GET query mode=repair selects repair (the registered schedule form)', async () => {
    await GET(makeRequest({ authz: 'Bearer test-cron-secret', query: 'mode=repair' }));
    expect(mockRunLeaveLifecycle.mock.calls[0][1].mode).toBe('repair');
  });

  test('any other mode value stays dry-run', async () => {
    await POST(makeRequest({ authz: 'Bearer test-cron-secret', body: { mode: 'apply' } }));
    expect(mockRunLeaveLifecycle.mock.calls[0][1].mode).toBe('dry-run');
  });
});
