/**
 * restoreRoleViaWritePath conversion tests (side-door item, plan
 * section 3.4 / T-D): the discipline restore adapter must delegate to
 * role-writes assignRole with source 'warning_demotion', preserve the
 * holder's additionalRoles, and keep its non-throwing
 * { ok: false, pending: true } contract on any failure.
 */

jest.mock('@/lib/server/role-writes', () => ({
  assignRole: jest.fn(),
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn() },
}));

import { restoreRoleViaWritePath } from '../adapters';
import { assignRole } from '@/lib/server/role-writes';

const mockAssign = assignRole as jest.Mock;

function makeDb(rolesData: Record<string, unknown> | undefined) {
  return {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () =>
          name === 'roles'
            ? { exists: rolesData !== undefined, id, data: () => rolesData }
            : { exists: false, id, data: () => undefined },
      }),
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAssign.mockResolvedValue({ newEffectiveRole: 'chapter_treasurer' });
});

it('delegates to assignRole once with the snapshot role, stored additionalRoles and warning_demotion source', async () => {
  const db = makeDb({ role: 'member', additionalRoles: ['chapter_design_chair'] });
  const result = await restoreRoleViaWritePath(db, 'user-1', 'chapter_treasurer', {
    actorUid: 'founder-1',
    reason: 'Founder review restore for case case-1',
  });
  expect(result).toEqual({ ok: true });
  expect(mockAssign).toHaveBeenCalledTimes(1);
  expect(mockAssign).toHaveBeenCalledWith(db, {
    uid: 'user-1',
    role: 'chapter_treasurer',
    additionalRoles: ['chapter_design_chair'],
    actorUid: 'founder-1',
    reason: 'Founder review restore for case case-1',
    source: 'warning_demotion',
  });
});

it('a missing roles doc restores with an empty additionalRoles set', async () => {
  const db = makeDb(undefined);
  const result = await restoreRoleViaWritePath(db, 'user-2', 'member', {
    actorUid: 'system',
    reason: 'Probation period ended; restoring pre-probation role',
  });
  expect(result).toEqual({ ok: true });
  expect(mockAssign).toHaveBeenCalledWith(
    db,
    expect.objectContaining({ uid: 'user-2', additionalRoles: [] }),
  );
});

it('an assignRole refusal lands as { ok: false, pending: true } and nothing throws', async () => {
  mockAssign.mockRejectedValue(new Error('Role "gone_role" is not in the catalog'));
  const db = makeDb({ role: 'member', additionalRoles: [] });
  const result = await restoreRoleViaWritePath(db, 'user-3', 'gone_role', {
    actorUid: 'system',
    reason: 'Probation period ended; restoring pre-probation role',
  });
  expect(result).toEqual({ ok: false, pending: true });
});
