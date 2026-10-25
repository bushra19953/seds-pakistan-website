/**
 * @jest-environment node
 *
 * CONTRACT 1 — Mission GET payload (feat/supa-wf-1 surface:
 * GET /api/missions/[workflowId]) and CONTRACT 4 — flag-state behavior
 * for the same route.
 *
 * Written against the CURRENT tree (Firestore-only route, real
 * computeWorkflowProgress — deliberately NOT mocked, unlike the older
 * route.test.ts whose progress mock encodes outdated 'approved'
 * semantics). Re-run unchanged against feat/supa-wf-1 when it lands:
 * every test here must still pass (byte-identical payloads).
 * Adapter-consultation probes live in supa-mission-probe.test.ts — that
 * file cannot load on a tree without src/lib/supa, BY DESIGN, and must
 * turn green once the route consults the adapter behind
 * useSupa('workflows').
 *
 * The '@/lib/supa' mock implements the LANDED adapter API
 * (feat/supa-adapter @ 85e657f + f7defc3): useSupa / getSupaClient /
 * getSupaAdapter, SupaAdapterError / SupaUnavailableError.
 */

const mockFsState = {
  adminReady: true,
  dbReady: true,
  tasks: [] as Array<Record<string, any>>,
  users: {} as Record<string, Record<string, any>>,
  chapters: {} as Record<string, Record<string, any>>,
};

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
  ensureAdminInitialized: jest.fn(() => mockFsState.adminReady),
  getDb: jest.fn(() =>
    mockFsState.dbReady
      ? {
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
        }
      : null,
  ),
}));

// NOTE: '@/lib/workflow-progress' is intentionally NOT mocked — the real
// canonical semantics are part of the contract being pinned.

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
  FakeTimestamp,
} from '@/lib/__tests__/supa-wf-fixtures';

async function getMission(workflowId: string) {
  const req = new NextRequest(`http://localhost/api/missions/${workflowId}`);
  const res = await GET(req, { params: Promise.resolve({ workflowId }) });
  const body = await res.json();
  return { res, body };
}

function seedFirestore(shape: 'firestore' | 'jsonb') {
  mockFsState.tasks =
    shape === 'firestore' ? firestoreSteps() : jsonbSteps();
  mockFsState.users = shape === 'firestore' ? firestoreUsers() : jsonbUsers();
  mockFsState.chapters =
    shape === 'firestore' ? firestoreChapters() : jsonbChapters();
}

let baselineJson = '';

const ENV_KEYS = ['SUPA_SURFACES', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  mockFsState.adminReady = true;
  mockFsState.dbReady = true;
  seedFirestore('firestore');
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  jest.restoreAllMocks();
});

describe('contract 1: mission GET payload shape', () => {
  it('returns the full mission payload with exact key sets', async () => {
    const { res, body } = await getMission(WF_ID);
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Object.keys(body.mission).sort()).toEqual(
      [
        'workflowId', 'title', 'description', 'chapterName', 'totalSteps',
        'completedSteps', 'progressPercentage', 'isCompleted', 'createdAt',
        'deadline', 'steps',
      ].sort(),
    );
    const m = body.mission;
    expect(m.workflowId).toBe(WF_ID);
    expect(m.title).toBe('Poster Blitz');
    // description comes from guidance.description on the first doc
    expect(m.description).toBe('Strategic intent text');
    expect(m.chapterName).toBe('SEDS IST');
    expect(m.totalSteps).toBe(3);
    expect(m.createdAt).toBe('2026-10-17T08:00:00.000Z');
    expect(m.deadline).toBe('2026-10-20T10:00:00.000Z');
    expect(m.steps).toHaveLength(3);
    expect(Object.keys(m.steps[0]).sort()).toEqual(
      [
        'title', 'description', 'status', 'sequenceIndex', 'points',
        'individualDeadline', 'completedAt', 'assigneeName',
        'assigneeChapter', 'assignees', 'role',
      ].sort(),
    );
  });

  it('reflects steps sorted by sequenceIndex with assignees and chapters resolved', async () => {
    const { body } = await getMission(WF_ID);
    const [s1, s2, s3] = body.mission.steps;
    expect([s1.title, s2.title, s3.title]).toEqual(['Print posters', 'Mount posters', 'Report back']);
    expect(s1.assigneeName).toBe('Huzaifah Shujjah');
    expect(s1.assigneeChapter).toBe('SEDS IST');
    expect(s1.assignees).toEqual([
      { name: 'Huzaifah Shujjah', chapterName: 'SEDS IST' },
      { name: 'Ahmed Kamran', chapterName: 'SEDS IST' },
    ]);
    expect(s2.assignees).toEqual([{ name: 'Ahmed Kamran', chapterName: 'SEDS IST' }]);
    expect(s1.individualDeadline).toBe('2026-10-19T10:00:00.000Z');
    expect(s1.completedAt).toBe('2026-10-18T09:30:00.000Z');
    expect(s2.completedAt).toBeNull();
  });

  it('reflects the per-status mix faithfully through the real progress helper', async () => {
    // Fixture mix: completed + submitted-for-review + changes-requested
    const { body } = await getMission(WF_ID);
    expect(body.mission.steps.map((s: any) => s.status)).toEqual([
      'completed', 'submitted-for-review', 'changes-requested',
    ]);
    expect(body.mission.completedSteps).toBe(2); // completed + submitted-for-review
    expect(body.mission.progressPercentage).toBe(67);
    expect(body.mission.isCompleted).toBe(false); // not every step is 'completed'
  });

  it('all-completed mix yields isCompleted=true at 100%', async () => {
    mockFsState.tasks = firestoreSteps().map((t) => ({ ...t, status: 'completed' }));
    const { body } = await getMission(WF_ID);
    expect(body.mission.completedSteps).toBe(3);
    expect(body.mission.progressPercentage).toBe(100);
    expect(body.mission.isCompleted).toBe(true);
  });

  it("PIN: an 'approved' step does not advance mission progress on the current tree", async () => {
    // Current computeWorkflowProgress semantics; expect this to change
    // only with fix/tasks-status-semantics — update then, not before.
    mockFsState.tasks = firestoreSteps().map((t) => ({ ...t, status: 'approved' }));
    const { body } = await getMission(WF_ID);
    expect(body.mission.completedSteps).toBe(0);
    expect(body.mission.progressPercentage).toBe(0);
    expect(body.mission.isCompleted).toBe(false);
  });

  it('sanitizes: no contact fields anywhere in the payload', async () => {
    const { body } = await getMission(WF_ID);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('huzaifah@example.com');
    expect(raw).not.toContain('ahmed@example.com');
    expect(raw).not.toContain('03001111111');
    expect(raw).not.toContain('03002222222');
  });

  it('Cache-Control carries s-maxage=60 (the page poller read-burn control)', async () => {
    const { res } = await getMission(WF_ID);
    const cc = res.headers.get('cache-control') || '';
    expect(cc).toContain('s-maxage=60');
    expect(cc).toBe('public, max-age=60, s-maxage=60, stale-while-revalidate=300');
  });

  it('unknown workflowId -> 404 (the mission page poller stops on this)', async () => {
    const { res, body } = await getMission('wf_does_not_exist');
    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: 'Mission not found' });
  });

  it('a task id belonging to a different workflow keeps its 404', async () => {
    const { res } = await getMission('step1');
    expect(res.status).toBe(404);
  });

  it('byte-identical payload: Firestore Timestamp docs vs ISO-string (jsonb-shaped) docs', async () => {
    const fsResult = await getMission(WF_ID);
    const fsJson = JSON.stringify(fsResult.body);
    // Sanity: fixture really uses Timestamp objects on the Firestore side.
    expect(firestoreSteps()[0].deadline).toBeInstanceOf(FakeTimestamp);

    seedFirestore('jsonb');
    const jsonbResult = await getMission(WF_ID);
    expect(jsonbResult.res.status).toBe(200);
    expect(JSON.stringify(jsonbResult.body)).toBe(fsJson);
    baselineJson = fsJson;
  });
});

describe('contract 4: flag-state behavior for the mission route (env-driven, real flag semantics)', () => {
  // These tests drive the REAL flag inputs (SUPA_SURFACES / SUPABASE_*)
  // instead of mocking '@/lib/supa': a jest.mock for that module cannot
  // even register on a tree where src/lib/supa does not exist yet.
  // Adapter-consultation assertions live in supa-mission-probe.test.ts.
  beforeEach(async () => {
    delete process.env.SUPA_SURFACES;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    seedFirestore('firestore');
    const { body } = await getMission(WF_ID);
    baselineJson = JSON.stringify(body);
  });

  it('flag OFF (SUPA_SURFACES unset): Firestore path, baseline output', async () => {
    const { res, body } = await getMission(WF_ID);
    expect(res.status).toBe(200);
    expect(JSON.stringify(body)).toBe(baselineJson);
  });

  it("flag ON for a DIFFERENT surface only ('announcements,directory'): 'workflows' unaffected", async () => {
    process.env.SUPA_SURFACES = 'announcements,directory';
    const { body } = await getMission(WF_ID);
    expect(JSON.stringify(body)).toBe(baselineJson);
  });

  it('flag ON + no Supabase credentials (getSupaClient() must be null): Firestore fallback, identical output', async () => {
    process.env.SUPA_SURFACES = 'workflows';
    // SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY deleted in beforeEach.
    const { res, body } = await getMission(WF_ID);
    expect(res.status).toBe(200);
    expect(JSON.stringify(body)).toBe(baselineJson);
  });

  it('flag ON + unreachable Supabase (adapter errors): Firestore fallback, identical output', async () => {
    process.env.SUPA_SURFACES = 'workflows';
    process.env.SUPABASE_URL = 'https://localhost:9';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-not-real';
    const { res, body } = await getMission(WF_ID);
    expect(res.status).toBe(200);
    expect(JSON.stringify(body)).toBe(baselineJson);
  }, 20000);

  it('flag ON (case-insensitive surface name) + no credentials: identical output', async () => {
    process.env.SUPA_SURFACES = ' Workflows ';
    const { body } = await getMission(WF_ID);
    expect(JSON.stringify(body)).toBe(baselineJson);
  });
});
