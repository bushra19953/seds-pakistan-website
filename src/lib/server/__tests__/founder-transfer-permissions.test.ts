/**
 * @jest-environment node
 *
 * FOUNDER TRANSFER - Family A (server permission core, dual recognition).
 *
 * Pins the code plan section 1 / section 6 absent-docs matrix:
 * with NO grant docs present at all (no roleDefinitions, no permissions,
 * no role_permissions for either token), `founder_patron` and the legacy
 * `superadmin` token both resolve, `founder_patron` is global-scoped in
 * both scope systems, and the blanket does not widen to ordinary roles.
 * `superadmin` loses nothing: this is dual recognition, not retirement.
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
  isChapterScopedRole,
} from '../permissions';
import {
  hasPermissionForRole,
  getPermissionsForRole,
  permissionsConfig,
  type PermissionKey,
} from '@/config/permissions.config';
import { ADMIN_PERMISSIONS, getRoleScope } from '@/config/permission-registry';

const ALL_KEYS = Object.keys(ADMIN_PERMISSIONS) as PermissionKey[];
const CONFIG_KEYS = Object.keys(permissionsConfig) as PermissionKey[];

describe('A1 blanket-true dual recognition (absent-docs matrix)', () => {
  let fake: FakeFirestore;
  beforeEach(() => {
    // EMPTY store: no roleDefinitions/*, no permissions/*, no
    // role_permissions/* docs for founder_patron or superadmin at all.
    fake = new FakeFirestore();
    mockDbHolder.db = fake.asDb();
  });

  it('founder_patron resolves true for every registry key with zero grant docs', async () => {
    for (const key of ALL_KEYS) {
      await expect(hasServerPermission('founder_patron', key)).resolves.toBe(true);
    }
  });

  it('founder_patron is not stripped of the Reserved Powers (strip is custom-only)', async () => {
    await expect(hasServerPermission('founder_patron', 'canManagePermissions')).resolves.toBe(true);
    await expect(hasServerPermission('founder_patron', 'canManageRoles')).resolves.toBe(true);
  });

  it('superadmin still resolves pre-flip on the same empty store', async () => {
    for (const key of ALL_KEYS) {
      await expect(hasServerPermission('superadmin', key)).resolves.toBe(true);
    }
  });

  it('chief_technology_officer still blanket-passes via reverse expansion (T9 regression pin)', async () => {
    for (const key of ALL_KEYS) {
      await expect(hasServerPermission('chief_technology_officer', key)).resolves.toBe(true);
    }
  });

  it('super_admin still blanket-passes via reverse expansion', async () => {
    for (const key of ALL_KEYS) {
      await expect(hasServerPermission('super_admin', key)).resolves.toBe(true);
    }
  });

  it('negative control: the blanket did not widen to ordinary roles', async () => {
    await expect(hasServerPermission('member', 'canManagePermissions')).resolves.toBe(false);
    await expect(hasServerPermission('chapter_president', 'canManagePermissions')).resolves.toBe(false);
  });

  it('DB-absent path: both blanket tokens still return true when getDb() is null', async () => {
    mockDbHolder.db = null;
    await expect(hasServerPermission('founder_patron', 'canManagePermissions')).resolves.toBe(true);
    await expect(hasServerPermission('founder_patron', 'canManageTasks')).resolves.toBe(true);
    await expect(hasServerPermission('superadmin', 'canManagePermissions')).resolves.toBe(true);
    await expect(hasServerPermission('superadmin', 'canManageTasks')).resolves.toBe(true);
  });

  it('holder path: a stored founder_patron primary resolves via hasServerPermissionForUser with no grant docs', async () => {
    fake.seed('roles', 'founder-holder', { role: 'founder_patron' });
    for (const key of ALL_KEYS) {
      await expect(
        hasServerPermissionForUser(fake.asDb(), 'founder-holder', key),
      ).resolves.toBe(true);
    }
  });
});

describe('A2 GLOBAL_ROLES', () => {
  it('founder_patron is global (not chapter-scoped)', () => {
    expect(isChapterScopedRole('founder_patron')).toBe(false);
  });
  it('superadmin stays global', () => {
    expect(isChapterScopedRole('superadmin')).toBe(false);
  });
  it('chapter_president stays chapter-scoped', () => {
    expect(isChapterScopedRole('chapter_president')).toBe(true);
  });
  it('null defaults to scoped (least privilege)', () => {
    expect(isChapterScopedRole(null)).toBe(true);
  });
});

describe('A3 static config twin (permissions.config)', () => {
  it('hasPermissionForRole founder_patron is true for every registry key', () => {
    for (const key of ALL_KEYS) {
      expect(hasPermissionForRole('founder_patron', key)).toBe(true);
    }
  });

  it('hasPermissionForRole superadmin is unchanged (true for every registry key)', () => {
    for (const key of ALL_KEYS) {
      expect(hasPermissionForRole('superadmin', key)).toBe(true);
    }
  });

  it('every allow-list names founder_patron beside superadmin', () => {
    for (const key of CONFIG_KEYS) {
      expect(permissionsConfig[key]).toContain('superadmin');
      expect(permissionsConfig[key]).toContain('founder_patron');
    }
  });

  it('getPermissionsForRole founder_patron returns every config key', () => {
    const got = getPermissionsForRole('founder_patron').map((p) => p.key);
    expect(new Set(got)).toEqual(new Set(CONFIG_KEYS));
  });

  it('getPermissionsForRole superadmin still returns every config key', () => {
    const got = getPermissionsForRole('superadmin').map((p) => p.key);
    expect(new Set(got)).toEqual(new Set(CONFIG_KEYS));
  });

  it('getPermissionsForRole member does not gain keys', () => {
    const got = getPermissionsForRole('member').map((p) => p.key);
    expect(got).not.toContain('canManagePermissions');
    expect(got).not.toContain('canManageRoles');
    expect(got.length).toBeLessThan(CONFIG_KEYS.length);
  });
});

describe('A4 DEFAULT_ROLE_SCOPES', () => {
  it("getRoleScope('founder_patron') is 'global'", () => {
    expect(getRoleScope('founder_patron')).toBe('global');
  });
  it("getRoleScope('superadmin') stays 'global'", () => {
    expect(getRoleScope('superadmin')).toBe('global');
  });
});
