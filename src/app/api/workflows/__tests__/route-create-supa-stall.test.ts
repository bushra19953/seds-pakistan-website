/**
 * @jest-environment node
 *
 * POST /api/workflows vs a stalled Supabase transport — regression
 * suite for the 2026-11-07 workflow-create submit hang.
 *
 * Production signature (lead-verified, 2026-11-07): the Create Task
 * form's submit spun forever (8+ minutes on the 49-step
 * acknowledgment workflow; two hung submits on the 4-step
 * role-grant workflow, the third landing instantly) and NOTHING was
 * created — the Supabase mirror showed zero new tasks. The route
 * sequentially awaits adapter calls through the REAL
 * workflow-write-mirror (one setDoc per step task + per member),
 * and no layer of that chain carried a deadline: one PostgREST
 * fetch whose promise never settles pins the whole request.
 *
 * This suite wires the route to the real mirror and the real
 * adapter factory over a transport whose promises never settle.
 * The create must still answer 200 with every step persisted to
 * Firestore (the mirror's contract: a mirror failure never fails
 * the write). On the pre-fix tree the POST promise never settles
 * and the test fails, exactly as the form hung.
 */
const CREATOR = 'creator-1';

const mockSendEmail = jest.fn().mockResolvedValue({ success: true });

const USERS: Record<string, any> = {
  'creator-1': { displayName: 'The Creator', email: 'creator@example.com' },
  'user-a': { displayName: 'Alice A', email: 'alice@example.com' },
  'user-b': { displayName: 'Bob B' },
};

const mockTaskDocs: Array<{ id: string; data: any }> = [];
let taskSeq = 0;

function userDocRef(uid: string): any {
  return {
    get: async () => {
      const data = USERS[uid];
      return { exists: !!data, data: () => data };
    },
    set: async () => {},
    collection: (_sub: string) => ({
      doc: () => ({ set: async () => {} }),
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

const mockDb: any = {
  collection: (name: string) => {
    if (name === 'users') return { doc: (uid: string) => userDocRef(uid) };
    if (name === 'tasks') {
      return {
        doc: (id?: string) => taskDocRef(id ?? `task-${++taskSeq}`, mockTaskDocs),
        where: () => { throw new Error('where() not used by POST'); },
      };
    }
    if (name === 'workflow_members') return { doc: (id: string) => ({ id, set: async () => {}, get: async () => ({ exists: false, data: () => undefined }) }) };
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
jest.mock('@/lib/server/user-status', () => ({
  validateUserStatus: jest.fn().mockResolvedValue({ isValid: true }),
  resolveUserDisplayName: jest.fn().mockResolvedValue(null),
}));
jest.mock('@/lib/mailer', () => ({
  sendEmailNotification: (...args: any[]) => mockSendEmail(...args),
}));
jest.mock('@/lib/server/discipline/suspension', () => ({
  suspensionBlock: jest.fn(async () => null),
}));

import { POST } from '../route';
import { createSupaAdapter } from '@/lib/supa/adapter';
import { __setWorkflowWriteMirrorLoaderForTests } from '@/lib/server/workflow-write-mirror';

/** A supabase-js-shaped client whose every transport promise never settles. */
function neverSettlingClient(): any {
  const never = () => new Promise<any>(() => {});
  const chain: any = {
    maybeSingle: () => never(),
    then: (onFulfilled?: any, onRejected?: any) => never().then(onFulfilled, onRejected),
  };
  for (const m of ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'is', 'not', 'filter', 'order', 'limit']) {
    chain[m] = () => chain;
  }
  const table: any = {
    select: () => chain,
    upsert: () => never(),
    update: () => chain,
    delete: () => chain,
  };
  return { from: () => table, rpc: () => never() };
}

function makeRequest(body?: any): any {
  return {
    json: async () => body ?? {},
    url: 'http://localhost/api/workflows',
    headers: { get: () => 'Bearer <redacted>' },
    cookies: { get: () => undefined },
  };
}

const WORKFLOW_BODY = {
  workflowId: 'wf-stall-1',
  workflowTitle: 'Stall Test Workflow',
  finalDeadline: '2027-06-01T00:00:00.000Z',
  steps: [
    { title: 'Step One', description: 'first', assigneeId: 'user-a', assigneeIds: ['user-a', 'user-b'] },
    { title: 'Step Two', description: 'second', assigneeId: CREATOR },
  ],
};

describe('POST /api/workflows with a stalled Supabase transport', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockTaskDocs.length = 0;
    taskSeq = 0;
    __setWorkflowWriteMirrorLoaderForTests(async () => ({
      useSupa: () => true,
      getSupaClient: () => ({}),
      getSupaAdapter: () => createSupaAdapter(neverSettlingClient()),
    }));
  });
  afterEach(() => {
    __setWorkflowWriteMirrorLoaderForTests(null);
    jest.useRealTimers();
  });

  it('still answers 200 and persists every step to Firestore', async () => {
    let settled = false;
    let res: any = null;
    void POST(makeRequest(WORKFLOW_BODY)).then(
      (r) => { settled = true; res = r; },
      () => { settled = true; },
    );
    // 2 step mirrors + 3 member mirrors, each bounded by the
    // adapter deadline — 300s of fake time is far beyond the worst
    // case, and costs nothing if every call settles sooner.
    await jest.advanceTimersByTimeAsync(300_000);
    expect(settled).toBe(true);
    expect(res?.status).toBe(200);
    const body = await res.json();
    expect(body.createdCount).toBe(2);
    // The Firestore writes stand even though every mirror call stalled.
    expect(mockTaskDocs.map((t) => t.id).sort()).toEqual(['task-1', 'task-2']);
  });
});
