/**
 * @jest-environment node
 *
 * Permission-parity (Family E, E15): canValidateTask fallback arm 4 must
 * resolve the caller's held roles from callerUid via
 * hasServerPermissionForUser, so a caller whose ONLY path is a custom
 * canManageTasks grant (primary `member`, additionalRoles
 * ['custom_verify_design_aide']) can validate. Arm 1 (self-validation
 * denial) is unchanged. Real resolver + real hierarchy helper against an
 * in-memory Firestore.
 */
const HOLDER = 'holder-1';
const CUSTOM = 'custom_verify_design_aide';

const mockDbHolder: { db: unknown } = { db: null };

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  admin: { firestore: { FieldValue: { serverTimestamp: () => 'ts' } } },
}));

import { FakeFirestore } from '@/lib/__tests__/helpers/fake-firestore';
import { canValidateTask } from '../hierarchy';

let fake: FakeFirestore;

beforeEach(() => {
  fake = new FakeFirestore();
  mockDbHolder.db = fake.asDb();
  fake.seed('roles', HOLDER, { role: 'member', additionalRoles: [CUSTOM] });
  fake.seed('roleDefinitions', CUSTOM, { isCustom: true, permissions: ['canManageTasks'] });
  // Submitter exists with no manager: the chain walk resolves empty, so
  // arms 2 (chain) and 3 (assigner) cannot grant — arm 4 is the only path.
  fake.seed('users', 'submitter-1', { displayName: 'Submitter' });
});

it('caller whose only path is the custom grant validates via arm 4', async () => {
  const result = await canValidateTask(HOLDER, 'member', {
    submittedBy: 'submitter-1',
    assigneeId: 'submitter-1',
    assignerId: 'someone-else',
  } as any);
  expect(result.allowed).toBe(true);
  expect(result.via).toBe('role');
});

it('caller without the grant does not validate via arm 4', async () => {
  fake.seed('roles', HOLDER, { role: 'member', additionalRoles: [] });
  const result = await canValidateTask(HOLDER, 'member', {
    submittedBy: 'submitter-1',
    assigneeId: 'submitter-1',
    assignerId: 'someone-else',
  } as any);
  expect(result.allowed).toBe(false);
});

it('arm 1 unchanged: self-validation is denied even for the grant holder', async () => {
  const result = await canValidateTask(HOLDER, 'member', {
    submittedBy: HOLDER,
    assigneeId: HOLDER,
    assignerId: 'someone-else',
  } as any);
  expect(result.allowed).toBe(false);
  expect(result.reason).toBe('cannot validate own submission');
});
