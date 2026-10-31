/**
 * @jest-environment node
 *
 * Vendor shop pilot, GB (PLAN-gb Sections 2 and 10.1): the vendor
 * system-role mechanism. Spec test P2 (server half and client half)
 * plus the grant's exact shape.
 *
 * Uses the REAL hasServerPermission / hasServerPermissionForUser /
 * assignRole against the in-memory fake Firestore, because mocking
 * the seam would mock away the mechanism under test.
 *
 * Fixtures only: vendor uid 'vendor-user-1', admin uid 'admin-1',
 * business name "Fixture Electronics". No production data.
 */

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  admin: {
    firestore: {
      FieldValue: { serverTimestamp: () => 'ts', delete: () => 'del' },
    },
  },
}));

import { FakeFirestore } from '../../__tests__/helpers/fake-firestore';
import {
  hasServerPermission,
  hasServerPermissionForUser,
  resolveHolderRoles,
} from '../permissions';
import { assignRole, RoleWriteError } from '../role-writes';
import { permissionsConfig, hasPermissionForRole } from '@/config/permissions.config';
import { hasPermission } from '@/config/permissions';
import { VENDOR_PERMISSION_KEYS } from '@/lib/vendor-role';
import type { PermissionKey } from '@/config/permissions.config';

const VENDOR_UID = 'vendor-user-1';
const ADMIN = 'admin-1';
const REASON = 'Vendor pilot grant for vendor record fixture-vendor-1';
const FOUR_KEYS = [...VENDOR_PERMISSION_KEYS] as PermissionKey[];

function vendorDefinition(permissions: string[] = [...FOUR_KEYS]) {
  return {
    slug: 'vendor',
    name: 'Vendor',
    title: 'Vendor',
    permissions,
    isCustom: false,
    isActive: true,
    seededFromCatalog: false,
    systemRole: true,
  };
}

let fake: FakeFirestore;
beforeEach(() => {
  fake = new FakeFirestore();
  mockDbHolder.db = fake.asDb();
});

describe('vendor holder permissions (P2, server half)', () => {
  function seedVendorHolder() {
    fake.seed('roles', VENDOR_UID, { role: 'member_basic', additionalRoles: ['vendor'] });
    fake.seed('users', VENDOR_UID, { role: 'member_basic' });
    fake.seed('roleDefinitions', 'vendor', vendorDefinition());
  }

  it('vendor holder passes exactly the four vendor permissions', async () => {
    seedVendorHolder();
    for (const key of FOUR_KEYS) {
      await expect(
        hasServerPermissionForUser(fake.asDb(), VENDOR_UID, key),
      ).resolves.toBe(true);
    }
  });

  it('vendor holder fails canManageStore, canAccessAdmin, canManageRoles and canManageFinance', async () => {
    seedVendorHolder();
    for (const key of ['canManageStore', 'canAccessAdmin', 'canManageRoles', 'canManageFinance'] as PermissionKey[]) {
      await expect(
        hasServerPermissionForUser(fake.asDb(), VENDOR_UID, key),
      ).resolves.toBe(false);
    }
  });

  it('member without the vendor grant fails all four vendor permissions', async () => {
    fake.seed('roles', VENDOR_UID, { role: 'member_basic', additionalRoles: [] });
    fake.seed('users', VENDOR_UID, { role: 'member_basic' });
    fake.seed('roleDefinitions', 'vendor', vendorDefinition());
    for (const key of FOUR_KEYS) {
      await expect(
        hasServerPermissionForUser(fake.asDb(), VENDOR_UID, key),
      ).resolves.toBe(false);
    }
  });

  it('resolveHolderRoles surfaces the vendor grant as a system role only when held', async () => {
    seedVendorHolder();
    const holder = await resolveHolderRoles(fake.asDb(), VENDOR_UID);
    expect(holder.role).toBe('member_basic');
    expect(holder.customRoles).toEqual([]);
    expect(holder.systemRoles).toEqual(['vendor']);
  });
});

describe('vendor subject resolution', () => {
  it('vendor slug in the static config maps to no other permission', () => {
    const keysWithVendor = (Object.entries(permissionsConfig) as Array<[PermissionKey, string[]]>)
      .filter(([, roles]) => roles.includes('vendor'))
      .map(([key]) => key)
      .sort();
    expect(keysWithVendor).toEqual([...FOUR_KEYS].sort());
  });

  it('raw vendor token resolves through the static config when no definition doc exists', async () => {
    // No roleDefinitions/vendor seeded: the static config is the
    // fallback and the grant still resolves (MERGE_PLAN 3.9 check).
    for (const key of FOUR_KEYS) {
      await expect(hasServerPermission('vendor', key)).resolves.toBe(true);
    }
    await expect(hasServerPermission('vendor', 'canManageStore')).resolves.toBe(false);
  });

  it('raw vendor token resolves through its own definition, not the member_basic floor', async () => {
    // The Section 1 point 2 regression pin: a member_basic definition
    // WITH a permissions array must not shadow the vendor subject.
    fake.seed('roleDefinitions', 'member_basic', { name: 'Basic Member', permissions: [] });
    fake.seed('roleDefinitions', 'vendor', vendorDefinition());
    await expect(hasServerPermission('vendor', 'canViewOwnVendorOrders')).resolves.toBe(true);
    await expect(hasServerPermission('vendor', 'canManageTasks')).resolves.toBe(false);
  });

  it('a widened vendor definition cannot mint Reserved Powers at resolution time', async () => {
    fake.seed('roleDefinitions', 'vendor', vendorDefinition([...FOUR_KEYS, 'canManageRoles']));
    await expect(hasServerPermission('vendor', 'canManageRoles')).resolves.toBe(false);
    await expect(hasServerPermission('vendor', 'canManagePermissions')).resolves.toBe(false);
  });
});

describe('client bridge (P2, client half)', () => {
  it('client bridge denies the vendor role every admin permission', () => {
    expect(hasPermission('member_basic', 'canManageStore')).toBe(false);
    expect(hasPermission('vendor', 'canManageStore')).toBe(false);
    expect(hasPermissionForRole('vendor', 'canManageStore')).toBe(false);
    expect(hasPermissionForRole('vendor', 'canAccessAdmin')).toBe(false);
    for (const key of FOUR_KEYS) {
      expect(hasPermissionForRole('vendor', key)).toBe(true);
    }
  });
});

describe('the grant write path', () => {
  beforeEach(() => {
    fake.seed('users', VENDOR_UID, { displayName: 'Fixture Vendor User' });
    fake.seed('roleDefinitions', 'vendor', vendorDefinition());
  });

  it('assignRole stores vendor last, after the catalog partition, preserving the primary', async () => {
    const result = await assignRole(fake.asDb(), {
      uid: VENDOR_UID,
      role: 'member_basic',
      additionalRoles: ['vendor', 'chapter_events_chair'],
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
    });
    expect(result.roleDoc.additionalRoles).toEqual(['chapter_events_chair', 'vendor']);
    const stored = fake.read('roles', VENDOR_UID);
    expect(stored?.role).toBe('member_basic');
    expect(stored?.additionalRoles).toEqual(['chapter_events_chair', 'vendor']);
  });

  it('existing docs without a vendor entry produce byte-identical stored arrays', async () => {
    await assignRole(fake.asDb(), {
      uid: VENDOR_UID,
      role: 'member_basic',
      additionalRoles: ['chapter_events_chair'],
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
    });
    expect(fake.read('roles', VENDOR_UID)?.additionalRoles).toEqual(['chapter_events_chair']);
  });

  it('widened vendor definition fails assignment validation', async () => {
    fake.seed('roleDefinitions', 'vendor', vendorDefinition([...FOUR_KEYS, 'canManageStore']));
    let caught: unknown = null;
    try {
      await assignRole(fake.asDb(), {
        uid: VENDOR_UID,
        role: 'member_basic',
        additionalRoles: ['vendor'],
        actorUid: ADMIN,
        reason: REASON,
        source: 'admin_ui',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RoleWriteError);
    expect((caught as RoleWriteError).code).toBe('system_role_definition_invalid');
    expect(fake.read('roles', VENDOR_UID)).toBeUndefined();
  });

  it('missing vendor definition fails assignment with unknown_role', async () => {
    const bare = new FakeFirestore();
    mockDbHolder.db = bare.asDb();
    bare.seed('users', VENDOR_UID, { displayName: 'Fixture Vendor User' });
    let caught: unknown = null;
    try {
      await assignRole(bare.asDb(), {
        uid: VENDOR_UID,
        role: 'member_basic',
        additionalRoles: ['vendor'],
        actorUid: ADMIN,
        reason: REASON,
        source: 'admin_ui',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RoleWriteError);
    expect((caught as RoleWriteError).code).toBe('unknown_role');
  });

  it('an expiry naming the vendor slug is refused as invalid_expiry', async () => {
    let caught: unknown = null;
    try {
      await assignRole(fake.asDb(), {
        uid: VENDOR_UID,
        role: 'member_basic',
        additionalRoles: ['vendor'],
        actorUid: ADMIN,
        reason: REASON,
        source: 'admin_ui',
        expiresAt: new Date('2027-01-01T00:00:00.000Z'),
        expiresRoleKey: 'vendor',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RoleWriteError);
    expect((caught as RoleWriteError).code).toBe('invalid_expiry');
  });
});
