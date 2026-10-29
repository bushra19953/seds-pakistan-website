/**
 * @jest-environment node
 *
 * Review-queue submission payload: GET /api/tasks/review-queue copies
 * the submission fields from the task doc onto each queue item —
 * description, report, resourceLinks, workflowTitle (strings),
 * hoursWorked (number), and deliverableFiles filtered to entries
 * with a string downloadUrl and whitelisted to the client contract
 * keys. Legacy docs without any of those fields must not crash and
 * must return items where those fields are absent.
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

it('copies submission payload fields and whitelists/filters deliverableFiles', async () => {
  seamTasksHolder.docs = [
    taskDoc('task-payload', {
      title: 'Containerized ROS 2 Gazebo Rover Simulation',
      status: 'submitted-for-review',
      submittedBy: SUBMITTER,
      assigneeId: SUBMITTER,
      assignerId: 'assigner-1',
      reviewerId: CALLER,
      points: 150,
      submittedAt: new Date('2026-10-28T10:00:00Z'),
      report: 'Field report text',
      deliverableFiles: [
        {
          fileName: 'a.pdf',
          downloadUrl: 'https://example.com/a.pdf',
          sizeBytes: 123,
          contentType: 'application/pdf',
          driveFileId: 'drv-1',
          extraKey: 'drop-me',
        },
        { fileName: 'no-url' },
      ],
      resourceLinks: 'https://example.com/ref',
      hoursWorked: 4,
      description: 'Do the thing',
      workflowTitle: 'Rover Pod',
    }),
  ];

  const res: any = await GET(req());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.tasks).toHaveLength(1);

  const item = body.tasks[0];
  expect(item.report).toBe('Field report text');
  expect(item.resourceLinks).toBe('https://example.com/ref');
  expect(item.hoursWorked).toBe(4);
  expect(item.description).toBe('Do the thing');
  expect(item.workflowTitle).toBe('Rover Pod');

  expect(item.deliverableFiles).toHaveLength(1);
  expect(item.deliverableFiles[0].downloadUrl).toBe('https://example.com/a.pdf');
  expect(item.deliverableFiles[0]).not.toHaveProperty('extraKey');
  // driveFileId is part of the optional client contract — only
  // extraKey absence is asserted, not driveFileId.
});

it('legacy task without submission fields returns item with report/deliverableFiles undefined', async () => {
  seamTasksHolder.docs = [
    taskDoc('task-legacy', {
      title: 'Legacy task',
      status: 'submitted-for-review',
      submittedBy: SUBMITTER,
      assigneeId: SUBMITTER,
      assignerId: 'assigner-1',
      reviewerId: CALLER,
      submittedAt: new Date('2026-10-28T05:00:00Z'),
    }),
  ];

  const res: any = await GET(req());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.tasks).toHaveLength(1);
  const item = body.tasks[0];
  expect(item.report).toBeUndefined();
  expect(item.deliverableFiles).toBeUndefined();
});
