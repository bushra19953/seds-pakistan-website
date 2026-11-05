/**
 * @jest-environment node
 *
 * MSG47: the workflow mission PDF printed "Basic Member" for custom-role
 * holders because GET /api/workflows detail built assigneeInfo[].role
 * from the users doc's PRIMARY role only, and custom grants live ONLY
 * in roles/{uid}.additionalRoles, which the handler never read. The
 * export caller collects custom slugs from those role fields, so a
 * custom-grant holder's slug never entered the roleTitles map and the
 * exporter fell back to the primary's title.
 *
 * These tests prove the detail response now carries displayRole — the
 * first held custom grant when one is held, else absent (callers fall
 * back to `role`, so the response shape is unchanged when nobody holds
 * a custom grant) — on assigneeInfo entries, on tasks[].assignees[]
 * entries, and as tasks[].assigneeDisplayRole for the primary. The
 * `role` field itself is untouched (the Missions UI prints the raw
 * slug, and the contract suite pins it).
 */
const VIEWER = 'viewer-1';

const CUSTOM_PRESIDENT_APPRENTICE = 'custom_president_s_executive_apprentice';
const CUSTOM_DESIGN_DEPUTY = 'custom_design_media_deputy_digital_web_assets';
const CUSTOM_MARKETING_DEPUTY = 'custom_marketing_deputy_analytics';

const USER_DOCS: Record<string, Record<string, unknown>> = {
  'u-atika': { displayName: 'Atika Saroosh', role: 'member_basic' },
  'u-standard': { displayName: 'Ahmed Kamran', role: 'chapter_events_chair' },
  'u-basic': { displayName: 'Bilal Ahmed', role: 'member_basic' },
  'u-multi': { displayName: 'Sara Khan', role: 'member_basic' },
  'u-expired': { displayName: 'Omar Farooq', role: 'member_basic' },
};

// Past expiry (ms since epoch) for the expired-grant case.
const PAST_EXPIRY = Date.now() - 1000 * 60 * 60 * 24 * 30;

const ROLE_DOCS: Record<string, Record<string, unknown>> = {
  // Atika: the reported case — custom grant on top of member_basic.
  'u-atika': { role: 'member_basic', additionalRoles: [CUSTOM_PRESIDENT_APPRENTICE] },
  // Standard holder: no roles doc at all.
  // True basic member: roles doc with no grants.
  'u-basic': { role: 'member_basic', additionalRoles: [] },
  // Several grants: first in stored order wins.
  'u-multi': { role: 'member_basic', additionalRoles: [CUSTOM_DESIGN_DEPUTY, CUSTOM_PRESIDENT_APPRENTICE] },
  // Expired grant: dropped, so no displayRole.
  'u-expired': {
    role: 'member_basic',
    additionalRoles: [CUSTOM_MARKETING_DEPUTY],
    expiresAt: PAST_EXPIRY,
    expiresRoleKey: CUSTOM_MARKETING_DEPUTY,
  },
};

function stepDoc(overrides: Record<string, unknown>) {
  return {
    id: `doc-${Math.random().toString(36).slice(2, 8)}`,
    data: () => ({
      status: 'pending',
      assigneeId: 'u-atika',
      createdAt: null,
      updatedAt: null,
      sequenceIndex: 0,
      ...overrides,
    }),
  };
}

const DETAIL_DOCS = [
  stepDoc({ workflowId: 'wf-47', workflowTitle: 'Crucible Quality Review', sequenceIndex: 0, assigneeId: 'u-atika', assigneeIds: ['u-atika', 'u-standard'] }),
  stepDoc({ workflowId: 'wf-47', workflowTitle: 'Crucible Quality Review', sequenceIndex: 1, assigneeId: 'u-basic' }),
  stepDoc({ workflowId: 'wf-47', workflowTitle: 'Crucible Quality Review', sequenceIndex: 2, assigneeId: 'u-multi' }),
  stepDoc({ workflowId: 'wf-47', workflowTitle: 'Crucible Quality Review', sequenceIndex: 3, assigneeId: 'u-expired' }),
];

const mockDb = {
  collection: (name: string) => {
    if (name === 'tasks') {
      const chain: any = {
        where: (_field: string, _op: string, value: unknown) => ({
          get: async () => ({ docs: value === 'wf-47' ? DETAIL_DOCS : [], empty: value !== 'wf-47' }),
          orderBy: () => chain,
          limit: () => chain,
        }),
        orderBy: () => chain,
        limit: () => chain,
        get: async () => ({ docs: [], empty: true }),
      };
      return chain;
    }
    if (name === 'users') {
      return {
        doc: (uid: string) => ({
          get: async () => {
            const data = USER_DOCS[uid];
            return { exists: !!data, id: uid, data: () => data };
          },
        }),
      };
    }
    if (name === 'roles') {
      return {
        doc: (uid: string) => ({
          get: async () => {
            const data = ROLE_DOCS[uid];
            return { exists: !!data, id: uid, data: () => data };
          },
        }),
      };
    }
    if (name === 'workflow_members' || name === 'chapters') {
      return { doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }) };
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
    auth: () => ({ verifyIdToken: async () => ({ uid: VIEWER }) }),
    firestore: { FieldValue: { serverTimestamp: () => ({ __fv: 'ts' }) } },
  },
}));
const mockForUser = jest.fn();
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

function makeRequest(url: string): any {
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
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function getDetailBody() {
  const res: any = await GET(makeRequest('http://localhost/api/workflows?workflowId=wf-47'));
  expect(res.status).toBe(200);
  return res.json();
}

describe('MSG47 GET /api/workflows detail surfaces the display role', () => {
  it('a custom-grant holder carries displayRole = the custom slug, role stays the primary', async () => {
    const body = await getDetailBody();
    // assigneeInfo map
    expect(body.assigneeInfo['u-atika'].role).toBe('member_basic');
    expect(body.assigneeInfo['u-atika'].displayRole).toBe(CUSTOM_PRESIDENT_APPRENTICE);
    // tasks[].assignees[] fellow entry + primary singular field
    const s1 = body.tasks[0];
    expect(s1.assigneeRole).toBe('member_basic');
    expect(s1.assigneeDisplayRole).toBe(CUSTOM_PRESIDENT_APPRENTICE);
    expect(s1.assignees[0]).toMatchObject({
      id: 'u-atika',
      role: 'member_basic',
      displayRole: CUSTOM_PRESIDENT_APPRENTICE,
    });
  });

  it('a standard role holder carries no displayRole key', async () => {
    const body = await getDetailBody();
    expect(body.assigneeInfo['u-standard'].role).toBe('chapter_events_chair');
    expect(body.assigneeInfo['u-standard']).not.toHaveProperty('displayRole');
    expect(body.tasks[0].assignees[1]).not.toHaveProperty('displayRole');
  });

  it('a true basic member carries no displayRole key', async () => {
    const body = await getDetailBody();
    expect(body.assigneeInfo['u-basic'].role).toBe('member_basic');
    expect(body.assigneeInfo['u-basic']).not.toHaveProperty('displayRole');
    expect(body.tasks[1]).not.toHaveProperty('assigneeDisplayRole');
  });

  it('several custom grants: the first in stored order wins', async () => {
    const body = await getDetailBody();
    expect(body.assigneeInfo['u-multi'].displayRole).toBe(CUSTOM_DESIGN_DEPUTY);
    expect(body.tasks[2].assigneeDisplayRole).toBe(CUSTOM_DESIGN_DEPUTY);
  });

  it('an expired custom grant is dropped, so no displayRole', async () => {
    const body = await getDetailBody();
    expect(body.assigneeInfo['u-expired'].role).toBe('member_basic');
    expect(body.assigneeInfo['u-expired']).not.toHaveProperty('displayRole');
  });
});
