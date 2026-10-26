/**
 * @jest-environment node
 *
 * UX fix program F4 (audit P8, data bug): POST /api/workflows must not
 * drop a step's primary `assigneeId` when `assigneeIds` is non-empty.
 * The persisted step task must carry the primary FIRST in `assigneeIds`
 * (deduped), with `assigneeId` unchanged, so workflowParticipantIds and
 * every reader see the full assignee list.
 *
 * Harness mirrors supa-roles-workflows-pin.test.ts: the real route runs
 * against the CountingFirestore fake; ZERO live reads. On the base tree
 * the union assertions below fail (the primary is dropped).
 */

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  admin: {
    auth: () => ({
      verifyIdToken: async (token: string) => {
        const uid = token.startsWith('tok:') ? token.slice(4) : token;
        return { uid, email: `${uid}@example.com`, email_verified: true, name: uid };
      },
    }),
    firestore: {
      FieldValue: {
        serverTimestamp: () => 'ts',
        increment: (n: number) => ({ __increment: n }),
        delete: () => ({ __delete: true }),
      },
    },
  },
}));
jest.mock('firebase/auth', () => ({ getAuth: jest.fn() }));
jest.mock('@/firebase', () => ({ getFirebaseApp: jest.fn() }));
jest.mock('@/firebase/error-emitter', () => ({ errorEmitter: { emit: jest.fn() } }));
jest.mock('@/firebase/errors', () => ({
  FirestorePermissionError: class FirestorePermissionError extends Error {
    constructor() {
      super('permission-error');
    }
  },
}));

import { NextRequest } from 'next/server';
import { CountingFirestore } from '@/lib/server/__tests__/helpers/counting-firestore';
import { resetIdentityCache } from '@/lib/server/identity-cache';
import { POST as workflowsPOST } from '@/app/api/workflows/route';

const CHAPTER = 'seds-ist-chapter';
let counting: CountingFirestore;

function seed() {
  counting.seed('roles', 'officer-1', { role: 'chapter_president', chapterId: CHAPTER });
  counting.seed('users', 'officer-1', { isBanned: false, chapterId: CHAPTER, displayName: 'Officer' });
  counting.seed('roleDefinitions', 'chapter_president', {
    name: 'Chapter President',
    permissions: ['canManageTasks'],
  });
  counting.seed('users', 'member-2', { isBanned: false, chapterId: CHAPTER, displayName: 'Primary' });
  counting.seed('users', 'member-3', { isBanned: false, chapterId: CHAPTER, displayName: 'Co Assignee' });
}

function makeReq(step: Record<string, unknown>) {
  const body = {
    workflowId: 'wf-f4-merge',
    workflowTitle: 'F4 Workflow',
    finalDeadline: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    steps: [{ title: 'Step 1', description: 'do it', ...step }],
  };
  return new NextRequest('http://localhost/api/workflows', {
    method: 'POST',
    headers: { authorization: 'Bearer tok:officer-1', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function createdStepTasks() {
  return counting.fake
    .all('tasks')
    .filter((t) => (t.data as any).workflowId === 'wf-f4-merge');
}

beforeEach(() => {
  resetIdentityCache();
  counting = new CountingFirestore();
  mockDbHolder.db = counting.asDb();
  seed();
  delete process.env.SUPA_SURFACES;
});

describe('POST /api/workflows step assignee merge (F4)', () => {
  it('keeps the primary assignee when assigneeIds is also present', async () => {
    const res = await workflowsPOST(
      makeReq({ assigneeId: 'member-2', assigneeIds: ['member-3'] })
    );
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    const tasks = createdStepTasks();
    expect(tasks).toHaveLength(1);
    const data = tasks[0].data as any;
    expect(data.assigneeId).toBe('member-2');
    expect(data.assigneeIds).toEqual(['member-2', 'member-3']);
    expect(data.workflowParticipantIds).toEqual(
      expect.arrayContaining(['member-2', 'member-3'])
    );
  });

  it('dedupes when assigneeIds already contains the primary', async () => {
    const res = await workflowsPOST(
      makeReq({ assigneeId: 'member-2', assigneeIds: ['member-2', 'member-3'] })
    );
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    const tasks = createdStepTasks();
    expect(tasks).toHaveLength(1);
    const data = tasks[0].data as any;
    expect(data.assigneeId).toBe('member-2');
    expect(data.assigneeIds).toEqual(['member-2', 'member-3']);
  });

  it('leaves a solo assignee untouched', async () => {
    const res = await workflowsPOST(makeReq({ assigneeId: 'member-2' }));
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    const tasks = createdStepTasks();
    expect(tasks).toHaveLength(1);
    const data = tasks[0].data as any;
    expect(data.assigneeId).toBe('member-2');
    expect(data.assigneeIds).toEqual(['member-2']);
  });
});
