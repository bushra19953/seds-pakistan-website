/**
 * @jest-environment node
 *
 * Review-queue inclusion for the named reviewer: GET
 * /api/tasks/review-queue runs the REAL canValidateTask, so a task
 * whose only grant path is the reviewer door (the stamped reviewerId
 * / reviewerIds uid fields) lands in the named reviewer's queue with
 * via: 'reviewer'. A task whose description names the caller but
 * carries NO fields does NOT appear: text grants nothing. The Supa
 * seam is mocked to return the candidate snapshot; the Firestore
 * fallback user lookups and the whole hierarchy walk run against
 * the in-memory store.
 */
const mockDbHolder: { db: unknown } = { db: null };
const seamTasksHolder: { docs: Array<{ id: string; data: () => any }> } = { docs: [] };

const CALLER = 'PB6yfB2UsngMvi1slAAHZeT7kOh1'; // named reviewer (Bushra shape)
const SUBMITTER = 'submitter-1';

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

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  admin: { firestore: { FieldValue: { serverTimestamp: () => 'ts' } } },
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({
    authenticated: true,
    user: { userId: CALLER, uid: CALLER, role: 'member' },
  }),
}));

jest.mock('@/lib/supa/seam-tasks-lists', () => ({
  listTasksViaSeam: async () => ({ docs: seamTasksHolder.docs }),
  getUserDocViaSeam: async () => null,
}));

import { FakeFirestore } from '@/lib/__tests__/helpers/fake-firestore';
import { GET } from '../review-queue/route';

const HASSAN_DESCRIPTION =
  '72-Hour Crucible task ROV-001. Pod: 3A. Candidate: Hassan Ali. ' +
  'Reviewer: Bushra Rahman (Lead Coder / Autonomy Lead) / Ahmed Ali Kamran (Chapter Vice President). ' +
  'Faculty patron: Prof. Dr. Najam Abbas Naqvi. Deliverable: a Docker image.';

let fake: FakeFirestore;

function taskDoc(id: string, data: any) {
  return { id, data: () => data };
}

beforeEach(() => {
  fake = new FakeFirestore();
  mockDbHolder.db = fake.asDb();
  fake.seed('users', SUBMITTER, { displayName: 'Hassan Ali', role: 'member_basic' });
  fake.seed('users', CALLER, { displayName: 'Bushra Rahman', role: 'platform_developer' });
  fake.seed('roles', CALLER, { role: 'member', additionalRoles: [] });
  seamTasksHolder.docs = [];
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

function req(): any {
  return { url: 'http://localhost/api/tasks/review-queue', headers: { get: () => null } };
}

it('workflow step stamped with reviewerIds (lead + co) appears with via reviewer', async () => {
  seamTasksHolder.docs = [
    taskDoc('task-hassan', {
      title: 'Containerized ROS 2 Gazebo Rover Simulation',
      status: 'submitted-for-review',
      submittedBy: SUBMITTER,
      assigneeId: SUBMITTER,
      assignerId: 'assigner-1',
      // Post-stamp shape: the description still names the reviewers
      // for humans, but the uid fields are what grant the door.
      description: HASSAN_DESCRIPTION,
      reviewerId: CALLER,
      reviewerIds: [CALLER, 'IPhLvckHJQgj5cZxr5nQESauH762'],
      points: 100,
      submittedAt: new Date('2026-10-28T04:29:00Z'),
    }),
  ];
  const res: any = await GET(req());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.tasks).toHaveLength(1);
  expect(body.tasks[0]).toMatchObject({
    id: 'task-hassan',
    via: 'reviewer',
    submitterUid: SUBMITTER,
    submitterName: 'Hassan Ali',
  });
});

it('PIN: description names the caller but NO fields are stamped: task does not appear', async () => {
  seamTasksHolder.docs = [
    taskDoc('task-hassan-unstamped', {
      title: 'Containerized ROS 2 Gazebo Rover Simulation',
      status: 'submitted-for-review',
      submittedBy: SUBMITTER,
      assigneeId: SUBMITTER,
      assignerId: 'assigner-1',
      description: HASSAN_DESCRIPTION,
      points: 100,
      submittedAt: new Date('2026-10-28T04:29:00Z'),
    }),
  ];
  const res: any = await GET(req());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.tasks).toEqual([]);
});

it('reviewerId-stamped task appears with via reviewer', async () => {
  seamTasksHolder.docs = [
    taskDoc('task-stamped', {
      title: 'Stamped task',
      status: 'submitted-for-review',
      submittedBy: SUBMITTER,
      assigneeId: SUBMITTER,
      assignerId: 'assigner-1',
      reviewerId: CALLER,
      submittedAt: new Date('2026-10-28T05:00:00Z'),
    }),
  ];
  const res: any = await GET(req());
  const body = await res.json();
  expect(body.tasks.map((t: any) => [t.id, t.via])).toEqual([['task-stamped', 'reviewer']]);
});

it('a task naming someone else does not appear in this caller queue', async () => {
  seamTasksHolder.docs = [
    taskDoc('task-other', {
      title: 'Not yours',
      status: 'submitted-for-review',
      submittedBy: SUBMITTER,
      assigneeId: SUBMITTER,
      assignerId: 'assigner-1',
      reviewerId: 'someone-else',
      submittedAt: new Date('2026-10-28T05:00:00Z'),
    }),
  ];
  const res: any = await GET(req());
  const body = await res.json();
  expect(body.tasks).toEqual([]);
});
