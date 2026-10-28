/**
 * @jest-environment node
 *
 * Named-reviewer validation door: canValidateTask arm 3. The caller
 * designated as the task's reviewer at creation may validate, via the
 * stamped uid fields only: `reviewerId` (lead) and `reviewerIds`
 * (lead + co-reviewers). Description text grants NOTHING: a task
 * whose description names the caller but carries no fields is denied
 * (founder ruling 2026-10-28: identity by email/uid, never by name).
 * Self-approval stays denied in every shape, and no other door is
 * disturbed: each fixture gives the submitter no chain, a different
 * assigner, and a caller with no role grant, so the reviewer door is
 * the only possible grant.
 */
const mockDbHolder: { db: unknown } = { db: null };

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  admin: { firestore: { FieldValue: { serverTimestamp: () => 'ts' } } },
}));

import { FakeFirestore } from '@/lib/__tests__/helpers/fake-firestore';
import { canValidateTask } from '../hierarchy';

const REVIEWER = 'PB6yfB2UsngMvi1slAAHZeT7kOh1'; // Bushra's reviewer account
const CO_REVIEWER = 'IPhLvckHJQgj5cZxr5nQESauH762'; // Ahmed's account
const SUBMITTER = 'submitter-1';
const ASSIGNER = 'assigner-1';

let fake: FakeFirestore;

beforeEach(() => {
  fake = new FakeFirestore();
  mockDbHolder.db = fake.asDb();
  // Submitter with no manager anywhere: the chain walk resolves empty.
  fake.seed('users', SUBMITTER, { displayName: 'Hassan Ali' });
  fake.seed('users', REVIEWER, { displayName: 'Bushra Rahman' });
  fake.seed('users', CO_REVIEWER, { displayName: 'Ahmed Ali' });
  // Callers hold no canManageTasks grant.
  fake.seed('roles', REVIEWER, { role: 'member', additionalRoles: [] });
  fake.seed('roles', CO_REVIEWER, { role: 'member', additionalRoles: [] });
});

const HASSAN_DESCRIPTION =
  '72-Hour Crucible task ROV-001. Pod: 3A. Candidate: Hassan Ali. ' +
  'Reviewer: Bushra Rahman (Lead Coder / Autonomy Lead) / Ahmed Ali Kamran (Chapter Vice President). ' +
  'Faculty patron: Prof. Dr. Najam Abbas Naqvi. Deliverable: a Docker image.';

it('reviewerId field: the named reviewer validates via the reviewer door', async () => {
  const result = await canValidateTask(REVIEWER, 'member', {
    submittedBy: SUBMITTER,
    assigneeId: SUBMITTER,
    assignerId: ASSIGNER,
    reviewerId: REVIEWER,
  } as any);
  expect(result.allowed).toBe(true);
  expect(result.via).toBe('reviewer');
});

it('reviewerIds field: a co-reviewer validates exactly like the lead', async () => {
  const result = await canValidateTask(CO_REVIEWER, 'member', {
    submittedBy: SUBMITTER,
    assigneeId: SUBMITTER,
    assignerId: ASSIGNER,
    reviewerId: REVIEWER,
    reviewerIds: [REVIEWER, CO_REVIEWER],
  } as any);
  expect(result.allowed).toBe(true);
  expect(result.via).toBe('reviewer');
});

it('reviewerIds alone (no reviewerId) still grants the door', async () => {
  const result = await canValidateTask(CO_REVIEWER, 'member', {
    submittedBy: SUBMITTER,
    assigneeId: SUBMITTER,
    assignerId: ASSIGNER,
    reviewerIds: [CO_REVIEWER],
  } as any);
  expect(result.allowed).toBe(true);
  expect(result.via).toBe('reviewer');
});

it('PIN: description names the caller but NO fields are stamped: denied (text grants nothing)', async () => {
  const result = await canValidateTask(REVIEWER, 'member', {
    submittedBy: SUBMITTER,
    assigneeId: SUBMITTER,
    assignerId: ASSIGNER,
    description: HASSAN_DESCRIPTION,
  } as any);
  expect(result.allowed).toBe(false);
});

it('reviewer who is also the submitter is still denied (self-approval)', async () => {
  const result = await canValidateTask(REVIEWER, 'member', {
    submittedBy: REVIEWER,
    assigneeId: REVIEWER,
    assignerId: ASSIGNER,
    reviewerId: REVIEWER,
    reviewerIds: [REVIEWER],
  } as any);
  expect(result.allowed).toBe(false);
  expect(result.reason).toBe('cannot validate own submission');
});

it('assignee-reviewer on a task with no recorded submitter gets no door', async () => {
  const result = await canValidateTask(REVIEWER, 'member', {
    assigneeId: REVIEWER,
    assignerId: ASSIGNER,
    reviewerId: REVIEWER,
  } as any);
  expect(result.allowed).toBe(false);
});

it('unrelated user is still denied', async () => {
  fake.seed('roles', 'stranger-1', { role: 'member', additionalRoles: [] });
  const result = await canValidateTask('stranger-1', 'member', {
    submittedBy: SUBMITTER,
    assigneeId: SUBMITTER,
    assignerId: ASSIGNER,
    reviewerId: REVIEWER,
    reviewerIds: [REVIEWER, CO_REVIEWER],
    description: HASSAN_DESCRIPTION,
  } as any);
  expect(result.allowed).toBe(false);
});
