/**
 * PATCH /api/tasks reviewerIds precedence (fix/reviewer-door gap fix).
 *
 * The PATCH update schema is .strict() and previously declared only
 * reviewerId, so a PATCH carrying reviewerIds (the multi-reviewer
 * stamp the post-deploy migration writes) was rejected 400 — and the
 * handler forcibly derived reviewerIds = [reviewerId] whenever
 * reviewerId was a non-empty string, which would clobber a multi
 * stamp anyway.
 *
 * Precedence under test:
 *  - reviewerIds provided non-empty: wins verbatim (dedupe, blanks
 *    trimmed); reviewerId is set to its first element.
 *  - reviewerIds provided as []: explicit clear — both fields delete.
 *  - reviewerIds absent: reviewerId drives (string derives
 *    [reviewerId]; explicit null clears both).
 *  - Unknown extra keys still 400 (strict schema intact).
 */

const mockBatchOps: Array<{ op: string; path: string; data?: any; opts?: any }> = [];

const mockDocs: Record<string, any> = {};

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

function makeRequest(body: any): any {
  const req: any = { json: async () => body };
  req.clone = () => req;
  return req;
}

function masterWrite() {
  const writes = mockBatchOps.filter(
    (o) => (o.op === 'update' || o.op === 'set') && o.path === 'tasks/task-1',
  );
  expect(writes.length).toBeGreaterThan(0);
  return writes[writes.length - 1].data;
}

describe('PATCH /api/tasks reviewerIds precedence', () => {
  beforeEach(() => {
    mockBatchOps.length = 0;
    for (const k of Object.keys(mockDocs)) delete mockDocs[k];
    mockDocs['tasks/task-1'] = {
      title: 'Legacy step',
      status: 'pending',
      assigneeId: 'doer-uid',
      assignerId: 'admin-uid',
      reviewerId: 'old-lead',
      reviewerIds: ['old-lead'],
    };
  });

  test('reviewerIds [lead, co] stores both and sets reviewerId to the lead', async () => {
    const res: any = await PATCH(
      makeRequest({
        taskId: 'task-1',
        updates: { reviewerIds: ['lead-uid', 'co-uid', 'lead-uid', '  '] },
      }),
    );
    expect(res.status).toBe(200);
    const data = masterWrite();
    expect(data.reviewerIds).toEqual(['lead-uid', 'co-uid']);
    expect(data.reviewerId).toBe('lead-uid');
  });

  test('reviewerId only still derives reviewerIds = [reviewerId]', async () => {
    const res: any = await PATCH(
      makeRequest({
        taskId: 'task-1',
        updates: { reviewerId: 'solo-uid' },
      }),
    );
    expect(res.status).toBe(200);
    const data = masterWrite();
    expect(data.reviewerId).toBe('solo-uid');
    expect(data.reviewerIds).toEqual(['solo-uid']);
  });

  test('reviewerId null clears both fields', async () => {
    const res: any = await PATCH(
      makeRequest({
        taskId: 'task-1',
        updates: { reviewerId: null },
      }),
    );
    expect(res.status).toBe(200);
    const data = masterWrite();
    expect(data.reviewerId).toEqual({ __fv: 'delete' });
    expect(data.reviewerIds).toEqual({ __fv: 'delete' });
  });

  test('reviewerIds [] clears both fields', async () => {
    const res: any = await PATCH(
      makeRequest({
        taskId: 'task-1',
        updates: { reviewerIds: [] },
      }),
    );
    expect(res.status).toBe(200);
    const data = masterWrite();
    expect(data.reviewerId).toEqual({ __fv: 'delete' });
    expect(data.reviewerIds).toEqual({ __fv: 'delete' });
  });

  test('unknown extra key still 400s (strict schema intact)', async () => {
    const res: any = await PATCH(
      makeRequest({
        taskId: 'task-1',
        updates: { reviewerIds: ['lead-uid'], notARealField: 'x' },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockBatchOps).toHaveLength(0);
  });
});
