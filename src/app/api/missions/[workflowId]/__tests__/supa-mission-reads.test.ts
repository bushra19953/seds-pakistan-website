/**
 * @jest-environment node
 *
 * Seam/route consultation tests for feat/supa-wf-1
 * (GET /api/missions/[workflowId] through src/lib/server/mission-reads-supa).
 *
 * Everything is mocked — zero live Firestore/Supabase reads. The fake
 * '@/lib/supa' module is injected through the seam's loader hook
 * (the wf-4 injection pattern) and built by the shared wf-6 fixture
 * builder, which implements the LANDED adapter API. Firestore is
 * mocked like the contract suite, with call counters so tests can
 * prove which store served a request.
 *
 *   (a) flag ON + healthy adapter -> adapter consulted for
 *       tasks/users/chapters, response byte-identical to Firestore
 *   (b) flag ON + empty supa store -> 404 from the supa path,
 *       Firestore NOT consulted for the steps query
 *   (c) flag ON + adapter throws -> Firestore fallback, identical
 *   (d) flag OFF -> adapter never consulted
 *   (e) standalone-task fallback semantics preserved on the supa path
 *   (f) raw dumped timestamps ({_seconds,_nanoseconds}) on the supa
 *       path serialize byte-identically (the serializeTs pin)
 */

const mockFsState = {
  tasks: [] as Array<Record<string, any>>,
  users: {} as Record<string, Record<string, any>>,
  chapters: {} as Record<string, Record<string, any>>,
};
const mockFsCalls = {
  whereGets: 0,
  docGets: [] as Array<{ collection: string; id: string }>,
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
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() => ({
    collection: (name: string) => ({
      where: (_field: string, _op: string, value: string) => ({
        get: async () => {
          mockFsCalls.whereGets += 1;
          return {
            empty: mockFsState.tasks.filter((t) => t.workflowId === value).length === 0,
            docs: mockFsState.tasks
              .filter((t) => t.workflowId === value)
              .map((t) => ({ id: t.id, data: () => t })),
          };
        },
      }),
      doc: (id: string) => ({
        get: async () => {
          mockFsCalls.docGets.push({ collection: name, id });
          return docOf(name, id);
        },
      }),
    }),
  })),
}));

// NOTE: '@/lib/workflow-progress' is intentionally NOT mocked — same
// as the wf-6 contract suite, the real semantics are part of the pin.

import { GET } from '@/app/api/missions/[workflowId]/route';
import { NextRequest } from 'next/server';
import {
  __setMissionReadsSupaLoaderForTests,
  listMissionStepsViaSupa,
  reviveDumpedTimestamps,
} from '@/lib/server/mission-reads-supa';
import {
  WF_ID,
  buildMockSupaModule,
  freshMockSupaState,
  firestoreSteps,
  firestoreUsers,
  firestoreChapters,
  jsonbSteps,
  jsonbUsers,
  jsonbChapters,
  FakeTimestamp,
  type MockSupaState,
} from '@/lib/__tests__/supa-wf-fixtures';

let supaState: MockSupaState;

/** Inject the fixture-built fake '@/lib/supa' module into the seam. */
function injectMockSupa() {
  // The fixture builder's adapter is structurally the landed API; the
  // cast bridges its index-signature doc type to the seam mirror type.
  __setMissionReadsSupaLoaderForTests(
    async () => buildMockSupaModule(() => supaState) as any,
  );
}

async function getMission(workflowId: string) {
  const req = new NextRequest(`http://localhost/api/missions/${workflowId}`);
  const res = await GET(req, { params: Promise.resolve({ workflowId }) });
  return { res, body: await res.json() };
}

function resetCounters() {
  supaState.calls = [];
  mockFsCalls.whereGets = 0;
  mockFsCalls.docGets = [];
}

let baselineJson = '';

beforeEach(async () => {
  supaState = freshMockSupaState();
  supaState.store.tasks = jsonbSteps();
  supaState.store.users = jsonbUsers();
  supaState.store.chapters = jsonbChapters();
  mockFsState.tasks = firestoreSteps();
  mockFsState.users = firestoreUsers();
  mockFsState.chapters = firestoreChapters();
  injectMockSupa();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  // Baseline: flag OFF (surfaces unset) -> Firestore path.
  supaState.surfaces = undefined;
  const { body } = await getMission(WF_ID);
  baselineJson = JSON.stringify(body);
  resetCounters();
});

afterEach(() => {
  __setMissionReadsSupaLoaderForTests(null);
  jest.restoreAllMocks();
});

describe('mission route supa consultation', () => {
  it('(a) flag ON + healthy adapter: tasks/users/chapters via adapter, byte-identical response, Firestore untouched', async () => {
    supaState.surfaces = 'workflows';
    const { res, body } = await getMission(WF_ID);
    expect(res.status).toBe(200);
    expect(JSON.stringify(body)).toBe(baselineJson);

    const taskLists = supaState.calls.filter(
      (c) => c.method === 'listDocs' && c.collection === 'tasks',
    );
    expect(taskLists).toHaveLength(1);
    expect(taskLists[0].args).toEqual([{ where: [['workflowId', '==', WF_ID]] }]);

    const userGets = supaState.calls.filter(
      (c) => c.method === 'getDoc' && c.collection === 'users',
    );
    expect(userGets.map((c) => c.args[0]).sort()).toEqual(['u1', 'u2']);
    const chapterGets = supaState.calls.filter(
      (c) => c.method === 'getDoc' && c.collection === 'chapters',
    );
    expect(chapterGets.length).toBeGreaterThan(0);
    expect(chapterGets.every((c) => c.args[0] === 'chap_ist')).toBe(true);

    expect(mockFsCalls.whereGets).toBe(0);
    expect(mockFsCalls.docGets).toHaveLength(0);
  });

  it('(b) flag ON + empty supa store: 404 from the supa path, Firestore NOT consulted for the steps query', async () => {
    supaState.surfaces = 'workflows';
    supaState.store.tasks = [];
    const { res, body } = await getMission(WF_ID);
    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: 'Mission not found' });
    expect(supaState.calls.length).toBeGreaterThan(0);
    expect(mockFsCalls.whereGets).toBe(0);
    expect(mockFsCalls.docGets).toHaveLength(0);
  });

  it('(c) flag ON + adapter throws: Firestore fallback, identical response', async () => {
    supaState.surfaces = 'workflows';
    supaState.adapterMode = 'throw';
    const { res, body } = await getMission(WF_ID);
    expect(res.status).toBe(200);
    expect(JSON.stringify(body)).toBe(baselineJson);
    expect(supaState.calls.length).toBeGreaterThan(0);
    expect(mockFsCalls.whereGets).toBe(1);
  });

  it('(d) flag OFF: adapter never consulted, Firestore serves', async () => {
    supaState.surfaces = undefined;
    const { res, body } = await getMission(WF_ID);
    expect(res.status).toBe(200);
    expect(JSON.stringify(body)).toBe(baselineJson);
    expect(supaState.calls).toHaveLength(0);
    expect(mockFsCalls.whereGets).toBe(1);
  });

  it('(d2) flag ON + client null: Firestore fallback, identical response, no adapter reads', async () => {
    supaState.surfaces = 'workflows';
    supaState.clientNull = true;
    const { res, body } = await getMission(WF_ID);
    expect(res.status).toBe(200);
    expect(JSON.stringify(body)).toBe(baselineJson);
    expect(supaState.calls).toHaveLength(0);
    expect(mockFsCalls.whereGets).toBe(1);
  });

  it('(e) standalone task via supa: one-step mission, Firestore untouched', async () => {
    supaState.surfaces = 'workflows';
    supaState.store.tasks = [
      ...jsonbSteps(),
      {
        id: 'task_solo',
        title: 'Solo Task',
        description: 'No workflow',
        status: 'pending',
        points: 3,
        assigneeId: 'u1',
        assigneeIds: ['u1'],
        chapterId: 'chap_ist',
        createdAt: '2026-10-17T08:00:00.000Z',
        deadline: '2026-10-20T10:00:00.000Z',
      },
    ];
    const { res, body } = await getMission('task_solo');
    expect(res.status).toBe(200);
    expect(body.mission.title).toBe('Solo Task');
    expect(body.mission.totalSteps).toBe(1);
    expect(mockFsCalls.whereGets).toBe(0);
    expect(mockFsCalls.docGets).toHaveLength(0);
  });

  it('(e2) a supa task doc belonging to a DIFFERENT workflow keeps its 404', async () => {
    supaState.surfaces = 'workflows';
    const { res } = await getMission('step1');
    expect(res.status).toBe(404);
    expect(mockFsCalls.whereGets).toBe(0);
    expect(mockFsCalls.docGets).toHaveLength(0);
  });
});

describe('timestamp byte-identity pins', () => {
  /** Deep-convert FakeTimestamps to the raw dumped jsonb shape. */
  function toDumped<T>(value: T): T {
    if (value instanceof FakeTimestamp) {
      return { _seconds: value.seconds, _nanoseconds: value.nanoseconds } as unknown as T;
    }
    if (Array.isArray(value)) return value.map((v) => toDumped(v)) as unknown as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toDumped(v);
      return out as T;
    }
    return value;
  }

  it('(f) raw dumped timestamps on the supa path serialize byte-identically to the Firestore response', async () => {
    supaState.surfaces = 'workflows';
    supaState.store.tasks = firestoreSteps().map((s) => toDumped(s));
    const { res, body } = await getMission(WF_ID);
    expect(res.status).toBe(200);
    expect(JSON.stringify(body)).toBe(baselineJson);
  });

  it('reviveDumpedTimestamps: dumped shape gains the serializeTs surface; other shapes pass through', () => {
    const revived = reviveDumpedTimestamps({ _seconds: 1792730400, _nanoseconds: 500_000_000 }) as any;
    expect(revived.seconds).toBe(1792730400);
    expect(revived.nanoseconds).toBe(500_000_000);
    expect(revived.toDate().toISOString()).toBe(new Date(1792730400500).toISOString());
    // ISO strings (the jsonb shape) pass through unchanged.
    expect(reviveDumpedTimestamps('2026-10-20T10:00:00.000Z')).toBe('2026-10-20T10:00:00.000Z');
    // Timestamp-like objects pass through by identity.
    const fake = new FakeTimestamp('2026-10-20T10:00:00.000Z');
    expect(reviveDumpedTimestamps(fake)).toBe(fake);
    // Nested dumped shapes revive; extra keys mean NOT a dumped shape.
    const nested = reviveDumpedTimestamps({ a: { _seconds: 1, _nanoseconds: 0 } }) as any;
    expect(typeof nested.a.toDate).toBe('function');
    const notDumped = { _seconds: 1, _nanoseconds: 0, extra: true };
    expect(reviveDumpedTimestamps(notDumped)).toEqual(notDumped);
  });
});

describe('seam gate (wf-4 pattern)', () => {
  it('adapter module absent (loader null) -> null', async () => {
    __setMissionReadsSupaLoaderForTests(async () => null);
    await expect(listMissionStepsViaSupa(WF_ID)).resolves.toBeNull();
  });

  it('module missing the adapter exports -> null', async () => {
    __setMissionReadsSupaLoaderForTests(async () => ({}));
    await expect(listMissionStepsViaSupa(WF_ID)).resolves.toBeNull();
  });

  it('empty adapter result is a real result, not a fallback signal', async () => {
    supaState.surfaces = 'workflows';
    supaState.store.tasks = [];
    injectMockSupa();
    await expect(listMissionStepsViaSupa(WF_ID)).resolves.toEqual([]);
  });
});
