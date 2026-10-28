/**
 * @jest-environment node
 *
 * Roster-sync fix: PATCH /api/workflows changes a step's assignees, but
 * the step docs' workflowParticipantIds arrays used to keep the ORIGINAL
 * roster forever — and the /api/tasks reassignment guard judges new
 * assignees against that stale roster. When a PATCH changes a step's
 * assignee set, the route must recompute the roster as the union of
 * every step's assignees and stamp it on every step doc of the
 * workflow, recording rosterSynced on the audit entry. Status-only
 * updates must not touch rosters at all.
 *
 * Harness mirrors route-step-assignee-merge.test.ts: the real route
 * runs against the CountingFirestore fake; ZERO live reads. On the
 * base tree the roster assertions below fail (rosters stay stale).
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
import { PATCH as workflowsPATCH } from '@/app/api/workflows/route';

const CHAPTER = 'seds-ist-chapter';
const WF = 'wf-roster';
let counting: CountingFirestore;

function seed() {
  counting.seed('roles', 'officer-1', { role: 'chapter_president', chapterId: CHAPTER });
  counting.seed('users', 'officer-1', { isBanned: false, chapterId: CHAPTER, displayName: 'Officer' });
  counting.seed('roleDefinitions', 'chapter_president', {
    name: 'Chapter President',
    permissions: ['canManageTasks'],
  });
  for (const uid of ['member-a', 'member-b', 'member-c', 'member-new']) {
    counting.seed('users', uid, { isBanned: false, chapterId: CHAPTER, displayName: uid });
  }
  counting.seed('tasks', 'step-0', {
    workflowId: WF,
    sequenceIndex: 0,
    title: 'Step 0',
    status: 'pending',
    assigneeId: 'member-a',
    assigneeIds: ['member-a'],
    workflowParticipantIds: ['member-a', 'member-b'],
  });
  counting.seed('tasks', 'step-1', {
    workflowId: WF,
    sequenceIndex: 1,
    title: 'Step 1',
    status: 'pending',
    assigneeId: 'member-b',
    assigneeIds: ['member-b'],
    workflowParticipantIds: ['member-a', 'member-b'],
  });
}

function makePatch(sequenceIndex: number, updates: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/workflows', {
    method: 'PATCH',
    headers: { authorization: 'Bearer tok:officer-1', 'content-type': 'application/json' },
    body: JSON.stringify({ workflowId: WF, sequenceIndex, updates }),
  });
}

function rosterOf(id: string) {
  return (counting.read('tasks', id) as any)?.workflowParticipantIds;
}

function audits() {
  return counting.all('workflow_audits').map((a) => a.data as any);
}

beforeEach(() => {
  resetIdentityCache();
  counting = new CountingFirestore();
  mockDbHolder.db = counting.asDb();
  seed();
  delete process.env.SUPA_SURFACES;
});

describe('PATCH /api/workflows roster sync', () => {
  it('reassigning a step to a new person restamps the roster union on ALL steps', async () => {
    const res = await workflowsPATCH(makePatch(0, { assigneeIds: ['member-new'] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.step.assigneeId).toBe('member-new');
    // member-a holds no step anymore and leaves the roster; member-b stays.
    expect(rosterOf('step-0')).toEqual(['member-new', 'member-b']);
    expect(rosterOf('step-1')).toEqual(['member-new', 'member-b']);
    expect(audits()).toHaveLength(1);
    expect(audits()[0].rosterSynced).toBe(true);
  });

  it('reassigning to someone already in the roster does not duplicate them', async () => {
    const res = await workflowsPATCH(makePatch(0, { assigneeIds: ['member-b'] }));
    expect(res.status).toBe(200);
    expect(rosterOf('step-0')).toEqual(['member-b']);
    expect(rosterOf('step-1')).toEqual(['member-b']);
    expect(audits()[0].rosterSynced).toBe(true);
  });

  it('a status-only update does not rewrite rosters and runs no roster query', async () => {
    const res = await workflowsPATCH(makePatch(0, { status: 'in_progress' }));
    expect(res.status).toBe(200);
    expect(rosterOf('step-0')).toEqual(['member-a', 'member-b']);
    expect(rosterOf('step-1')).toEqual(['member-a', 'member-b']);
    // Only the step-lookup query ran; the roster recompute adds a second
    // tasks query when (and only when) an assignee set changes.
    expect(counting.queryCallCount('tasks')).toBe(1);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).not.toHaveProperty('rosterSynced');
  });

  it('multi-assignee steps contribute all their assignees to the roster', async () => {
    counting.seed('tasks', 'step-2', {
      workflowId: WF,
      sequenceIndex: 2,
      title: 'Step 2',
      status: 'pending',
      assigneeId: 'member-b',
      assigneeIds: ['member-b', 'member-c'],
      workflowParticipantIds: ['member-a', 'member-b'],
    });
    const res = await workflowsPATCH(makePatch(0, { assigneeIds: ['member-new'] }));
    expect(res.status).toBe(200);
    const expected = ['member-new', 'member-b', 'member-c'];
    expect(rosterOf('step-0')).toEqual(expected);
    expect(rosterOf('step-1')).toEqual(expected);
    expect(rosterOf('step-2')).toEqual(expected);
  });

  it('a multi-assignee reassignment contributes every new assignee', async () => {
    const res = await workflowsPATCH(makePatch(1, { assigneeIds: ['member-new', 'member-c'] }));
    expect(res.status).toBe(200);
    const expected = ['member-a', 'member-new', 'member-c'];
    expect(rosterOf('step-0')).toEqual(expected);
    expect(rosterOf('step-1')).toEqual(expected);
    expect((counting.read('tasks', 'step-1') as any).assigneeId).toBe('member-new');
  });
});
