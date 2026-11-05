/**
 * @jest-environment node
 *
 * Regression tests for the silent resources drop on edit save
 * (src/app/api/tasks/route.ts, handleUpdate).
 *
 * Defect (lead-reproduced live 2026-11-05): editing an existing step task
 * in the admin Tasks UI, adding links in "Resources & Logistics", and
 * saving returns SUCCESS, but the stored doc keeps resources: [].
 *
 * Root cause: the PATCH carries TWO copies of the same field — the
 * top-level `updates.resources` (the "Resources & Logistics" editor) and
 * `updates.steps[].resources` (the per-step "Step Resources" editor in the
 * Workflow Plan). When the edited task IS one of the workflow step docs,
 * the batch writes the step copy FIRST and the master update LAST, so the
 * master write wins on that doc. Commit 019ee1a0 fixed the mirror case
 * (fresh step resources vs stale top-level []) by unconditionally
 * deleting the top-level copy. But when the admin edits ONLY the
 * top-level field, the step copy is the stale one (loaded at dialog open,
 * []) and the top-level copy is the fresh one — the delete then drops the
 * fresh value and the step write persists the stale [].
 *
 * Fix under test: the server reconciles the two copies against the stored
 * doc. The copy that differs from stored is the one the admin edited, so
 * it wins; the winning value is written into the master payload as well,
 * so the batch, the response snapshot, and the mirror image all agree.
 *
 * These tests drive the real PATCH handler against FakeFirestore and read
 * the doc back after each save: the record, not the response, is the proof.
 */

const mockDbHolder: { db: any } = { db: null };

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
    getDb: () => mockDbHolder.db,
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

jest.mock('@/lib/server/user-contact', () => ({
  resolveUserEmail: jest.fn(async (_db: any, uid: string) => `${uid}@example.com`),
  resolveUserEmails: jest.fn(async (_db: any, uids: string[]) => new Map(uids.map((u: string) => [u, `${u}@example.com`]))),
  getUserContact: jest.fn(async () => null),
  getUserContacts: jest.fn(async () => new Map()),
  setUserContact: jest.fn(async () => undefined),
  clearUserContact: jest.fn(async () => undefined),
  stripContactFields: (r: any) => r,
}));

jest.mock('@/lib/server/user-status', () => ({
  validateUserStatus: jest.fn().mockResolvedValue({ isValid: true }),
  resolveUserDisplayName: jest.fn().mockResolvedValue('Test User'),
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
  resolveValidatorSubmissionAlerts: jest.fn(),
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

import { createFakeDb, type FakeDb } from '@/lib/server/__tests__/fake-firestore';
import { PATCH } from '../route';

const LINK_A = { type: 'link' as const, url: 'https://example.com/resources/a', title: 'Resource A' };
const LINK_B = { type: 'link' as const, url: 'https://example.com/resources/b', title: 'Resource B' };
const STEP_LINK = { type: 'link' as const, url: 'https://example.com/resources/step-1', title: 'Step Resource 1' };

function makeRequest(body: any): any {
  const req: any = { json: async () => body };
  req.clone = () => req;
  return req;
}

function stepPayload(id: string, assigneeId: string, resources: any[]) {
  return { id, title: `Step ${id}`, assigneeId, resources };
}

let db: FakeDb;

beforeEach(() => {
  db = createFakeDb();
  mockDbHolder.db = db;
  // Two persisted step docs of workflow wf-1, as the edit dialog loads
  // them: step1 starts with NO resources (the live defect's starting
  // state), step2 likewise. Assignees never change in these tests, so
  // no user-counter side effects fire.
  db.seed('tasks', 'step1-id', {
    title: 'Step 1',
    status: 'pending',
    workflowId: 'wf-1',
    workflowTitle: 'Test Workflow',
    workflowParticipantIds: ['user-1', 'user-2'],
    assigneeId: 'user-1',
    assigneeIds: ['user-1'],
    resources: [],
  });
  db.seed('tasks', 'step2-id', {
    title: 'Step 2',
    status: 'pending',
    workflowId: 'wf-1',
    workflowTitle: 'Test Workflow',
    workflowParticipantIds: ['user-1', 'user-2'],
    assigneeId: 'user-2',
    assigneeIds: ['user-2'],
    resources: [],
  });
});

describe('PATCH /api/tasks resources persist on edit save (step task)', () => {
  test('top-level Resources & Logistics edit persists on a step task', async () => {
    // The live repro: admin opens step1, adds a link in "Resources &
    // Logistics", saves. The step copy in the payload is the stale
    // load-time [] (the admin never touched "Step Resources").
    const res: any = await PATCH(
      makeRequest({
        taskId: 'step1-id',
        updates: {
          title: 'Step 1',
          resources: [LINK_A],
          steps: [
            stepPayload('step1-id', 'user-1', []),
            stepPayload('step2-id', 'user-2', []),
          ],
        },
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    const stored = db.read('tasks', 'step1-id');
    expect(stored?.resources).toEqual([LINK_A]);
  });

  test('per-step Step Resources edit persists when assignee validation passes', async () => {
    // The second route: admin edits ONLY the step's "Step Resources" in
    // the Workflow Plan section; the top-level copy is the stale [].
    // (validateUserStatus is mocked valid, so the assignee gate passes.)
    const res: any = await PATCH(
      makeRequest({
        taskId: 'step1-id',
        updates: {
          title: 'Step 1',
          resources: [],
          steps: [
            stepPayload('step1-id', 'user-1', [STEP_LINK]),
            stepPayload('step2-id', 'user-2', []),
          ],
        },
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    const stored = db.read('tasks', 'step1-id');
    expect(stored?.resources).toEqual([STEP_LINK]);
  });

  test('create-then-edit: a resource stored at creation survives an edit that adds another', async () => {
    // The stored doc already carries a resource from creation time;
    // the edit adds a second one via the top-level editor.
    db.seed('tasks', 'step1-id', {
      ...(db.read('tasks', 'step1-id') as any),
      resources: [LINK_A],
    });
    const res: any = await PATCH(
      makeRequest({
        taskId: 'step1-id',
        updates: {
          title: 'Step 1',
          resources: [LINK_A, LINK_B],
          steps: [
            stepPayload('step1-id', 'user-1', [LINK_A]),
            stepPayload('step2-id', 'user-2', []),
          ],
        },
      }),
    );
    expect(res.status).toBe(200);

    const stored = db.read('tasks', 'step1-id');
    expect(stored?.resources).toEqual([LINK_A, LINK_B]);
  });

  test('edit twice: a second edit replaces resources exactly as entered', async () => {
    const first: any = await PATCH(
      makeRequest({
        taskId: 'step1-id',
        updates: {
          title: 'Step 1',
          resources: [LINK_A],
          steps: [
            stepPayload('step1-id', 'user-1', []),
            stepPayload('step2-id', 'user-2', []),
          ],
        },
      }),
    );
    expect(first.status).toBe(200);
    expect(db.read('tasks', 'step1-id')?.resources).toEqual([LINK_A]);

    // Dialog re-opened after the first save: the step copy now loads
    // [LINK_A]; the admin replaces it with [LINK_B] via the top level.
    const second: any = await PATCH(
      makeRequest({
        taskId: 'step1-id',
        updates: {
          title: 'Step 1',
          resources: [LINK_B],
          steps: [
            stepPayload('step1-id', 'user-1', [LINK_A]),
            stepPayload('step2-id', 'user-2', []),
          ],
        },
      }),
    );
    expect(second.status).toBe(200);

    const stored = db.read('tasks', 'step1-id');
    expect(stored?.resources).toEqual([LINK_B]);
  });

  test('a save that changes nothing else leaves resources untouched', async () => {
    db.seed('tasks', 'step1-id', {
      ...(db.read('tasks', 'step1-id') as any),
      resources: [LINK_A],
    });
    const res: any = await PATCH(
      makeRequest({
        taskId: 'step1-id',
        updates: {
          title: 'Step 1 (renamed)',
          resources: [LINK_A],
          steps: [
            stepPayload('step1-id', 'user-1', [LINK_A]),
            stepPayload('step2-id', 'user-2', []),
          ],
        },
      }),
    );
    expect(res.status).toBe(200);

    const stored = db.read('tasks', 'step1-id');
    expect(stored?.resources).toEqual([LINK_A]);
    expect(stored?.title).toBe('Step 1 (renamed)');
  });

  test('clearing all resources via the top-level editor persists as []', async () => {
    db.seed('tasks', 'step1-id', {
      ...(db.read('tasks', 'step1-id') as any),
      resources: [LINK_A],
    });
    const res: any = await PATCH(
      makeRequest({
        taskId: 'step1-id',
        updates: {
          title: 'Step 1',
          resources: [],
          steps: [
            stepPayload('step1-id', 'user-1', [LINK_A]),
            stepPayload('step2-id', 'user-2', []),
          ],
        },
      }),
    );
    expect(res.status).toBe(200);

    const stored = db.read('tasks', 'step1-id');
    expect(stored?.resources).toEqual([]);
  });
});
