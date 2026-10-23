/**
 * @jest-environment node
 *
 * Permission-parity (Family E, E8/E9/E10): workflows route gates must use
 * hasServerPermissionForUser. Canonical holder: primary `member` +
 * additionalRoles ['custom_verify_design_aide'] with a canManageTasks grant
 * (the permissions module is mocked; each test sets the holder answer).
 */
const HOLDER = 'holder-1';
const mockForUser = jest.fn();

const wfDoc = {
  id: 't1',
  data: () => ({ workflowId: 'wf-1', workflowTitle: 'WF One', status: 'pending', assigneeId: 'other-user', createdAt: null, updatedAt: null }),
};
const queryChain: any = {
  where: () => queryChain,
  orderBy: () => queryChain,
  limit: () => queryChain,
  get: async () => ({ docs: [wfDoc], empty: false }),
};
const mockDb = {
  collection: (name: string) => {
    if (name === 'tasks') return queryChain;
    throw new Error(`unexpected collection ${name}`);
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
  ensureAdminInitialized: () => true,
  admin: {
    auth: () => ({ verifyIdToken: async () => ({ uid: HOLDER }) }),
    firestore: { FieldValue: { serverTimestamp: () => ({ __fv: 'ts' }) } },
  },
}));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(false),
  hasServerPermissionForUser: (...args: any[]) => mockForUser(...args),
  resolveUserRole: jest.fn().mockResolvedValue('member'),
}));
jest.mock('@/lib/workflow-utils', () => ({ calculateWorkflowDeadlines: jest.fn() }));
jest.mock('@/lib/workflow-progress', () => ({ isStepWorkDone: () => false, computeWorkflowProgress: jest.fn() }));
jest.mock('@/lib/server/user-status', () => ({ validateUserStatus: jest.fn().mockResolvedValue({ isValid: true }) }));
jest.mock('@/lib/server/discipline/suspension', () => ({ suspensionBlock: jest.fn().mockResolvedValue(null) }));

import { GET, POST, PATCH } from '../route';

function makeRequest(body?: any, url = 'http://localhost/api/workflows'): any {
  return {
    json: async () => body ?? {},
    url,
    headers: { get: () => 'Bearer tok' },
    cookies: { get: () => undefined },
  };
}

beforeEach(() => { jest.clearAllMocks(); mockForUser.mockResolvedValue(false); });

describe('E8 POST /api/workflows parity', () => {
  it('custom grant holder passes the gate (reaches body validation)', async () => {
    mockForUser.mockResolvedValue(true);
    const res: any = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    expect(mockForUser).toHaveBeenCalledWith(mockDb, HOLDER, 'canManageTasks');
  });
  it('no/expired grant is denied with the original body', async () => {
    const res: any = await POST(makeRequest({}));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: task management permission required' });
  });
});

describe('E9 GET /api/workflows parity (canManageWorkflows OR canManageTasks)', () => {
  it('custom grant holder sees workflows they do not participate in', async () => {
    // Grant supplies canManageTasks only: the OR must evaluate BOTH keys
    // (canManageWorkflows first, then canManageTasks) before allowing.
    mockForUser.mockImplementation(async (_db: any, _uid: string, key: string) => key === 'canManageTasks');
    const res: any = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workflows).toHaveLength(1);
    expect(mockForUser).toHaveBeenCalledWith(mockDb, HOLDER, 'canManageWorkflows');
    expect(mockForUser).toHaveBeenCalledWith(mockDb, HOLDER, 'canManageTasks');
  });
  it('non-manager sees only workflows they participate in (none here)', async () => {
    const res: any = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workflows).toHaveLength(0);
  });
});

describe('E10 PATCH /api/workflows parity', () => {
  it('custom grant holder passes the gate (reaches body validation)', async () => {
    mockForUser.mockResolvedValue(true);
    const res: any = await PATCH(makeRequest({}));
    expect(res.status).toBe(400);
  });
  it('no/expired grant is denied with the original body', async () => {
    const res: any = await PATCH(makeRequest({}));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: task management permission required' });
  });
});
