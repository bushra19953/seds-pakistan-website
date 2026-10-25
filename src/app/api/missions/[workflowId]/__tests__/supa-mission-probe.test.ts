/**
 * @jest-environment node
 *
 * [MIGRATION-PROBE wf-1] — adapter-consultation probes for
 * GET /api/missions/[workflowId] (feat/supa-wf-1).
 *
 * WHY THIS FILE CANNOT LOAD ON THE BASE TREE: jest.mock('@/lib/supa')
 * cannot register while src/lib/supa does not exist in the tree (the
 * moduleNameMapper resolves the name before any factory runs). That
 * load failure is the expected, mapped state until the adapter is in
 * the tree AND feat/supa-wf-1 routes mission reads through it. Once
 * both hold, every test here must pass:
 *   flag ON + healthy adapter  -> adapter consulted for 'tasks',
 *                                 output byte-identical to Firestore;
 *   flag ON + empty supa store -> 404 comes from the supa path;
 *   flag ON + adapter throws   -> Firestore fallback, identical output;
 *   flag OFF                   -> adapter never consulted.
 *
 * The mock implements the LANDED adapter API (feat/supa-adapter
 * @ 85e657f + f7defc3) via the shared fixture builder.
 */

const mockFsState = {
  tasks: [] as Array<Record<string, any>>,
  users: {} as Record<string, Record<string, any>>,
  chapters: {} as Record<string, Record<string, any>>,
};

const mockSupaStateHolder = { current: null as any };
jest.mock('@/lib/supa', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildMockSupaModule } = require('@/lib/__tests__/supa-wf-fixtures');
  return buildMockSupaModule(() => mockSupaStateHolder.current);
});

function docOf(collection: string, id: string) {
  const store =
    collection === 'tasks'
      ? mockFsState.tasks.reduce((m, t) => ({ ...m, [t.id]: t }), {} as Record<string, any>)
      : collection === 'users'
        ? mockFsState.users
        : mockFsState.chapters;
  const data = store[id];
  return { id, exists: !!data, data: () => data };
}

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() => ({
    collection: (name: string) => ({
      where: (_field: string, _op: string, value: string) => ({
        get: async () => ({
          empty: mockFsState.tasks.filter((t) => t.workflowId === value).length === 0,
          docs: mockFsState.tasks
            .filter((t) => t.workflowId === value)
            .map((t) => ({ id: t.id, data: () => t })),
        }),
      }),
      doc: (id: string) => ({ get: async () => docOf(name, id) }),
    }),
  })),
}));

import { GET } from '@/app/api/missions/[workflowId]/route';
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

async function getMission(workflowId: string) {
  const req = new NextRequest(`http://localhost/api/missions/${workflowId}`);
  const res = await GET(req, { params: Promise.resolve({ workflowId }) });
  return { res, body: await res.json() };
}

let baselineJson = '';

beforeEach(async () => {
  mockSupaStateHolder.current = freshMockSupaState();
  mockSupaStateHolder.current.store.tasks = jsonbSteps();
  mockSupaStateHolder.current.store.users = jsonbUsers();
  mockSupaStateHolder.current.store.chapters = jsonbChapters();
  mockFsState.tasks = firestoreSteps();
  mockFsState.users = firestoreUsers();
  mockFsState.chapters = firestoreChapters();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  mockSupaStateHolder.current.surfaces = undefined;
  const { body } = await getMission(WF_ID);
  baselineJson = JSON.stringify(body);
  mockSupaStateHolder.current.calls = [];
});

afterEach(() => jest.restoreAllMocks());

describe('[MIGRATION-PROBE wf-1] mission route adapter consultation', () => {
  it('flag OFF: adapter never consulted, Firestore output', async () => {
    const { res, body } = await getMission(WF_ID);
    expect(res.status).toBe(200);
    expect(JSON.stringify(body)).toBe(baselineJson);
    expect(mockSupaStateHolder.current.calls).toHaveLength(0);
  });

  it('flag ON + healthy adapter: tasks read via adapter, output byte-identical to Firestore', async () => {
    mockSupaStateHolder.current.surfaces = 'workflows';
    const { res, body } = await getMission(WF_ID);
    expect(res.status).toBe(200);
    expect(JSON.stringify(body)).toBe(baselineJson);
    const taskReads = mockSupaStateHolder.current.calls.filter(
      (c: any) => c.collection === 'tasks',
    );
    expect(taskReads.length).toBeGreaterThan(0);
  });

  it('flag ON + adapter returns nothing for the workflow: 404 from the supa path', async () => {
    mockSupaStateHolder.current.surfaces = 'workflows';
    mockSupaStateHolder.current.store.tasks = [];
    const { res } = await getMission(WF_ID);
    expect(res.status).toBe(404);
    expect(mockSupaStateHolder.current.calls.length).toBeGreaterThan(0);
  });

  it('flag ON + adapter throws SupaAdapterError: Firestore fallback, identical output', async () => {
    mockSupaStateHolder.current.surfaces = 'workflows';
    mockSupaStateHolder.current.adapterMode = 'throw';
    const { res, body } = await getMission(WF_ID);
    expect(res.status).toBe(200);
    expect(JSON.stringify(body)).toBe(baselineJson);
    expect(mockSupaStateHolder.current.calls.length).toBeGreaterThan(0);
  });

  it('flag ON + client null: Firestore fallback, identical output, no adapter reads', async () => {
    mockSupaStateHolder.current.surfaces = 'workflows';
    mockSupaStateHolder.current.clientNull = true;
    const { res, body } = await getMission(WF_ID);
    expect(res.status).toBe(200);
    expect(JSON.stringify(body)).toBe(baselineJson);
    expect(mockSupaStateHolder.current.calls).toHaveLength(0);
  });
});
