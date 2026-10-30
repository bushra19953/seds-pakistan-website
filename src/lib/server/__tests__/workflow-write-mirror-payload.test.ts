/**
 * @jest-environment node
 *
 * Read-bleed train 2 (census 23 A3/A5): the payload mirror variants
 * in workflow-write-mirror. The union gate must decide workflow
 * linkage from HELD data (no fetcher exists in this API at all, so
 * a non-workflow doc can never cost a read), member/task payload
 * variants must upsert the held doc verbatim (sanitized), and the
 * gate OFF must make every variant a no-op.
 */

import {
  __setWorkflowWriteMirrorLoaderForTests,
  mirrorWorkflowLinkedTaskDocsFromData,
  mirrorWorkflowMemberDocFromData,
  mirrorWorkflowTaskDocFromData,
} from '../workflow-write-mirror';

const setDocCalls: Array<{ collection: string; id: string; data: any }> = [];

function installAdapter(enabled: boolean) {
  const adapter = {
    getDoc: jest.fn(async () => null),
    listDocs: jest.fn(async () => []),
    countDocs: jest.fn(async () => 0),
    setDoc: jest.fn(async (collection: string, id: string, data: any) => {
      setDocCalls.push({ collection, id, data });
      return { id, ...data };
    }),
    updateDoc: jest.fn(async () => ({} as any)),
    deleteDoc: jest.fn(async () => {}),
  };
  __setWorkflowWriteMirrorLoaderForTests(async () => ({
    useSupa: () => enabled,
    getSupaClient: () => (enabled ? {} : null),
    getSupaAdapter: () => adapter,
  }));
  return adapter;
}

beforeEach(() => {
  setDocCalls.length = 0;
});

afterEach(() => {
  __setWorkflowWriteMirrorLoaderForTests(null);
});

describe('mirrorWorkflowLinkedTaskDocsFromData (union gate, payload form)', () => {
  it('mirrors only workflow-linked held docs; plain tasks cost nothing', async () => {
    installAdapter(true);
    await mirrorWorkflowLinkedTaskDocsFromData([
      ['plain-1', { title: 'Plain', status: 'pending' }],
      ['step-1', { title: 'Step', workflowId: 'wf-1', status: 'pending' }],
      ['plain-2', { title: 'Also plain', workflowId: '' }],
    ]);
    expect(setDocCalls).toHaveLength(1);
    expect(setDocCalls[0]).toMatchObject({ collection: 'tasks', id: 'step-1' });
    expect(setDocCalls[0].data).toMatchObject({ title: 'Step', workflowId: 'wf-1' });
  });

  it('dedupes repeated ids', async () => {
    installAdapter(true);
    await mirrorWorkflowLinkedTaskDocsFromData([
      ['step-1', { workflowId: 'wf-1', status: 'pending' }],
      ['step-1', { workflowId: 'wf-1', status: 'pending' }],
    ]);
    expect(setDocCalls).toHaveLength(1);
  });

  it('is a no-op when the workflows gate is OFF', async () => {
    installAdapter(false);
    await mirrorWorkflowLinkedTaskDocsFromData([
      ['step-1', { workflowId: 'wf-1', status: 'pending' }],
    ]);
    expect(setDocCalls).toHaveLength(0);
  });
});

describe('payload doc variants', () => {
  it('mirrorWorkflowTaskDocFromData upserts the held doc (sanitized)', async () => {
    installAdapter(true);
    await mirrorWorkflowTaskDocFromData('task-9', {
      title: 'Held',
      createdAt: new Date('2026-10-30T00:00:00.000Z'),
    });
    expect(setDocCalls).toHaveLength(1);
    expect(setDocCalls[0]).toMatchObject({ collection: 'tasks', id: 'task-9' });
    expect(setDocCalls[0].data.title).toBe('Held');
    expect(setDocCalls[0].data.createdAt).toBe('2026-10-30T00:00:00.000Z');
  });

  it('mirrorWorkflowMemberDocFromData upserts into workflow_members', async () => {
    installAdapter(true);
    await mirrorWorkflowMemberDocFromData('wf-1_user-1', {
      workflowId: 'wf-1',
      userId: 'user-1',
      role: 'member',
    });
    expect(setDocCalls).toHaveLength(1);
    expect(setDocCalls[0]).toMatchObject({ collection: 'workflow_members', id: 'wf-1_user-1' });
  });

  it('never throws when the adapter write fails', async () => {
    const adapter = installAdapter(true);
    (adapter.setDoc as jest.Mock).mockRejectedValue(new Error('adapter down'));
    await expect(
      mirrorWorkflowTaskDocFromData('task-9', { title: 'Held' })
    ).resolves.toBeUndefined();
    await expect(
      mirrorWorkflowLinkedTaskDocsFromData([['s', { workflowId: 'wf-1' }]])
    ).resolves.toBeUndefined();
  });
});
