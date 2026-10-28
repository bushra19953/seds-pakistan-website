/**
 * @jest-environment node
 *
 * Named-reviewer validation door: canValidateTask arm 3. The caller
 * designated as the task's reviewer at creation may validate, via the
 * canonical reviewerId field OR the legacy "Reviewer:" description
 * line (workflow steps created before the field existed — Hassan's
 * Pod 3A step shape). Self-approval stays denied in every shape, and
 * no other door is disturbed: each fixture gives the submitter no
 * chain, a different assigner, and a caller with no role grant, so
 * the reviewer door is the only possible grant.
 */
const mockDbHolder: { db: unknown } = { db: null };

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  admin: { firestore: { FieldValue: { serverTimestamp: () => 'ts' } } },
}));

import { FakeFirestore } from '@/lib/__tests__/helpers/fake-firestore';
import { canValidateTask } from '../hierarchy';

const REVIEWER = 'PB6yfB2UsngMvi1slAAHZeT7kOh1'; // Bushra's reviewer account shape
const CO_REVIEWER_NAME = 'Ahmed Ali Kamran';
const SUBMITTER = 'submitter-1';
const ASSIGNER = 'assigner-1';

let fake: FakeFirestore;

beforeEach(() => {
  fake = new FakeFirestore();
  mockDbHolder.db = fake.asDb();
  // Submitter with no manager anywhere: the chain walk resolves empty.
  fake.seed('users', SUBMITTER, { displayName: 'Hassan Ali' });
  fake.seed('users', REVIEWER, { displayName: 'Bushra Rahman' });
  fake.seed('users', 'uid-ahmed', { displayName: CO_REVIEWER_NAME });
  // Caller holds no canManageTasks grant.
  fake.seed('roles', REVIEWER, { role: 'member', additionalRoles: [] });
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

it('legacy description line: lead reviewer validates (Hassan shape, no reviewerId)', async () => {
  const result = await canValidateTask(REVIEWER, 'member', {
    submittedBy: SUBMITTER,
    assigneeId: SUBMITTER,
    assignerId: ASSIGNER,
    description: HASSAN_DESCRIPTION,
  } as any);
  expect(result.allowed).toBe(true);
  expect(result.via).toBe('reviewer');
});

it('legacy description line: the co-reviewer validates too', async () => {
  fake.seed('roles', 'uid-ahmed', { role: 'member', additionalRoles: [] });
  const result = await canValidateTask('uid-ahmed', 'member', {
    submittedBy: SUBMITTER,
    assigneeId: SUBMITTER,
    assignerId: ASSIGNER,
    description: HASSAN_DESCRIPTION,
  } as any);
  expect(result.allowed).toBe(true);
  expect(result.via).toBe('reviewer');
});

it('reviewer who is also the submitter is still denied (self-approval)', async () => {
  const result = await canValidateTask(REVIEWER, 'member', {
    submittedBy: REVIEWER,
    assigneeId: REVIEWER,
    assignerId: ASSIGNER,
    reviewerId: REVIEWER,
  } as any);
  expect(result.allowed).toBe(false);
  expect(result.reason).toBe('cannot validate own submission');
});

it('assignee-reviewer on a legacy task with no recorded submitter gets no door', async () => {
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
    description: HASSAN_DESCRIPTION,
  } as any);
  expect(result.allowed).toBe(false);
});

it('a reviewer named only in text does not leak to a different task', async () => {
  const result = await canValidateTask(REVIEWER, 'member', {
    submittedBy: SUBMITTER,
    assigneeId: SUBMITTER,
    assignerId: ASSIGNER,
    description: 'A plain task. Reviewer: Someone Else Entirely.',
  } as any);
  expect(result.allowed).toBe(false);
});
