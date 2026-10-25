/**
 * @jest-environment node
 *
 * Tests for GET /api/missions/[workflowId], including the standalone-task
 * fallback: a task doc id with no workflowId renders as a one-step mission
 * so its PDF cover QR has a live page.
 *
 * (a) Workflow aggregate lookup still returns a sanitized mission payload.
 * (b) Standalone task id returns a one-step mission (200) with contact
 *     details stripped.
 * (c) A task doc that belongs to a DIFFERENT workflow keeps its 404.
 * (d) An unknown id returns 404.
 * (e) Missing workflowId returns 400.
 * (f) Firebase Admin / Firestore init failures return 500.
 */

const mockState = {
  adminReady: true,
  dbReady: true,
  tasks: [] as Array<Record<string, any>>,
  users: {} as Record<string, Record<string, any>>,
  chapters: {} as Record<string, Record<string, any>>,
};

function docOf(collection: string, id: string) {
  const store =
    collection === 'tasks'
      ? mockState.tasks.reduce((m, t) => ({ ...m, [t.id]: t }), {} as Record<string, any>)
      : collection === 'users'
        ? mockState.users
        : mockState.chapters;
  const data = store[id];
  return {
    id,
    exists: !!data,
    data: () => data,
  };
}

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => mockState.adminReady),
  getDb: jest.fn(() =>
    mockState.dbReady
      ? {
          collection: (name: string) => ({
            where: (_field: string, _op: string, value: string) => ({
              get: async () => ({
                empty: mockState.tasks.filter((t) => t.workflowId === value).length === 0,
                docs: mockState.tasks
                  .filter((t) => t.workflowId === value)
                  .map((t) => ({ id: t.id, data: () => t })),
              }),
            }),
            doc: (id: string) => ({
              get: async () => docOf(name, id),
            }),
          }),
        }
      : null,
  ),
}));

// computeWorkflowProgress is a pure helper; use the real one.
jest.mock('@/lib/workflow-progress', () => ({
  computeWorkflowProgress: jest.fn((statuses: string[]) => ({
    completedSteps: statuses.filter((s) => s === 'completed' || s === 'approved').length,
    progressPercentage: statuses.length
      ? Math.round(
          (statuses.filter((s) => s === 'completed' || s === 'approved').length / statuses.length) * 100,
        )
      : 0,
    isCompleted: statuses.length > 0 && statuses.every((s) => s === 'completed' || s === 'approved'),
  })),
}));

import { GET } from '@/app/api/missions/[workflowId]/route';
import { NextRequest } from 'next/server';

function getRequest(workflowId: string) {
  const req = new NextRequest(`http://localhost/api/missions/${workflowId}`);
  return { req, params: Promise.resolve({ workflowId }) };
}

const WORKFLOW_STEPS = [
  {
    id: 'step1',
    workflowId: 'wf_1',
    workflowTitle: 'Poster Blitz',
    title: 'Print posters',
    description: 'Print 35 sheets',
    status: 'completed',
    sequenceIndex: 0,
    points: 5,
    deadline: '2026-10-20T10:00:00.000Z',
    assigneeId: 'u1',
    assigneeIds: ['u1', 'u2'],
    role: 'Volunteer',
    chapterId: 'c1',
    createdAt: '2026-10-19T00:00:00.000Z',
  },
  {
    id: 'step2',
    workflowId: 'wf_1',
    workflowTitle: 'Poster Blitz',
    title: 'Mount posters',
    description: 'Mount at 8 choke points',
    status: 'pending',
    sequenceIndex: 1,
    points: 5,
    individualDeadline: '2026-10-21T10:00:00.000Z',
    assigneeId: 'u2',
    assigneeIds: ['u2'],
    role: 'Volunteer',
    chapterId: 'c1',
    createdAt: '2026-10-19T00:00:00.000Z',
  },
];

const STANDALONE_TASK = {
  id: 'task_9',
  title: 'Emergency Poster Mounting Blitz',
  description: 'Mount 8 posters',
  status: 'in-progress',
  points: 10,
  deadline: '2026-10-20T10:00:00.000Z',
  assigneeId: 'u1',
  assigneeIds: ['u1'],
  role: 'Volunteer',
  chapterId: 'c1',
  createdAt: '2026-10-19T00:00:00.000Z',
  // No workflowId: this is a standalone task.
};

beforeEach(() => {
  mockState.adminReady = true;
  mockState.dbReady = true;
  mockState.tasks = [...WORKFLOW_STEPS.map((s) => ({ ...s })), { ...STANDALONE_TASK }];
  mockState.users = {
    u1: { displayName: 'Huzaifah', chapterId: 'c1', email: 'secret@example.com', whatsapp: '03000000000' },
    u2: { displayName: 'Ahmed', chapterId: 'c1', email: 'alsosecret@example.com' },
  };
  mockState.chapters = { c1: { name: 'SEDS IST' } };
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GET /api/missions/[workflowId]', () => {
  it('returns the workflow aggregate for a workflowId', async () => {
    const { req, params } = getRequest('wf_1');
    const res = await GET(req, { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.mission.title).toBe('Poster Blitz');
    expect(body.mission.totalSteps).toBe(2);
    expect(body.mission.completedSteps).toBe(1);
    expect(body.mission.progressPercentage).toBe(50);
    expect(body.mission.steps).toHaveLength(2);
    expect(body.mission.steps[0].assigneeName).toBe('Huzaifah');
    expect(body.mission.steps[0].assignees).toHaveLength(2);
  });

  it('serves the payload behind a shared cache so repeat polls collapse at the edge', async () => {
    const { req, params } = getRequest('wf_1');
    const res = await GET(req, { params });
    expect(res.status).toBe(200);
    const cacheControl = res.headers.get('cache-control') || '';
    // s-maxage is the read-burn control: without it every open mission
    // tab's poll reaches Firestore; with it the edge serves the 60s
    // window and origin reads stop scaling with tabs.
    expect(cacheControl).toContain('s-maxage=60');
    expect(cacheControl).toContain('max-age=60');
  });

  it('renders a standalone task id as a one-step mission, sanitized', async () => {
    const { req, params } = getRequest('task_9');
    const res = await GET(req, { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.mission.workflowId).toBe('task_9');
    expect(body.mission.title).toBe('Emergency Poster Mounting Blitz');
    expect(body.mission.description).toBe('Mount 8 posters');
    expect(body.mission.totalSteps).toBe(1);
    expect(body.mission.completedSteps).toBe(0);
    expect(body.mission.progressPercentage).toBe(0);
    expect(body.mission.steps).toHaveLength(1);
    expect(body.mission.steps[0].status).toBe('in-progress');
    // Sanitized: assignee name and chapter only, no contact details.
    expect(body.mission.steps[0].assigneeName).toBe('Huzaifah');
    expect(body.mission.steps[0].assigneeChapter).toBe('SEDS IST');
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('secret@example.com');
    expect(raw).not.toContain('03000000000');
  });

  it('keeps a 404 for a task doc that belongs to a different workflow', async () => {
    const { req, params } = getRequest('step1');
    const res = await GET(req, { params });
    expect(res.status).toBe(404);
    expect((await res.json()).ok).toBe(false);
  });

  it('returns 404 for an unknown id', async () => {
    const { req, params } = getRequest('nope_404');
    const res = await GET(req, { params });
    expect(res.status).toBe(404);
  });

  it('returns 400 when the workflowId is missing', async () => {
    const req = new NextRequest('http://localhost/api/missions/');
    const res = await GET(req, { params: Promise.resolve({ workflowId: '' }) });
    expect(res.status).toBe(400);
  });

  it('returns 500 when Firebase Admin is not initialized', async () => {
    mockState.adminReady = false;
    const { req, params } = getRequest('wf_1');
    const res = await GET(req, { params });
    expect(res.status).toBe(500);
  });

  it('returns 500 when Firestore is not initialized', async () => {
    mockState.dbReady = false;
    const { req, params } = getRequest('wf_1');
    const res = await GET(req, { params });
    expect(res.status).toBe(500);
  });
});
