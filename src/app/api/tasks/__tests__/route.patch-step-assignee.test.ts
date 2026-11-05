/**
 * @jest-environment node
 *
 * Regression tests for the silent assignee-change failure on workflow
 * step tasks (src/app/api/tasks/route.ts, handleUpdate).
 *
 * Live defect (2026-11-05): reassigning a workflow step task in the
 * admin Edit dialog (Step 2 Huzaifah -> Emaan, Step 3 Ahmed ->
 * Huzaifah) never persisted; title/description-only edits on sibling
 * steps saved fine.
 *
 * Server half of the root cause: the "Invalid assignee for workflow"
 * guard validates the NEW primary assignee against the STORED
 * workflowParticipantIds, even though the normalization block directly
 * above it merges the request's assigneeIds into that allowlist
 * precisely so newly added people can be assigned. A first-time
 * assignee who is not already on the stored list is therefore rejected
 * with a 400 and the whole update (every other field included) is
 * lost. The guard must validate against the merged list it was
 * written to protect.
 *
 * These tests drive the real PATCH handler against FakeFirestore and
 * read the doc back after each save: the record, not the response, is
 * the proof.
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

function makeRequest(body: any): any {
  const req: any = { json: async () => body };
  req.clone = () => req;
  return req;
}

function stepPayload(id: string, assigneeId: string) {
  return { id, title: `Step ${id}`, assigneeId, resources: [] };
}

let db: FakeDb;

beforeEach(() => {
  db = createFakeDb();
  mockDbHolder.db = db;
  // Two persisted step docs of workflow wf-1. The stored participant
  // list names user-1 and user-2 only: user-3 is a legitimate member
  // the admin assigns for the first time with this very edit (the
  // request's assigneeIds are what should admit them).
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

describe('PATCH /api/tasks assignee change on a step task', () => {
  test('reassigning to a user not yet on the stored participant list persists', async () => {
    const res: any = await PATCH(
      makeRequest({
        taskId: 'step2-id',
        updates: {
          title: 'Step 2',
          assigneeId: 'user-3',
          assigneeIds: ['user-3'],
          steps: [
            stepPayload('step1-id', 'user-1'),
            // The plan copy of the edited step still carries its stored
            // assignee (the admin edited the top-level field only); the
            // top-level change is the one that must land on the doc.
            stepPayload('step2-id', 'user-2'),
          ],
        },
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    const stored = db.read('tasks', 'step2-id');
    expect(stored?.assigneeId).toBe('user-3');
    expect(stored?.assigneeIds).toEqual(['user-3']);
    // The allowlist itself is extended by the save, so later edits of
    // this doc see the new assignee as a participant.
    expect(stored?.workflowParticipantIds).toEqual(
      expect.arrayContaining(['user-1', 'user-2', 'user-3']),
    );
    // The sibling step is untouched.
    expect(db.read('tasks', 'step1-id')?.assigneeId).toBe('user-1');
  });

  test('reassigning to an existing participant still persists', async () => {
    const res: any = await PATCH(
      makeRequest({
        taskId: 'step2-id',
        updates: {
          title: 'Step 2',
          assigneeId: 'user-1',
          assigneeIds: ['user-1'],
          steps: [
            stepPayload('step1-id', 'user-1'),
            stepPayload('step2-id', 'user-2'),
          ],
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(db.read('tasks', 'step2-id')?.assigneeId).toBe('user-1');
  });

  test('a plan step without an assignee rejects the whole update (why the corrupted client payload lost every field)', async () => {
    // What the pre-fix edit dialog actually sent after its assignee
    // cascade ran: steps whose assigneeId had been cleared (undefined
    // is dropped by JSON). The schema requires a non-empty assigneeId
    // per step, so the entire PATCH — title, resources, everything —
    // is rejected and nothing persists.
    const res: any = await PATCH(
      makeRequest({
        taskId: 'step2-id',
        updates: {
          title: 'Step 2 (renamed)',
          assigneeId: 'user-3',
          assigneeIds: ['user-3'],
          steps: [
            { id: 'step1-id', title: 'Step step1-id', resources: [] },
            { id: 'step2-id', title: 'Step step2-id', resources: [] },
          ],
        },
      }),
    );
    expect(res.status).toBe(400);
    const stored = db.read('tasks', 'step2-id');
    expect(stored?.assigneeId).toBe('user-2');
    expect(stored?.title).toBe('Step 2');
  });

  test('an assignee outside the request roster is still rejected', async () => {
    // The guard keeps its teeth: a primary assignee that the request
    // itself does not carry in assigneeIds is not admitted.
    const res: any = await PATCH(
      makeRequest({
        taskId: 'step2-id',
        updates: {
          title: 'Step 2',
          assigneeId: 'user-9',
          steps: [
            stepPayload('step1-id', 'user-1'),
            stepPayload('step2-id', 'user-2'),
          ],
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(db.read('tasks', 'step2-id')?.assigneeId).toBe('user-2');
  });
});
