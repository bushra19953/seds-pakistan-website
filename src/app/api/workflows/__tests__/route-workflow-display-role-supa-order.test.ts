/**
 * @jest-environment node
 *
 * 2026-11-07 role-grant incident, end-to-end through the handler.
 *
 * The workflow-detail Supa seam builds its roles snap list parallel
 * to ITS OWN id list, derived from the RAW task fetch order; the
 * handler derives its assignee ids from the sequenceIndex-SORTED
 * tasks. For the role-grant workflow the seam order was
 * [Emaan, Ahmed] and the handler order [Ahmed, Emaan]. The handler
 * paired uid[i] with snap[i] BY INDEX, so Ahmed received Emaan's
 * roles doc: his assigneeInfo.displayRole became her
 * custom_marketing_deputy_social_media grant and the exported mission
 * PDF printed "Marketing Deputy - Social Media (custom)" under his
 * name, while Emaan (the sole holder) printed her primary title.
 *
 * This test feeds the handler the incident's exact shape through the
 * seam: 4 steps (Ahmed, Emaan, Emaan, Ahmed), seam snaps in seam
 * order. Display-role resolution must key every snap by its own id.
 */
const VIEWER = 'viewer-1';

const AHMED = 'uid-ahmed';
const EMAAN = 'uid-emaan';
const CUSTOM_SOCIAL = 'custom_marketing_deputy_social_media';

function seamTaskDoc(id: string, sequenceIndex: number, assigneeId: string) {
  return {
    id,
    data: () => ({
      workflowId: 'wf-role-grant',
      status: 'pending',
      assigneeId,
      assigneeIds: [assigneeId],
      sequenceIndex,
      createdAt: null,
      updatedAt: null,
    }),
  };
}

function seamSnap(id: string, doc: Record<string, unknown> | undefined) {
  return { id, exists: doc !== undefined, data: () => doc };
}

// Seam reads for the incident workflow. NOTE the snap lists are in
// the SEAM's order ([Emaan, Ahmed] — its raw fetch saw a step task of
// Emaan's first), while the tasks sort to handler order
// [Ahmed, Emaan, Emaan, Ahmed].
const SEAM_READS = {
  tasksSnap: {
    docs: [
      seamTaskDoc('task-s1', 0, AHMED),
      seamTaskDoc('task-s2', 1, EMAAN),
      seamTaskDoc('task-s3', 2, EMAAN),
      seamTaskDoc('task-s4', 3, AHMED),
    ],
    empty: false,
  },
  workflowChapterSnap: null,
  userSnaps: [
    seamSnap(EMAAN, { displayName: 'Emaan Yasir', role: 'chapter_recruitment_chair' }),
    seamSnap(AHMED, { displayName: 'Ahmed Ali', role: 'chapter_vice_president' }),
  ],
  uniqueAssigneeIds: [EMAAN, AHMED],
  userChapterSnaps: {},
  assigneeRoleSnaps: [
    seamSnap(EMAAN, {
      role: 'chapter_recruitment_chair',
      additionalRoles: [CUSTOM_SOCIAL],
    }),
    seamSnap(AHMED, { role: 'chapter_vice_president', additionalRoles: [] }),
  ],
  roleSnap: seamSnap(VIEWER, undefined),
  memberSnap: seamSnap('wf-role-grant_viewer-1', undefined),
};

const mockDb = {
  collection: () => {
    throw new Error('detail reads must ride the seam in this test');
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
  fetchWorkflowDetailReadsViaSupa: jest.fn().mockResolvedValue(SEAM_READS),
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

describe('GET /api/workflows detail with seam-ordered role snaps (2026-11-07 incident)', () => {
  it('the custom grant lands ONLY on its holder, never on the other assignee', async () => {
    const res: any = await GET(makeRequest('http://localhost/api/workflows?workflowId=wf-role-grant'));
    expect(res.status).toBe(200);
    const body = await res.json();

    // Ahmed holds no custom grant: no displayRole anywhere for him.
    expect(body.assigneeInfo[AHMED].role).toBe('chapter_vice_president');
    expect(body.assigneeInfo[AHMED]).not.toHaveProperty('displayRole');
    // Emaan is the sole holder of the social-media deputy grant.
    expect(body.assigneeInfo[EMAAN].role).toBe('chapter_recruitment_chair');
    expect(body.assigneeInfo[EMAAN].displayRole).toBe(CUSTOM_SOCIAL);

    // Step-level fields follow the same keying: Ahmed's steps (seq 0
    // and 3) carry no assigneeDisplayRole; Emaan's steps (seq 1, 2) do.
    expect(body.tasks[0]).not.toHaveProperty('assigneeDisplayRole');
    expect(body.tasks[0].assignees[0]).not.toHaveProperty('displayRole');
    expect(body.tasks[1].assigneeDisplayRole).toBe(CUSTOM_SOCIAL);
    expect(body.tasks[1].assignees[0].displayRole).toBe(CUSTOM_SOCIAL);
    expect(body.tasks[2].assigneeDisplayRole).toBe(CUSTOM_SOCIAL);
    expect(body.tasks[3]).not.toHaveProperty('assigneeDisplayRole');
  });
});
