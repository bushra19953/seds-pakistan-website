/**
 * @jest-environment node
 *
 * [MIGRATION-PROBE wf-5] — adapter-consultation probes for
 * GET /api/workflows?workflowId= (the PDF export data source,
 * feat/supa-wf-5).
 *
 * Like supa-mission-probe.test.ts, this file CANNOT LOAD on a tree
 * without src/lib/supa (jest.mock cannot register for an unmapped
 * module) — that is the expected, mapped state until the adapter is in
 * the tree AND feat/supa-wf-5 routes the detail reads through it.
 * Once both hold, every test here must pass with output byte-identical
 * to the Firestore baseline pinned in
 * supa-pdf-export-data.contract.test.ts.
 */

const mockState = {
  viewer: { uid: 'u1', role: 'member' } as Record<string, any>,
  tasks: [] as Array<Record<string, any>>,
  users: {} as Record<string, Record<string, any>>,
  chapters: {} as Record<string, Record<string, any>>,
  roles: {} as Record<string, Record<string, any>>,
  workflowMembers: {} as Record<string, Record<string, any>>,
};

const mockSupaStateHolder = { current: null as any };
jest.mock('@/lib/supa', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildMockSupaModule } = require('@/lib/__tests__/supa-wf-fixtures');
  return buildMockSupaModule(() => mockSupaStateHolder.current);
});

function storeFor(name: string): Record<string, any> {
  switch (name) {
    case 'users': return mockState.users;
    case 'chapters': return mockState.chapters;
    case 'roles': return mockState.roles;
    case 'workflow_members': return mockState.workflowMembers;
    default: return {};
  }
}

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  admin: {
    auth: () => ({
      verifyIdToken: jest.fn(async () => ({ ...mockState.viewer })),
    }),
  },
  getDb: jest.fn(() => ({
    collection: (name: string) => ({
      where: (field: string, _op: string, value: any) => ({
        get: async () => {
          const docs =
            name === 'tasks' ? mockState.tasks.filter((t) => t[field] === value) : [];
          return { empty: docs.length === 0, docs: docs.map((t) => ({ id: t.id, data: () => t })) };
        },
        orderBy: () => ({ get: async () => ({ empty: true, docs: [] }) }),
      }),
      doc: (id: string) => ({
        get: async () => {
          if (name === 'tasks') {
            const data = mockState.tasks.find((t) => t.id === id);
            return { id, exists: !!data, data: () => data };
          }
          const data = storeFor(name)[id];
          return { id, exists: !!data, data: () => data };
        },
      }),
    }),
  })),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => false),
}));
jest.mock('@/lib/workflow-utils', () => ({
  calculateWorkflowDeadlines: jest.fn(() => []),
}));
jest.mock('@/lib/server/user-status', () => ({
  validateUserStatus: jest.fn(async () => ({ isValid: true })),
}));
jest.mock('@/lib/mailer', () => ({
  sendEmailNotification: jest.fn(async () => undefined),
}));

import { GET } from '@/app/api/workflows/route';
import { NextRequest } from 'next/server';
import {
  WF_ID,
  firestoreSteps,
  firestoreUsers,
  firestoreChapters,
  jsonbSteps,
  jsonbUsers,
  jsonbChapters,
  freshMockSupaState,
} from '@/lib/__tests__/supa-wf-fixtures';

async function getDetail() {
  const req = new NextRequest(`http://localhost/api/workflows?workflowId=${WF_ID}`, {
    headers: { Authorization: 'Bearer test-token' },
  });
  const res = await GET(req);
  return { res, body: await res.json() };
}

let baselineJson = '';

beforeEach(async () => {
  delete process.env.FIREBASE_PROJECT_ID;
  delete process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  mockSupaStateHolder.current = freshMockSupaState();
  mockSupaStateHolder.current.store.tasks = jsonbSteps();
  mockSupaStateHolder.current.store.users = jsonbUsers();
  mockSupaStateHolder.current.store.chapters = jsonbChapters();
  mockState.tasks = firestoreSteps();
  mockState.users = firestoreUsers();
  mockState.chapters = firestoreChapters();
  mockState.roles = { u1: { role: 'member' } };
  mockState.workflowMembers = {};
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  const { body } = await getDetail();
  baselineJson = JSON.stringify(body);
  mockSupaStateHolder.current.calls = [];
});

afterEach(() => jest.restoreAllMocks());

describe('[MIGRATION-PROBE wf-5] workflows detail adapter consultation', () => {
  it('flag OFF: adapter never consulted, Firestore output', async () => {
    const { body } = await getDetail();
    expect(JSON.stringify(body)).toBe(baselineJson);
    expect(mockSupaStateHolder.current.calls).toHaveLength(0);
  });

  it('flag ON + healthy adapter: tasks read via adapter, output byte-identical', async () => {
    mockSupaStateHolder.current.surfaces = 'workflows';
    const { res, body } = await getDetail();
    expect(res.status).toBe(200);
    expect(JSON.stringify(body)).toBe(baselineJson);
    const taskReads = mockSupaStateHolder.current.calls.filter(
      (c: any) => c.collection === 'tasks',
    );
    expect(taskReads.length).toBeGreaterThan(0);
  });

  it('flag ON + adapter throws: Firestore fallback, identical output', async () => {
    mockSupaStateHolder.current.surfaces = 'workflows';
    mockSupaStateHolder.current.adapterMode = 'throw';
    const { body } = await getDetail();
    expect(JSON.stringify(body)).toBe(baselineJson);
    expect(mockSupaStateHolder.current.calls.length).toBeGreaterThan(0);
  });

  it('flag ON + client null: Firestore fallback, identical output, no adapter reads', async () => {
    mockSupaStateHolder.current.surfaces = 'workflows';
    mockSupaStateHolder.current.clientNull = true;
    const { body } = await getDetail();
    expect(JSON.stringify(body)).toBe(baselineJson);
    expect(mockSupaStateHolder.current.calls).toHaveLength(0);
  });
});
