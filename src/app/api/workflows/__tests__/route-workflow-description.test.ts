/**
 * @jest-environment node
 *
 * MSG46: the workflow mission PDF never printed the parent workflow
 * description because GET /api/workflows never returned one. The parent
 * description lives denormalized on every step doc as
 * guidance.description (POST writes `guidance` onto each step; the
 * public missions route already reads docs[0].guidance?.description),
 * with the lowest-sequence step's description as the fallback for
 * workflows created without guidance (team-tasks never sends it;
 * handleCreateWorkflow folds the parent description into steps that
 * have none of their own).
 *
 * These tests prove the list aggregate and the single-workflow detail
 * response both surface it, and that a workflow with no description
 * anywhere returns no description (so the PDF keeps its boilerplate
 * fallback only then).
 */
const HOLDER = 'holder-1';
const mockForUser = jest.fn();

const GUIDANCE_DESC = 'MSG46-GUIDANCE-DESCRIPTION parent criteria and verdict format';
const STEP0_DESC = 'MSG46-STEP0-DESCRIPTION folded parent description';
const STEP1_DESC = 'MSG46-STEP1-DESCRIPTION own step text';

function stepDoc(overrides: Record<string, unknown>) {
  return {
    id: `doc-${Math.random().toString(36).slice(2, 8)}`,
    data: () => ({
      status: 'pending',
      assigneeId: 'user-1',
      createdAt: null,
      updatedAt: null,
      sequenceIndex: 0,
      ...overrides,
    }),
  };
}

const LIST_DOCS = [
  // wf-1: guidance present on every step — guidance wins.
  stepDoc({ workflowId: 'wf-1', workflowTitle: 'WF One', sequenceIndex: 0, description: STEP0_DESC, guidance: { description: GUIDANCE_DESC } }),
  stepDoc({ workflowId: 'wf-1', workflowTitle: 'WF One', sequenceIndex: 1, description: STEP1_DESC, guidance: { description: GUIDANCE_DESC } }),
  // wf-2: no guidance anywhere — lowest-sequence step's description wins.
  stepDoc({ workflowId: 'wf-2', workflowTitle: 'WF Two', sequenceIndex: 1, description: STEP1_DESC }),
  stepDoc({ workflowId: 'wf-2', workflowTitle: 'WF Two', sequenceIndex: 0, description: STEP0_DESC }),
  // wf-3: no description anywhere — no description returned.
  stepDoc({ workflowId: 'wf-3', workflowTitle: 'WF Three', sequenceIndex: 0, description: '' }),
];

const DETAIL_DOCS_WF1 = [
  stepDoc({ workflowId: 'wf-1', workflowTitle: 'WF One', sequenceIndex: 0, description: STEP0_DESC, guidance: { description: GUIDANCE_DESC } }),
  stepDoc({ workflowId: 'wf-1', workflowTitle: 'WF One', sequenceIndex: 1, description: STEP1_DESC, guidance: { description: GUIDANCE_DESC } }),
];

const mockDb = {
  collection: (name: string) => {
    if (name === 'tasks') {
      const chain: any = {
        where: (_field: string, _op: string, value: unknown) => ({
          // Detail query: .where('workflowId', '==', id).get()
          get: async () => ({ docs: value === 'wf-1' ? DETAIL_DOCS_WF1 : [], empty: value !== 'wf-1' }),
          // List query: .where(...).orderBy(...).limit(...).get()
          orderBy: () => chain,
          limit: () => chain,
        }),
        orderBy: () => chain,
        limit: () => chain,
        get: async () => ({ docs: LIST_DOCS, empty: false }),
      };
      return chain;
    }
    if (name === 'roles' || name === 'workflow_members') {
      return { doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }) };
    }
    if (name === 'users') {
      return {
        doc: (uid: string) => ({
          get: async () => ({ exists: true, id: uid, data: () => ({ displayName: 'User One' }) }),
        }),
      };
    }
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
jest.mock('@/lib/workflow-progress', () => ({
  isStepWorkDone: () => false,
  isStepApproved: (s: string) => s === 'completed' || s === 'approved',
  computeWorkflowProgress: () => ({ completedSteps: 0, isCompleted: false }),
}));
jest.mock('@/lib/server/user-status', () => ({ validateUserStatus: jest.fn().mockResolvedValue({ isValid: true }) }));
jest.mock('@/lib/server/discipline/suspension', () => ({ suspensionBlock: jest.fn().mockResolvedValue(null) }));
jest.mock('@/lib/server/workflow-detail-supa', () => ({
  listAllWorkflowTasksViaSupa: jest.fn().mockResolvedValue(null),
  fetchWorkflowDetailReadsViaSupa: jest.fn().mockResolvedValue(null),
}));

import { GET } from '../route';

function makeRequest(url = 'http://localhost/api/workflows'): any {
  return {
    json: async () => ({}),
    url,
    headers: { get: () => 'Bearer <redacted>' },
    cookies: { get: () => undefined },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockForUser.mockResolvedValue(true);
});

describe('MSG46 GET /api/workflows list aggregate surfaces the parent description', () => {
  it('returns guidance.description when steps carry guidance', async () => {
    const res: any = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    const wf1 = body.workflows.find((w: any) => w.id === 'wf-1');
    expect(wf1).toBeTruthy();
    expect(wf1.description).toBe(GUIDANCE_DESC);
  });

  it('falls back to the lowest-sequence step description when no guidance exists', async () => {
    const res: any = await GET(makeRequest());
    const body = await res.json();
    const wf2 = body.workflows.find((w: any) => w.id === 'wf-2');
    expect(wf2).toBeTruthy();
    expect(wf2.description).toBe(STEP0_DESC);
  });

  it('returns no description when no step carries one', async () => {
    const res: any = await GET(makeRequest());
    const body = await res.json();
    const wf3 = body.workflows.find((w: any) => w.id === 'wf-3');
    expect(wf3).toBeTruthy();
    expect(wf3.description).toBeUndefined();
  });
});

describe('MSG46 GET /api/workflows detail response surfaces the parent description', () => {
  it('returns description from the earliest step guidance', async () => {
    const res: any = await GET(makeRequest('http://localhost/api/workflows?workflowId=wf-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.description).toBe(GUIDANCE_DESC);
    expect(body.tasks).toHaveLength(2);
  });
});
