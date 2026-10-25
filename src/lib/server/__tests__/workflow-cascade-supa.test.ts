/**
 * @jest-environment node
 *
 * wf-4 migration M7: collectWorkflowDeletions' workflow_members listing.
 * Supa path: refs are constructed from seam doc ids and the Firestore
 * collection .get() is never called. Fallback (seam null): the original
 * full-collection .get() runs. All mocked — zero live reads.
 */
const mockList = jest.fn();
jest.mock('../workflow-members-supa', () => {
  const actual = jest.requireActual('../workflow-members-supa');
  return { ...actual, listWorkflowMembersViaSupa: (...a: any[]) => mockList(...a) };
});

import { collectWorkflowDeletions } from '../workflow-cascade';

const membersGet = jest.fn(async () => ({
  docs: [
    { id: 'wf-1_a', ref: { __fsRef: 'wf-1_a' } },
    { id: 'wf-1_b', ref: { __fsRef: 'wf-1_b' } },
    { id: 'wf-2_c', ref: { __fsRef: 'wf-2_c' } },
  ],
}));

function fakeDb() {
  return {
    collection: (name: string) => {
      if (name === 'tasks') {
        return {
          where: () => ({
            get: async () => ({ docs: [{ ref: { __taskRef: 't1' } }, { ref: { __taskRef: 't2' } }] }),
          }),
        };
      }
      if (name === 'workflow_members') {
        return {
          get: membersGet,
          doc: (id: string) => ({ __supaRef: id }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    },
  } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  membersGet.mockClear();
});

it('supa path: member refs built from seam ids; Firestore members .get() untouched', async () => {
  mockList.mockResolvedValue([
    { id: 'wf-1_a', userId: 'a' },
    { id: 'wf-2_c', userId: 'c' },
    { id: 'wf-1_d', userId: 'd' },
  ]);
  const { taskRefs, memberRefs } = await collectWorkflowDeletions(fakeDb(), 'wf-1');
  expect(taskRefs).toEqual([{ __taskRef: 't1' }, { __taskRef: 't2' }]);
  expect(memberRefs).toEqual([{ __supaRef: 'wf-1_a' }, { __supaRef: 'wf-1_d' }]);
  expect(membersGet).not.toHaveBeenCalled();
});

it('fallback: seam null -> original Firestore scan + snapshot refs', async () => {
  mockList.mockResolvedValue(null);
  const { memberRefs } = await collectWorkflowDeletions(fakeDb(), 'wf-1');
  expect(memberRefs).toEqual([{ __fsRef: 'wf-1_a' }, { __fsRef: 'wf-1_b' }]);
  expect(membersGet).toHaveBeenCalledTimes(1);
});

it('supa path with zero members for this workflow -> empty member refs', async () => {
  mockList.mockResolvedValue([{ id: 'wf-9_x', userId: 'x' }]);
  const { memberRefs } = await collectWorkflowDeletions(fakeDb(), 'wf-1');
  expect(memberRefs).toEqual([]);
  expect(membersGet).not.toHaveBeenCalled();
});
