/**
 * @jest-environment node
 *
 * Mirror-on-write for workflow-owned writes (workflow-write-mirror).
 *
 * Regression suite for the 2026-10-26 "mission with no steps"
 * incident: POST /api/workflows wrote step tasks + workflow_members
 * to Firestore only, while the detail/public/PDF readers read the
 * Supabase mirror under the 'workflows' flag — so every workflow
 * created after the migration snapshot was invisible on those
 * surfaces. These tests pin the fix's gate semantics under the
 * LIVE flag set (workflows ON, tasks OFF): the mirror must consult
 * 'workflows' (the readers' surface), never 'tasks'.
 *
 * Everything is mocked — zero live Firestore/Supabase I/O. The fake
 * '@/lib/supa' module is injected through the seam's loader hook.
 */

import {
  __setWorkflowWriteMirrorLoaderForTests,
  mirrorWorkflowMemberDeletesByIds,
  mirrorWorkflowMemberDocById,
  mirrorWorkflowTaskDeletesByIds,
  mirrorWorkflowTaskDocById,
} from '../workflow-write-mirror';

interface FakeState {
  surfaces: string | undefined;
  clientNull: boolean;
  adapterThrows: boolean;
  useSupaCalls: string[];
  store: Map<string, Map<string, Record<string, any>>>;
}

let state: FakeState;

function freshState(): FakeState {
  return {
    // The LIVE server flip list (subset): workflows ON, tasks OFF.
    surfaces: 'announcements,roles,users,workflows',
    clientNull: false,
    adapterThrows: false,
    useSupaCalls: [],
    store: new Map(),
  };
}

function collectionOf(name: string): Map<string, Record<string, any>> {
  if (!state.store.has(name)) state.store.set(name, new Map());
  return state.store.get(name)!;
}

function fakeAdapter() {
  return {
    getDoc: async (collection: string, id: string) => {
      const doc = collectionOf(collection).get(id);
      return doc ? { id, ...doc } : null;
    },
    listDocs: async (collection: string, options?: any) => {
      const where: Array<[string, string, unknown]> = options?.where ?? [];
      return Array.from(collectionOf(collection).entries())
        .map(([id, data]) => ({ id, ...data }))
        .filter((doc) => where.every(([field, _op, value]) => (doc as any)[field] === value));
    },
    countDocs: async () => 0,
    setDoc: async (collection: string, id: string, data: Record<string, unknown>) => {
      if (state.adapterThrows) throw new Error('adapter boom');
      collectionOf(collection).set(id, { ...data });
      return { id, ...data };
    },
    updateDoc: async () => ({ id: '' }),
    deleteDoc: async (collection: string, id: string) => {
      collectionOf(collection).delete(id);
    },
  };
}

function injectFakeSupa() {
  __setWorkflowWriteMirrorLoaderForTests(async () => ({
    useSupa: (surface: string) => {
      state.useSupaCalls.push(surface);
      return (state.surfaces ?? '').split(',').map((s) => s.trim()).includes(surface);
    },
    getSupaClient: () => (state.clientNull ? null : { fake: true }),
    getSupaAdapter: () => fakeAdapter(),
  }));
}

const STEP_DATA = {
  title: 'Set Basic Member for the 4 never-reached accounts',
  workflowId: 'wf_1793016668063_ci14ft',
  workflowTitle: 'Role Hygiene Queue',
  sequenceIndex: 0,
  assigneeId: 'IPhLvckHJQgj5cZxr5nQESauH762',
  status: 'pending',
  deadline: new Date('2026-10-27T13:00:00.000Z'),
  createdAt: { _methodName: 'serverTimestamp' },
};

beforeEach(() => {
  state = freshState();
  injectFakeSupa();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  __setWorkflowWriteMirrorLoaderForTests(null);
  jest.restoreAllMocks();
});

describe('gate: the mirror consults the workflows surface (the readers surface)', () => {
  it('under the LIVE flag set (workflows ON, tasks OFF) the step mirror lands, sanitized', async () => {
    const fetchData = jest.fn(async () => ({ ...STEP_DATA }));
    await mirrorWorkflowTaskDocById('task-1', fetchData);

    expect(fetchData).toHaveBeenCalledTimes(1);
    expect(state.useSupaCalls).toContain('workflows');
    expect(state.useSupaCalls).not.toContain('tasks');

    const stored = collectionOf('tasks').get('task-1');
    expect(stored).toBeDefined();
    expect(stored!.workflowId).toBe('wf_1793016668063_ci14ft');
    // sanitizeForMirror parity with the tasks-route mirror:
    expect(stored!.deadline).toBe('2026-10-27T13:00:00.000Z'); // Date -> ISO
    expect(stored!.createdAt).toBeUndefined(); // FieldValue sentinel dropped
  });

  it('the mirrored step satisfies the readers exact query (workflowId ==) — the invisibility, inverted', async () => {
    await mirrorWorkflowTaskDocById('task-1', async () => ({ ...STEP_DATA }));
    await mirrorWorkflowTaskDocById('task-2', async () => ({
      ...STEP_DATA,
      title: 'Verify the 9 submitted-but-unconfirmed accounts',
      sequenceIndex: 1,
    }));
    await mirrorWorkflowTaskDocById('task-9', async () => ({
      ...STEP_DATA,
      workflowId: 'wf_someone_else',
      title: 'Unrelated',
    }));

    const adapter = fakeAdapter();
    const rows = await adapter.listDocs('tasks', {
      where: [['workflowId', '==', 'wf_1793016668063_ci14ft']],
    });
    expect(rows.map((r: any) => r.id).sort()).toEqual(['task-1', 'task-2']);
  });

  it('member mirror lands in workflow_members under the composite id', async () => {
    await mirrorWorkflowMemberDocById('wf_1793016668063_ci14ft_IPhLvckHJQgj5cZxr5nQESauH762', async () => ({
      workflowId: 'wf_1793016668063_ci14ft',
      userId: 'IPhLvckHJQgj5cZxr5nQESauH762',
      role: 'member',
      joinedAt: new Date('2026-10-26T12:11:00.000Z'),
    }));
    const stored = collectionOf('workflow_members').get(
      'wf_1793016668063_ci14ft_IPhLvckHJQgj5cZxr5nQESauH762',
    );
    expect(stored).toBeDefined();
    expect(stored!.role).toBe('member');
    expect(stored!.joinedAt).toBe('2026-10-26T12:11:00.000Z');
  });
});

describe('gate OFF / unavailable: zero reads, zero writes, never throws', () => {
  it('workflows OFF -> fetchData is never invoked (flag-OFF pays no reads)', async () => {
    state.surfaces = 'announcements,roles,users'; // live list minus workflows
    const fetchData = jest.fn(async () => ({ ...STEP_DATA }));
    await mirrorWorkflowTaskDocById('task-1', fetchData);
    expect(fetchData).not.toHaveBeenCalled();
    expect(collectionOf('tasks').size).toBe(0);
  });

  it('client unconfigured -> no-op', async () => {
    state.clientNull = true;
    const fetchData = jest.fn(async () => ({ ...STEP_DATA }));
    await mirrorWorkflowTaskDocById('task-1', fetchData);
    expect(fetchData).not.toHaveBeenCalled();
  });

  it('adapter module absent (loader null) -> no-op', async () => {
    __setWorkflowWriteMirrorLoaderForTests(async () => null);
    const fetchData = jest.fn(async () => ({ ...STEP_DATA }));
    await expect(mirrorWorkflowTaskDocById('task-1', fetchData)).resolves.toBeUndefined();
    expect(fetchData).not.toHaveBeenCalled();
  });

  it('adapter setDoc throws -> resolves anyway (the Firestore write stands)', async () => {
    state.adapterThrows = true;
    await expect(
      mirrorWorkflowTaskDocById('task-1', async () => ({ ...STEP_DATA })),
    ).resolves.toBeUndefined();
  });

  it('fetchData returns undefined (doc vanished) -> no setDoc, no throw', async () => {
    await expect(
      mirrorWorkflowTaskDocById('task-1', async () => undefined),
    ).resolves.toBeUndefined();
    expect(collectionOf('tasks').size).toBe(0);
  });
});

describe('mirror deletes (cascade)', () => {
  it('task + member deletes remove the mirrored rows', async () => {
    await mirrorWorkflowTaskDocById('task-1', async () => ({ ...STEP_DATA }));
    await mirrorWorkflowMemberDocById('wf_x_u1', async () => ({ workflowId: 'wf_x', userId: 'u1', role: 'member' }));
    expect(collectionOf('tasks').size).toBe(1);
    expect(collectionOf('workflow_members').size).toBe(1);

    await mirrorWorkflowTaskDeletesByIds(['task-1']);
    await mirrorWorkflowMemberDeletesByIds(['wf_x_u1']);
    expect(collectionOf('tasks').size).toBe(0);
    expect(collectionOf('workflow_members').size).toBe(0);
  });
});
