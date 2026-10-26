/**
 * @jest-environment node
 *
 * POST/PATCH /api/workflows mirror-on-write wiring.
 *
 * Regression coverage for the 2026-10-26 "mission with no steps"
 * incident: workflow-owned writes landed in Firestore only, while
 * the detail/public/PDF readers read the Supabase mirror under the
 * 'workflows' flag — new workflows were invisible there. The routes
 * must hand every written doc to the workflows-gated mirror
 * (src/lib/server/workflow-write-mirror): one call per step task on
 * create, one per workflow_members doc, one per step update.
 *
 * The mirror module itself is mocked here (its gate/sanitize/land
 * behavior is pinned in src/lib/server/__tests__/workflow-write-mirror.test.ts);
 * Firestore is an in-memory mock. On the base tree the routes never
 * call the mirror, so every assertion below fails there.
 */
const CREATOR = 'creator-1';

const mockSendEmail = jest.fn().mockResolvedValue({ success: true });
const mockMirrorTask = jest.fn(async (_id: string, _fetch?: any) => {});
const mockMirrorMember = jest.fn(async (_id: string, _fetch?: any) => {});

jest.mock('@/lib/server/workflow-write-mirror', () => ({
  mirrorWorkflowTaskDocById: (id: string, fetch?: any) => mockMirrorTask(id, fetch),
  mirrorWorkflowMemberDocById: (id: string, fetch?: any) => mockMirrorMember(id, fetch),
  mirrorWorkflowTaskDeletesByIds: jest.fn(async () => {}),
  mirrorWorkflowMemberDeletesByIds: jest.fn(async () => {}),
}));

const USERS: Record<string, any> = {
  'creator-1': { displayName: 'The Creator', email: 'creator@example.com' },
  'user-a': { displayName: 'Alice A', email: 'alice@example.com' },
  'user-b': { displayName: 'Bob B' },
};

const mockNotifications: Array<{ uid: string; data: any }> = [];
const mockTaskDocs: Array<{ id: string; data: any }> = [];
const mockAudits: Array<any> = [];
let taskSeq = 0;

// PATCH fixture: one stored step doc the where-chain can find.
const PATCH_STEP = {
  id: 'step-9',
  workflowId: 'wf-test-1',
  sequenceIndex: 0,
  assigneeId: 'user-a',
  assigneeIds: ['user-a'],
  status: 'pending',
  title: 'Step Nine',
};

function userDocRef(uid: string): any {
  return {
    get: async () => {
      const data = USERS[uid];
      return { exists: !!data, data: () => data };
    },
    set: async () => {},
    collection: (_sub: string) => ({
      doc: () => ({
        set: async (data: any) => { mockNotifications.push({ uid, data }); },
      }),
    }),
  };
}

function taskDocRef(id: string, sink: Array<{ id: string; data: any }>): any {
  const self: any = {
    id,
    set: async (data: any, _opts?: any) => {
      const idx = sink.findIndex((t) => t.id === id);
      const merged = idx >= 0 ? { ...sink[idx].data, ...data } : { ...data };
      if (idx >= 0) sink[idx] = { id, data: merged }; else sink.push({ id, data: merged });
      self.__data = merged;
    },
    get: async () => ({ exists: !!self.__data, data: () => self.__data }),
    __data: undefined as any,
  };
  return self;
}

const patchStepRef = taskDocRef(PATCH_STEP.id, mockTaskDocs);
(patchStepRef as any).__data = { ...PATCH_STEP };

function tasksCollection(): any {
  return {
    doc: (id?: string) => {
      if (id) return taskDocRef(id, mockTaskDocs);
      const newId = `task-${++taskSeq}`;
      return taskDocRef(newId, mockTaskDocs);
    },
    where: (field: string, _op: string, value: any) => {
      const filters: Array<[string, any]> = [[field, value]];
      const chain: any = {
        where: (f2: string, _o2: string, v2: any) => { filters.push([f2, v2]); return chain; },
        limit: (_n: number) => chain,
        get: async () => {
          const all = [PATCH_STEP, ...mockTaskDocs.map((t) => ({ id: t.id, ...t.data }))];
          const docs = all
            .filter((t: any) => filters.every(([f, v]) => t[f] === v))
            .map((t: any) => ({
              id: t.id,
              data: () => t,
              ref: t.id === PATCH_STEP.id ? patchStepRef : taskDocRef(t.id, mockTaskDocs),
            }));
          return { empty: docs.length === 0, docs };
        },
      };
      return chain;
    },
  };
}

const mockDb: any = {
  collection: (name: string) => {
    if (name === 'users') return { doc: (uid: string) => userDocRef(uid) };
    if (name === 'tasks') return tasksCollection();
    if (name === 'workflow_members') return { doc: (id: string) => ({ id, set: async () => {}, get: async () => ({ exists: false, data: () => undefined }) }) };
    if (name === 'workflow_audits') return { add: async (data: any) => { mockAudits.push(data); } };
    throw new Error(`unexpected collection ${name}`);
  },
  batch: () => ({ set: () => {}, commit: async () => {} }),
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
    auth: () => ({ verifyIdToken: async () => ({ uid: CREATOR, email: 'creator@example.com', name: 'The Creator' }) }),
    firestore: { FieldValue: { serverTimestamp: () => ({ __fv: 'ts' }), increment: (n: number) => ({ __inc: n }) } },
  },
}));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn().mockResolvedValue(true),
}));
jest.mock('@/lib/workflow-utils', () => ({
  calculateWorkflowDeadlines: (_final: any, steps: any[]) => steps.map(() => new Date('2027-01-15T12:00:00.000Z')),
}));
jest.mock('@/lib/workflow-progress', () => ({
  isStepWorkDone: () => false,
  isStepApproved: () => false,
  computeWorkflowProgress: jest.fn(() => ({ completedSteps: 0, isCompleted: false })),
}));
jest.mock('@/lib/server/user-status', () => ({ validateUserStatus: jest.fn().mockResolvedValue({ isValid: true }) }));
jest.mock('@/lib/mailer', () => ({
  sendEmailNotification: (...args: any[]) => mockSendEmail(...args),
}));
jest.mock('@/lib/server/discipline/suspension', () => ({
  suspensionBlock: jest.fn(async () => null),
}));

import { POST, PATCH } from '../route';

function makeRequest(body?: any): any {
  return {
    json: async () => body ?? {},
    url: 'http://localhost/api/workflows',
    headers: { get: () => 'Bearer <redacted>' },
    cookies: { get: () => undefined },
  };
}

const WORKFLOW_BODY = {
  workflowId: 'wf-test-1',
  workflowTitle: 'Test Workflow',
  finalDeadline: '2027-06-01T00:00:00.000Z',
  steps: [
    { title: 'Step One', description: 'first', assigneeId: 'user-a', assigneeIds: ['user-a', 'user-b'] },
    { title: 'Step Two', description: 'second', assigneeId: CREATOR },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockNotifications.length = 0;
  mockTaskDocs.length = 0;
  mockAudits.length = 0;
  taskSeq = 0;
  (patchStepRef as any).__data = { ...PATCH_STEP };
});

describe('POST /api/workflows mirror-on-write', () => {
  it('mirrors every created step task, by id', async () => {
    const res: any = await POST(makeRequest(WORKFLOW_BODY));
    expect(res.status).toBe(200);
    const ids = mockMirrorTask.mock.calls.map((c) => c[0]).sort();
    expect(ids).toEqual(['task-1', 'task-2']);
    // Each call carries a fetch callback (the mirror re-reads the
    // final stored doc only when its gate is active).
    for (const call of mockMirrorTask.mock.calls) expect(typeof call[1]).toBe('function');
  });

  it('mirrors every workflow_members doc (creator as owner + all participants)', async () => {
    const res: any = await POST(makeRequest(WORKFLOW_BODY));
    expect(res.status).toBe(200);
    const ids = mockMirrorMember.mock.calls.map((c) => c[0]).sort();
    expect(ids).toEqual(['wf-test-1_creator-1', 'wf-test-1_user-a', 'wf-test-1_user-b']);
  });
});

describe('PATCH /api/workflows mirror-on-write (step updates)', () => {
  it('mirrors the updated step task', async () => {
    const res: any = await PATCH(makeRequest({
      workflowId: 'wf-test-1',
      sequenceIndex: 0,
      updates: { assigneeId: 'user-b' },
    }));
    expect(res.status).toBe(200);
    expect(mockMirrorTask.mock.calls.map((c) => c[0])).toEqual(['step-9']);
    expect(mockAudits.length).toBe(1);
  });
});
