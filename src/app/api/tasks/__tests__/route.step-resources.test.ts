/**
 * Regression test for the dual-write clobber in handleUpdate
 * (src/app/api/tasks/route.ts).
 *
 * Bug: when a PATCH carries BOTH a stale top-level `updates.resources`
 * (e.g. [] from the edit dialog's master form) AND `updates.steps` where
 * one step's id equals the edited taskId, the Firestore batch queued the
 * step-doc write FIRST and the master task write LAST. Because both target
 * the same doc (the edited task IS the step doc) and Firestore applies
 * same-doc batch writes in queue order, the stale top-level `resources`
 * overwrote the step's fresh resources.
 *
 * Fix under test: when the edited taskId matches a step id that carries a
 * resources array, the stale top-level `updates.resources` is dropped before
 * the master write, so the step write's resources survive the batch.
 *
 * This test exercises the real handleUpdate via the PATCH export with a
 * fully mocked Firestore, and simulates batch apply order to prove the
 * final stored resources are the step's 10 links, not the stale [].
 */

const mockBatchOps: Array<{ op: string; path: string; data?: any }> = [];

// In-memory "tasks" docs the fake Firestore serves.
const mockDocs: Record<string, any> = {
  'tasks/step1-id': {
    title: 'Step 1',
    status: 'pending',
    workflowId: 'wf-1',
    workflowTitle: 'Test Workflow',
    workflowParticipantIds: ['user-1', 'user-2'],
    assigneeId: 'user-1',
  },
  'tasks/step2-id': {
    title: 'Step 2',
    status: 'pending',
    workflowId: 'wf-1',
    workflowTitle: 'Test Workflow',
    workflowParticipantIds: ['user-1', 'user-2'],
    assigneeId: 'user-2',
  },
};

const mockDb = {
  collection: (name: string) => ({
    doc: (id?: string) => {
      const docId = id ?? 'generated-id';
      const path = `${name}/${docId}`;
      return {
        id: docId,
        path,
        get: async () => {
          const data = mockDocs[path];
          return { exists: data !== undefined, data: () => data };
        },
      };
    },
    // The "next sequenceIndex" lookup finds no existing step docs.
    where: () => ({ get: async () => ({ docs: [] }) }),
  }),
  batch: () => ({
    update: (ref: any, data: any) => {
      mockBatchOps.push({ op: 'update', path: ref.path, data });
    },
    set: (ref: any, data: any, opts?: any) => {
      mockBatchOps.push({ op: 'set', path: ref.path, data, opts });
    },
    delete: (ref: any) => {
      mockBatchOps.push({ op: 'delete', path: ref.path });
    },
    commit: async () => undefined,
  }),
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
        Timestamp: { now: () => ({ __ts: 'now' }) },
        FieldValue,
      },
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
    verifyIdTokenString: async () => ({
      uid: 'admin-uid',
      role: 'admin',
      permissions: { manageTasks: true },
    }),
    SessionError: MockSessionError,
  };
});

jest.mock('@/lib/mailer', () => ({
  sendEmailNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/server/user-status', () => ({
  validateUserStatus: jest.fn().mockResolvedValue({ isValid: true }),
}));

jest.mock('@/lib/server/gamification-transaction', () => ({
  executeGamificationTransaction: jest.fn(),
}));

jest.mock('@/lib/server/hierarchy-utils', () => ({
  isManagerAbove: jest.fn().mockResolvedValue(false),
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

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(true),
  hasServerPermissionForUser: jest.fn().mockResolvedValue(true),
  resolveUserRole: jest.fn().mockResolvedValue('admin'),
  assertChapterAccess: jest.fn().mockResolvedValue({ allowed: true }),
}));

import { PATCH } from '../route';

const TEN_LINKS = Array.from({ length: 10 }, (_, i) => ({
  type: 'link' as const,
  url: `https://example.com/resources/step1-${i + 1}`,
  title: `Step 1 Resource ${i + 1}`,
}));

const TWO_LINKS = [
  { type: 'link' as const, url: 'https://example.com/resources/step2-1', title: 'Step 2 Resource 1' },
  { type: 'drive' as const, url: 'https://drive.google.com/step2-2', title: 'Step 2 Resource 2' },
];

function makeRequest(body: any): any {
  const req: any = { json: async () => body };
  req.clone = () => req;
  return req;
}

describe('PATCH /api/tasks dual-write clobber (step resources vs stale top-level resources)', () => {
  beforeEach(() => {
    mockBatchOps.length = 0;
  });

  test('step resources survive when the edited task is itself a step doc', async () => {
    // taskId === step1's id, and the master payload carries a STALE empty
    // resources array (what the edit dialog sends for the master form).
    const res: any = await PATCH(
      makeRequest({
        taskId: 'step1-id',
        updates: {
          resources: [],
          steps: [
            { id: 'step1-id', title: 'Step 1', assigneeId: 'user-1', resources: TEN_LINKS },
            { id: 'step2-id', title: 'Step 2', assigneeId: 'user-2', resources: TWO_LINKS },
          ],
        },
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // The batch must contain TWO writes on tasks/step1-id: the step-doc
    // write first (with the 10 links), then the master task write LAST.
    const step1Updates = mockBatchOps.filter((o) => o.op === 'update' && o.path === 'tasks/step1-id');
    expect(step1Updates).toHaveLength(2);

    // Step write (queued first) carries the fresh resources.
    expect(step1Updates[0].data.resources).toEqual(TEN_LINKS);

    // Master write (queued last) must NOT carry the stale top-level
    // resources, otherwise it would clobber the step write in the batch.
    expect(step1Updates[1].data).not.toHaveProperty('resources');

    // Simulate Firestore batch apply order: same-doc writes apply in queue
    // order, later writes overwriting earlier fields. The final stored
    // resources must be the step's 10 links, not the stale [].
    const finalState: Record<string, any> = {};
    for (const op of mockBatchOps) {
      if (op.op === 'update' || op.op === 'set') {
        finalState[op.path] = { ...(finalState[op.path] ?? {}), ...op.data };
      }
    }
    expect(finalState['tasks/step1-id'].resources).toEqual(TEN_LINKS);
    expect(finalState['tasks/step2-id'].resources).toEqual(TWO_LINKS);
  });

  test('master resources are kept when the edited task is NOT one of the steps', async () => {
    mockDocs['tasks/master-doc-id'] = {
      title: 'Workflow master',
      status: 'pending',
      workflowId: 'wf-1',
      workflowTitle: 'Test Workflow',
      workflowParticipantIds: ['user-1', 'user-2'],
    };
    const masterLinks = [
      { type: 'link' as const, url: 'https://example.com/master-1', title: 'Master Resource' },
    ];
    const res: any = await PATCH(
      makeRequest({
        taskId: 'master-doc-id',
        updates: {
          resources: masterLinks,
          steps: [
            { id: 'step1-id', title: 'Step 1', assigneeId: 'user-1', resources: TEN_LINKS },
            { id: 'step2-id', title: 'Step 2', assigneeId: 'user-2', resources: TWO_LINKS },
          ],
        },
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Master write targets a DIFFERENT doc than the step writes, so the
    // stale-strip must not fire: the master keeps its own resources.
    const masterUpdates = mockBatchOps.filter((o) => o.op === 'update' && o.path === 'tasks/master-doc-id');
    expect(masterUpdates).toHaveLength(1);
    expect(masterUpdates[0].data.resources).toEqual(masterLinks);

    // Step docs still get their own fresh resources.
    const finalState: Record<string, any> = {};
    for (const op of mockBatchOps) {
      if (op.op === 'update' || op.op === 'set') {
        finalState[op.path] = { ...(finalState[op.path] ?? {}), ...op.data };
      }
    }
    expect(finalState['tasks/step1-id'].resources).toEqual(TEN_LINKS);
    expect(finalState['tasks/master-doc-id'].resources).toEqual(masterLinks);
  });
});
