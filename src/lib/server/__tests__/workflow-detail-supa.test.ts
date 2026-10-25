/**
 * @jest-environment node
 *
 * Seam contracts for group wf-5 (workflow DETAIL route read inputs,
 * GET /api/workflows?workflowId= in the pinned route, base 4d5a1e16).
 * Everything is mocked — zero live Firestore/Supabase reads.
 *
 * The fake adapter is the wf-6 shared fixtures' mock of the LANDED
 * adapter API (buildMockSupaModule), seeded with the jsonb
 * round-trip of the Firestore fixture docs, so every assertion is a
 * deep-equality check between what the seam returns and the
 * Firestore-shaped fixture set after that round-trip.
 *
 * The gate under test is the landed adapter's pattern, verbatim:
 *   useSupa('workflows') && getSupaClient()  ->  getSupaAdapter()
 * Any miss returns null so step 17 runs the original Firestore path.
 * An empty store is NOT a miss: empty sets / exists:false come back
 * as real results so a caller can distinguish 404 from fallback.
 */
import {
  __setWorkflowDetailSupaLoaderForTests,
  type SupaLoader,
  detailTaskAssigneeIds,
  fetchWorkflowDetailReadsViaSupa,
  getWorkflowChapterViaSupa,
  getWorkflowMemberViaSupa,
  getWorkflowRoleViaSupa,
  getWorkflowUserViaSupa,
  listWorkflowTasksViaSupa,
} from '../workflow-detail-supa';
import {
  CHAPTER_ID,
  WF_ID,
  buildMockSupaModule,
  freshMockSupaState,
  jsonbChapters,
  jsonbSteps,
  jsonbUsers,
  type MockSupaState,
} from '@/lib/__tests__/supa-wf-fixtures';

let state: MockSupaState;

function seedPopulatedStore() {
  state.store.tasks = jsonbSteps();
  state.store.users = jsonbUsers();
  state.store.chapters = jsonbChapters();
  state.store.roles = { u1: { role: 'member' }, outsider1: { role: 'member' } };
  state.store.workflow_members = {};
}

beforeEach(() => {
  state = freshMockSupaState();
  state.surfaces = 'workflows'; // flag ON for the 'workflows' surface
  seedPopulatedStore();
  // The fixtures' mock adapter is `any`-shaped by design (shared across
  // clusters); cast it onto the seam's loader type.
  __setWorkflowDetailSupaLoaderForTests(
    (async () => buildMockSupaModule(() => state)) as unknown as SupaLoader,
  );
});

afterEach(() => {
  __setWorkflowDetailSupaLoaderForTests(null);
});

describe('(a) adapter consultation: seam output deep-equals the fixture doc sets (jsonb round-trip)', () => {
  it('tasks: listDocs(tasks, where workflowId==) -> snapshot docs equal to the fixture steps', async () => {
    const snap = await listWorkflowTasksViaSupa(WF_ID);
    expect(snap).not.toBeNull();
    expect(snap!.empty).toBe(false);
    expect(snap!.docs.map((d) => ({ id: d.id, ...d.data() }))).toEqual(jsonbSteps());

    const listCalls = state.calls.filter((c) => c.method === 'listDocs');
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].collection).toBe('tasks');
    expect(listCalls[0].args[0]).toEqual({ where: [['workflowId', '==', WF_ID]] });
  });

  it('users: getDoc(users, uid) -> { id, exists, data() } equal to the fixture user', async () => {
    const u1 = await getWorkflowUserViaSupa('u1');
    expect(u1).not.toBeNull();
    expect(u1!.id).toBe('u1');
    expect(u1!.exists).toBe(true);
    expect(u1!.data()).toEqual(jsonbUsers().u1);

    const u2 = await getWorkflowUserViaSupa('u2');
    expect(u2!.data()).toEqual(jsonbUsers().u2);

    const missing = await getWorkflowUserViaSupa('ghost');
    expect(missing).not.toBeNull();
    expect(missing!.exists).toBe(false);
    expect(missing!.data()).toBeUndefined();
  });

  it('chapters: getDoc(chapters, id) -> fixture chapter', async () => {
    const chap = await getWorkflowChapterViaSupa(CHAPTER_ID);
    expect(chap).not.toBeNull();
    expect(chap!.exists).toBe(true);
    expect(chap!.data()).toEqual(jsonbChapters()[CHAPTER_ID]);
  });

  it('roles: getDoc(roles, viewerUid) -> fixture role doc', async () => {
    const role = await getWorkflowRoleViaSupa('u1');
    expect(role).not.toBeNull();
    expect(role!.exists).toBe(true);
    expect(role!.data()).toEqual({ role: 'member' });
  });

  it('aggregate: fetchWorkflowDetailReadsViaSupa returns the whole chain in handler shapes', async () => {
    const reads = await fetchWorkflowDetailReadsViaSupa(WF_ID, 'u1');
    expect(reads).not.toBeNull();
    expect(reads!.tasksSnap.docs.map((d) => ({ id: d.id, ...d.data() }))).toEqual(jsonbSteps());
    // First task carries chapterId -> workflow chapter snapshot present.
    expect(reads!.workflowChapterSnap!.exists).toBe(true);
    expect(reads!.workflowChapterSnap!.data()).toEqual(jsonbChapters()[CHAPTER_ID]);
    // Unique assignees in first-seen order, snapshots parallel.
    expect(reads!.uniqueAssigneeIds).toEqual(['u1', 'u2']);
    expect(reads!.userSnaps.map((s) => s.data())).toEqual([jsonbUsers().u1, jsonbUsers().u2]);
    // u1 has chapterId and NO chapterName -> per-user chapter lookup ran;
    // u2 carries chapterName -> no lookup (handler cache semantics).
    expect(Object.keys(reads!.userChapterSnaps)).toEqual([CHAPTER_ID]);
    expect(reads!.userChapterSnaps[CHAPTER_ID].data()).toEqual(jsonbChapters()[CHAPTER_ID]);
    expect(reads!.roleSnap.data()).toEqual({ role: 'member' });
    expect(reads!.memberSnap.exists).toBe(false);
  });
});

describe('(b) the membership gate: a workflow_members doc alone is surfaced faithfully', () => {
  it('member doc for a non-assignee viewer: exists + full data (the unmask precondition)', async () => {
    const memberData = { workflowId: WF_ID, userId: 'outsider1', role: 'member', joinedAt: '2026-10-17T08:00:00.000Z' };
    state.store.workflow_members = { [`${WF_ID}_outsider1`]: { ...memberData } };

    const snap = await getWorkflowMemberViaSupa(WF_ID, 'outsider1');
    expect(snap).not.toBeNull();
    expect(snap!.id).toBe(`${WF_ID}_outsider1`);
    expect(snap!.exists).toBe(true);
    expect(snap!.data()).toEqual(memberData);

    // Same through the aggregate: outsider1 is not an assignee of any
    // step, yet the gate doc is what the seam hands the handler.
    const reads = await fetchWorkflowDetailReadsViaSupa(WF_ID, 'outsider1');
    expect(reads).not.toBeNull();
    expect(reads!.uniqueAssigneeIds).toEqual(['u1', 'u2']);
    expect(reads!.memberSnap.exists).toBe(true);
    expect(reads!.memberSnap.data()).toEqual(memberData);
  });

  it('a member doc for a DIFFERENT workflow does not surface for this one', async () => {
    state.store.workflow_members = {
      wf_other_outsider1: { workflowId: 'wf_other', userId: 'outsider1', role: 'member' },
    };
    const snap = await getWorkflowMemberViaSupa(WF_ID, 'outsider1');
    expect(snap).not.toBeNull();
    expect(snap!.exists).toBe(false);
  });
});

describe('(c) gate failure semantics: null means fallback, empty means empty', () => {
  it('flag ON + adapter throws -> null from every helper and the aggregate', async () => {
    state.adapterMode = 'throw';
    await expect(listWorkflowTasksViaSupa(WF_ID)).resolves.toBeNull();
    await expect(getWorkflowUserViaSupa('u1')).resolves.toBeNull();
    await expect(getWorkflowChapterViaSupa(CHAPTER_ID)).resolves.toBeNull();
    await expect(getWorkflowRoleViaSupa('u1')).resolves.toBeNull();
    await expect(getWorkflowMemberViaSupa(WF_ID, 'u1')).resolves.toBeNull();
    await expect(fetchWorkflowDetailReadsViaSupa(WF_ID, 'u1')).resolves.toBeNull();
  });

  it('flag OFF -> null, and the adapter is never consulted', async () => {
    state.surfaces = undefined;
    await expect(listWorkflowTasksViaSupa(WF_ID)).resolves.toBeNull();
    await expect(getWorkflowUserViaSupa('u1')).resolves.toBeNull();
    await expect(fetchWorkflowDetailReadsViaSupa(WF_ID, 'u1')).resolves.toBeNull();
    expect(state.calls).toEqual([]);
  });

  it("flag ON for a different surface only -> null, adapter never consulted", async () => {
    state.surfaces = 'announcements';
    await expect(listWorkflowTasksViaSupa(WF_ID)).resolves.toBeNull();
    expect(state.calls).toEqual([]);
  });

  it('flag ON + client unconfigured -> null', async () => {
    state.clientNull = true;
    await expect(listWorkflowTasksViaSupa(WF_ID)).resolves.toBeNull();
    await expect(fetchWorkflowDetailReadsViaSupa(WF_ID, 'u1')).resolves.toBeNull();
  });

  it('adapter module absent (loader null) -> null', async () => {
    __setWorkflowDetailSupaLoaderForTests(async () => null);
    await expect(listWorkflowTasksViaSupa(WF_ID)).resolves.toBeNull();
    await expect(fetchWorkflowDetailReadsViaSupa(WF_ID, 'u1')).resolves.toBeNull();
  });

  it('flag ON + EMPTY store -> empty sets, NOT null (404 is distinguishable from fallback)', async () => {
    state.store = { tasks: [], users: {}, chapters: {}, roles: {}, workflow_members: {} };

    const snap = await listWorkflowTasksViaSupa(WF_ID);
    expect(snap).not.toBeNull();
    expect(snap).toEqual({ docs: [], empty: true });

    const user = await getWorkflowUserViaSupa('u1');
    expect(user).not.toBeNull();
    expect(user!.exists).toBe(false);

    const reads = await fetchWorkflowDetailReadsViaSupa(WF_ID, 'u1');
    expect(reads).not.toBeNull();
    expect(reads!.tasksSnap).toEqual({ docs: [], empty: true });
    expect(reads!.workflowChapterSnap).toBeNull(); // no task -> handler skips this read
    expect(reads!.uniqueAssigneeIds).toEqual([]);
    expect(reads!.userSnaps).toEqual([]);
    expect(reads!.userChapterSnaps).toEqual({});
    expect(reads!.roleSnap.exists).toBe(false);
    expect(reads!.memberSnap.exists).toBe(false);
  });
});

describe('detailTaskAssigneeIds (pure, handler derivation)', () => {
  it('assigneeIds[] wins when non-empty; singular assigneeId otherwise', () => {
    expect(detailTaskAssigneeIds({ assigneeIds: ['a', 'b'], assigneeId: 'a' })).toEqual(['a', 'b']);
    expect(detailTaskAssigneeIds({ assigneeIds: [], assigneeId: 'a' })).toEqual(['a']);
    expect(detailTaskAssigneeIds({ assigneeId: 'a' })).toEqual(['a']);
    expect(detailTaskAssigneeIds({})).toEqual([]);
    expect(detailTaskAssigneeIds({ assigneeIds: [1, ''] })).toEqual(['1']);
  });
});
