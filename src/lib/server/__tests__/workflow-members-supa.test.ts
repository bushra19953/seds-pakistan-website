/**
 * @jest-environment node
 *
 * Seam contracts for group wf-4 (workflow_members reads).
 * Everything is mocked — zero live Firestore/Supabase reads.
 * The gate under test is the landed adapter's pattern, verbatim:
 *   useSupa('workflows') && getSupaClient()  ->  getSupaAdapter().listDocs(...)
 * Any miss returns null so callers run their original Firestore path.
 */
import {
  __setWorkflowMembersSupaLoaderForTests,
  extractWorkflowMemberUids,
  filterWorkflowMemberIds,
  getWorkflowsSupaAdapter,
  listWorkflowMembersViaSupa,
} from '../workflow-members-supa';

afterEach(() => {
  __setWorkflowMembersSupaLoaderForTests(null);
});

function fakeModule(opts: {
  flag?: boolean;
  client?: unknown;
  docs?: unknown;
  listError?: Error;
}) {
  const listDocs = jest.fn(async () => {
    if (opts.listError) throw opts.listError;
    return opts.docs;
  });
  const adapter = { listDocs };
  const mod = {
    useSupa: jest.fn((_surface: string) => opts.flag ?? true),
    getSupaClient: jest.fn(() => (opts.client === undefined ? { fake: true } : opts.client)),
    getSupaAdapter: jest.fn((): any => adapter),
  };
  return { mod, listDocs, adapter };
}

describe('gate: useSupa(workflows) && getSupaClient()', () => {
  it('adapter module absent (loader null) -> null', async () => {
    __setWorkflowMembersSupaLoaderForTests(async () => null);
    await expect(listWorkflowMembersViaSupa()).resolves.toBeNull();
    await expect(getWorkflowsSupaAdapter()).resolves.toBeNull();
  });

  it('flag OFF -> null, adapter never built', async () => {
    const { mod } = fakeModule({ flag: false });
    __setWorkflowMembersSupaLoaderForTests(async () => mod);
    await expect(listWorkflowMembersViaSupa()).resolves.toBeNull();
    expect(mod.useSupa).toHaveBeenCalledWith('workflows');
    expect(mod.getSupaAdapter).not.toHaveBeenCalled();
  });

  it('flag ON but client null (unconfigured) -> null', async () => {
    const { mod } = fakeModule({ flag: true, client: null });
    __setWorkflowMembersSupaLoaderForTests(async () => mod);
    await expect(listWorkflowMembersViaSupa()).resolves.toBeNull();
    expect(mod.getSupaClient).toHaveBeenCalled();
    expect(mod.getSupaAdapter).not.toHaveBeenCalled();
  });

  it('module missing the adapter exports -> null', async () => {
    __setWorkflowMembersSupaLoaderForTests(async () => ({}));
    await expect(listWorkflowMembersViaSupa()).resolves.toBeNull();
  });
});

describe('listWorkflowMembersViaSupa', () => {
  it('returns adapter docs, querying exactly the workflow_members collection', async () => {
    const docs = [
      { id: 'wf-1_u1', workflowId: 'wf-1', userId: 'u1', role: 'member' },
      { id: 'wf-1_u2', workflowId: 'wf-1', userId: 'u2', role: 'owner' },
    ];
    const { mod, listDocs } = fakeModule({ docs });
    __setWorkflowMembersSupaLoaderForTests(async () => mod);
    await expect(listWorkflowMembersViaSupa()).resolves.toEqual(docs);
    expect(listDocs).toHaveBeenCalledTimes(1);
    expect(listDocs).toHaveBeenCalledWith('workflow_members');
  });

  it('empty result is a real result, not a fallback signal', async () => {
    const { mod } = fakeModule({ docs: [] });
    __setWorkflowMembersSupaLoaderForTests(async () => mod);
    await expect(listWorkflowMembersViaSupa()).resolves.toEqual([]);
  });

  it('adapter error (SupaAdapterError-shaped) -> null for Firestore fallback', async () => {
    const err = new Error('query-failed: boom');
    err.name = 'SupaAdapterError';
    const { mod } = fakeModule({ listError: err });
    __setWorkflowMembersSupaLoaderForTests(async () => mod);
    await expect(listWorkflowMembersViaSupa()).resolves.toBeNull();
  });

  it('non-array adapter result -> null', async () => {
    const { mod } = fakeModule({ docs: { nope: true } });
    __setWorkflowMembersSupaLoaderForTests(async () => mod);
    await expect(listWorkflowMembersViaSupa()).resolves.toBeNull();
  });
});

describe('pure extraction (duplicate/cascade semantics)', () => {
  const docs = [
    { id: 'wf-1_u1', userId: 'u1' },
    { id: 'wf-1_u2' }, // no userId field -> id suffix
    { id: 'wf-1_u1', userId: 'u1' }, // duplicate -> deduped
    { id: 'wf-1_' }, // empty suffix -> skipped
    { id: 'wf-2_u9', userId: 'u9' }, // other workflow -> skipped
    { id: 'wf-10_u3', userId: 'u3' }, // prefix trap: wf-1 vs wf-10
  ];

  it('extractWorkflowMemberUids replicates the original prefix + uid logic', () => {
    // 'wf-10_u3' DOES start with 'wf-1' but not 'wf-1_'... the original
    // checks startsWith(`${id}_`), so it is excluded; u3 must not appear.
    expect([...extractWorkflowMemberUids(docs, 'wf-1')].sort()).toEqual(['u1', 'u2']);
  });

  it('filterWorkflowMemberIds keeps only this workflow\u2019s doc ids, in order', () => {
    expect(filterWorkflowMemberIds(docs, 'wf-1')).toEqual(['wf-1_u1', 'wf-1_u2', 'wf-1_u1', 'wf-1_']);
    expect(filterWorkflowMemberIds(docs, 'wf-2')).toEqual(['wf-2_u9']);
    expect(filterWorkflowMemberIds([], 'wf-1')).toEqual([]);
  });
});
