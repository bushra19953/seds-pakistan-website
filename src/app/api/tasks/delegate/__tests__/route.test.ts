/**
 * @jest-environment node
 *
 * Supabase migration (tasks cluster, group 4) — pins the CURRENT
 * behavior of POST/PATCH /api/tasks/delegate under both seam states.
 *
 * These tests intentionally pin two PRE-EXISTING DEFECTS (owned by the
 * defect-fix program; do NOT "fix" them here — see
 * src/lib/supa/seam-tasks-delegate.ts and supa-rebase-notes/tasks-4.md):
 *
 *  FD-01: the route reads `(auth.user as any).uid`, but
 *  verifyAuthentication returns an AuthContext
 *  `{ user, userId, email, displayName, emailVerified, role }` with no
 *  top-level `uid`. callerUid is therefore always undefined and POST
 *  always 403s, even for the task's real assignee.
 *
 *  TS-P01: nothing writes `task.delegation`, so PATCH always answers
 *  400 'No pending delegation' for an existing task.
 *
 * Flag OFF = seam helpers return null/false (adapter absent), route
 * runs its original Firestore path. Flag ON = seam helpers return a
 * MOCKED adapter's document; the observable outcome must be identical,
 * byte for byte, including the FD-01 403 and the TS-P01 400.
 */

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(),
}));

jest.mock('@/lib/mailer', () => ({
  sendEmailNotification: jest.fn().mockResolvedValue(undefined),
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  admin: {
    firestore: {
      FieldPath: { documentId: () => '__documentId__' },
      FieldValue: {
        serverTimestamp: () => 'SERVER_TS',
        increment: (n: number) => `INC(${n})`,
      },
    },
  },
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
}));

jest.mock('@/lib/supa/seam-tasks-delegate', () => ({
  getTaskDocViaSeam: jest.fn().mockResolvedValue(null),
  getUserDocViaSeam: jest.fn().mockResolvedValue(null),
  listUsersByIdsViaSeam: jest.fn().mockResolvedValue(null),
  updateTaskDocViaSeam: jest.fn().mockResolvedValue(false),
}));

import { NextRequest } from 'next/server';
import { POST, PATCH } from '@/app/api/tasks/delegate/route';
import { verifyAuthentication } from '@/lib/auth-middleware';
import {
  getTaskDocViaSeam,
  getUserDocViaSeam,
  listUsersByIdsViaSeam,
  updateTaskDocViaSeam,
} from '@/lib/supa/seam-tasks-delegate';

const mockAuth = verifyAuthentication as jest.Mock;
const mockGetTaskDocViaSeam = getTaskDocViaSeam as jest.Mock;
const mockGetUserDocViaSeam = getUserDocViaSeam as jest.Mock;
const mockListUsersByIdsViaSeam = listUsersByIdsViaSeam as jest.Mock;
const mockUpdateTaskDocViaSeam = updateTaskDocViaSeam as jest.Mock;

const REAL_UID = 'real-assignee-uid';

/** The exact AuthContext shape verifyAuthentication returns in prod. */
function authenticatedContext() {
  return {
    authenticated: true,
    user: {
      user: { uid: REAL_UID, email: 'assignee@example.com' },
      userId: REAL_UID,
      email: 'assignee@example.com',
      displayName: 'Real Assignee',
      emailVerified: true,
      role: 'member',
      // NOTE: deliberately NO top-level `uid` — that is FD-01.
    },
  };
}

const EXISTING_TASK = {
  title: 'Parent mission',
  assigneeId: REAL_UID,
  assigneeIds: [REAL_UID],
  points: 100,
  status: 'pending',
  // NOTE: no `delegation` field — that is TS-P01.
};

function makeFirestoreDb(taskData: Record<string, unknown> | null) {
  const taskGet = jest.fn().mockResolvedValue({
    exists: taskData !== null,
    id: 'task-1',
    data: () => taskData ?? undefined,
  });
  const taskUpdate = jest.fn().mockResolvedValue(undefined);
  const db = {
    collection: jest.fn((name: string) => {
      if (name !== 'tasks') throw new Error(`unexpected collection ${name}`);
      return {
        doc: (id?: string) => ({
          id: id ?? 'generated-id',
          get: taskGet,
          update: taskUpdate,
          collection: () => ({ doc: () => ({ id: 'sub-id' }) }),
        }),
        where: jest.fn(),
      };
    }),
    batch: jest.fn(),
  };
  return { db, taskGet, taskUpdate };
}

function seamSnapshot(taskData: Record<string, unknown> | null) {
  return {
    exists: taskData !== null,
    id: 'task-1',
    data: () => taskData ?? undefined,
  };
}

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/tasks/delegate', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function patchRequest(body: unknown) {
  return new NextRequest('http://localhost/api/tasks/delegate', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const VALID_POST_BODY = {
  taskId: 'task-1',
  pointsKept: 40,
  workflowSteps: [{ title: 'Step 1', description: 'Do it', points: 60, assigneeId: 'other-uid' }],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTaskDocViaSeam.mockResolvedValue(null);
  mockGetUserDocViaSeam.mockResolvedValue(null);
  mockListUsersByIdsViaSeam.mockResolvedValue(null);
  mockUpdateTaskDocViaSeam.mockResolvedValue(false);
  mockAuth.mockResolvedValue(authenticatedContext());
});

describe('flag OFF (seam unavailable -> original Firestore path)', () => {
  it('POST: 401 when unauthenticated', async () => {
    mockAuth.mockResolvedValue({ authenticated: false });
    const { db } = makeFirestoreDb(EXISTING_TASK);
    mockDbHolder.db = db;
    const res = await POST(postRequest(VALID_POST_BODY));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('POST: 400 when taskId missing', async () => {
    const { db } = makeFirestoreDb(EXISTING_TASK);
    mockDbHolder.db = db;
    const res = await POST(postRequest({ workflowSteps: VALID_POST_BODY.workflowSteps }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'taskId is required' });
  });

  it('POST: 404 when the task does not exist', async () => {
    const { db, taskGet } = makeFirestoreDb(null);
    mockDbHolder.db = db;
    const res = await POST(postRequest(VALID_POST_BODY));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Task not found' });
    expect(mockGetTaskDocViaSeam).toHaveBeenCalledWith('task-1');
    expect(taskGet).toHaveBeenCalledTimes(1);
  });

  it('POST: FD-01 — the real assignee still gets the 403, byte-identical', async () => {
    const { db, taskGet } = makeFirestoreDb(EXISTING_TASK);
    mockDbHolder.db = db;
    const res = await POST(postRequest(VALID_POST_BODY));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Only the task assignee can delegate' });
    expect(taskGet).toHaveBeenCalledTimes(1);
    // Nothing past the 403 may run.
    expect(mockGetUserDocViaSeam).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('PATCH: 404 when the task does not exist', async () => {
    const { db } = makeFirestoreDb(null);
    mockDbHolder.db = db;
    const res = await PATCH(patchRequest({ taskId: 'task-1', action: 'accept' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Task not found' });
  });

  it('PATCH: 400 on invalid action', async () => {
    const { db } = makeFirestoreDb(EXISTING_TASK);
    mockDbHolder.db = db;
    const res = await PATCH(patchRequest({ taskId: 'task-1', action: 'maybe' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'taskId and action (accept/reject) required' });
  });

  it('PATCH: TS-P01 — always "No pending delegation" for an existing task', async () => {
    const { db, taskUpdate } = makeFirestoreDb(EXISTING_TASK);
    mockDbHolder.db = db;
    const res = await PATCH(patchRequest({ taskId: 'task-1', action: 'accept' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'No pending delegation' });
    expect(taskUpdate).not.toHaveBeenCalled();
    expect(mockUpdateTaskDocViaSeam).not.toHaveBeenCalled();
  });
});

describe('flag ON (mocked adapter via the seam) — identical outcomes', () => {
  it('POST: FD-01 403 is identical when the task comes from the adapter', async () => {
    const { db, taskGet } = makeFirestoreDb(null);
    mockDbHolder.db = db;
    mockGetTaskDocViaSeam.mockResolvedValue(seamSnapshot(EXISTING_TASK));
    const res = await POST(postRequest(VALID_POST_BODY));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Only the task assignee can delegate' });
    // The Firestore read must NOT run when the seam resolved the doc.
    expect(taskGet).not.toHaveBeenCalled();
    expect(mockGetUserDocViaSeam).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('POST: 404 is identical when the adapter reports no task', async () => {
    const { db, taskGet } = makeFirestoreDb(EXISTING_TASK);
    mockDbHolder.db = db;
    mockGetTaskDocViaSeam.mockResolvedValue(seamSnapshot(null));
    const res = await POST(postRequest(VALID_POST_BODY));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Task not found' });
    expect(taskGet).not.toHaveBeenCalled();
  });

  it('PATCH: TS-P01 400 is identical when the task comes from the adapter', async () => {
    const { db, taskGet, taskUpdate } = makeFirestoreDb(null);
    mockDbHolder.db = db;
    mockGetTaskDocViaSeam.mockResolvedValue(seamSnapshot(EXISTING_TASK));
    const res = await PATCH(patchRequest({ taskId: 'task-1', action: 'reject' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'No pending delegation' });
    expect(taskGet).not.toHaveBeenCalled();
    expect(taskUpdate).not.toHaveBeenCalled();
    expect(mockUpdateTaskDocViaSeam).not.toHaveBeenCalled();
  });

  it('PATCH: 404 is identical when the adapter reports no task', async () => {
    const { db, taskGet } = makeFirestoreDb(EXISTING_TASK);
    mockDbHolder.db = db;
    mockGetTaskDocViaSeam.mockResolvedValue(seamSnapshot(null));
    const res = await PATCH(patchRequest({ taskId: 'task-1', action: 'accept' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Task not found' });
    expect(taskGet).not.toHaveBeenCalled();
  });
});
