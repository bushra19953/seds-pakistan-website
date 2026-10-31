/**
 * ROLE POWER MATRIX HONESTY — regression pins (2026-10-26).
 *
 * The old matrix rendered 28 hardcoded legacy tokens (assignRoles,
 * deleteUser, manageRoleDefinitions, ...) whose cells were raw
 * .includes() checks against the bridge config in
 * src/config/permissions.ts — copies of the tier-3 static lists under
 * alias names, never the keys any gate checks, and never the
 * roleDefinitions grants that actually decide server power.
 *
 * These pins hold the replacement (src/lib/role-power-matrix.ts) to:
 *  1. Row set == the 50 PermissionKeys of the registry, each of which
 *     is a key the static resolver can actually check. No legacy-only
 *     token may ever be a row again.
 *  2. For the wired roles, a matrix row built from a definition array
 *     equals the permissions spec row for that role, key for key.
 *     Fixtures are the granted-key sets from the 2026-10-26 spec
 *     capture (~/workspace/permissions_audit/
 *     role_permissions_spec_2026-10-26.json), fed in as the tier-1
 *     definition arrays the resolver treats as authoritative.
 *  3. With no definition, the row is the static tier and nothing
 *     more: member_basic gets nothing, returning_officer gets only
 *     its one static grant, and a definition array overrides the
 *     static tier instead of merging with it.
 */

import { ADMIN_PERMISSIONS, type PermissionKey } from '@/config/permission-registry';
import { permissionsConfig as staticConfig } from '@/config/permissions.config';
import {
  MATRIX_CATEGORIES,
  MATRIX_PERMISSION_KEYS,
  buildMatrixRow,
  resolveMatrixCell,
  type MatrixDefinitionsBySlug,
} from '@/lib/role-power-matrix';

// The 28 tokens the old matrix hardcoded as rows. Two of them
// (canManageGallery, canManagePages) are also real registry keys and
// stay legal rows; the other 26 are legacy-only aliases.
const OLD_MATRIX_TOKENS = [
  'assignRoles', 'selfRoleChange', 'deleteUser', 'viewAuditLogs', 'listAuditLogs',
  'adjustUserPoints', 'adjustUserBadges', 'manageBadges',
  'manageApplications', 'listApplications', 'manageAdminApplications',
  'manageProjects', 'manageTasks',
  'manageBlogs', 'manageOwnBlogs', 'manageEvents', 'manageWorkshops', 'manageAnnouncements',
  'manageGallery', 'canManageGallery', 'canManagePages', 'managePagesContact',
  'manageRoleDefinitions', 'manageTeamMembers', 'manageRoleHistory',
  'manageChapters', 'manageOrganizations', 'listEventRegistrations',
];

function grantedKeys(role: string, definitions?: MatrixDefinitionsBySlug): string[] {
  const row = buildMatrixRow(role, definitions);
  return MATRIX_PERMISSION_KEYS.filter((k) => row[k].granted).sort();
}

function definitionsFromSpec(spec: Record<string, string[]>): MatrixDefinitionsBySlug {
  return new Map(
    Object.entries(spec).map(([slug, keys]) => [slug, { permissions: [...keys] }]),
  );
}

// Granted-key sets copied from role_permissions_spec_2026-10-26.json.
const SPEC_GRANTED: Record<string, string[]> = {
  chapter_events_chair: [
    'canAccessAdmin', 'canManageAnnouncements', 'canManageEvents', 'canManageMeetings',
    'canManageProjects', 'canManageTasks', 'canManageWorkflows', 'canViewHierarchy',
  ],
  chapter_design_chair: [
    'canAccessAdmin', 'canManageAnnouncements', 'canManageBlogs', 'canManageEvents',
    'canManageGallery', 'canManageMeetings', 'canManageProjects', 'canManageResources',
    'canManageTasks', 'canManageWorkflows', 'canViewHierarchy',
  ],
  national_general_secretary: [
    'canAccessAdmin', 'canManageAgm', 'canManageAnnouncements', 'canManageApplications',
    'canManageEvents', 'canManageGovernanceRecords', 'canManageInbox', 'canManageMeetings',
    'canManagePositions', 'canViewAnalytics', 'canViewHierarchy',
  ],
  returning_officer: ['canAccessAdmin', 'canRunElections'],
};

describe('matrix row set', () => {
  it('is exactly the registry PermissionKeys (50 unique)', () => {
    expect(MATRIX_PERMISSION_KEYS).toHaveLength(50);
    expect(new Set(MATRIX_PERMISSION_KEYS).size).toBe(50);
    expect([...MATRIX_PERMISSION_KEYS].sort()).toEqual(
      Object.keys(ADMIN_PERMISSIONS).sort(),
    );
  });

  it('every row key is checkable: present in the static resolver config', () => {
    for (const key of MATRIX_PERMISSION_KEYS) {
      expect(staticConfig).toHaveProperty(key);
    }
  });

  it('no legacy-only token from the old matrix is a row', () => {
    const registryKeys = new Set<string>(Object.keys(ADMIN_PERMISSIONS));
    for (const token of OLD_MATRIX_TOKENS) {
      if (registryKeys.has(token)) continue; // canManageGallery / canManagePages are real keys
      expect(MATRIX_PERMISSION_KEYS as string[]).not.toContain(token);
    }
  });

  it('categories cover every key exactly once, using registry categories', () => {
    const flat = MATRIX_CATEGORIES.flatMap((c) => c.keys);
    expect([...flat].sort()).toEqual([...MATRIX_PERMISSION_KEYS].sort());
    for (const { category, keys } of MATRIX_CATEGORIES) {
      for (const key of keys) {
        expect(ADMIN_PERMISSIONS[key].category).toBe(category);
      }
    }
  });
});

describe('matrix rows for the wired roles equal the spec rows', () => {
  const definitions = definitionsFromSpec(SPEC_GRANTED);

  for (const [role, expected] of Object.entries(SPEC_GRANTED)) {
    it(`${role}: row == spec row, all cells sourced from the definition`, () => {
      expect(grantedKeys(role, definitions)).toEqual([...expected].sort());
      const row = buildMatrixRow(role, definitions);
      for (const key of MATRIX_PERMISSION_KEYS) {
        expect(row[key].source).toBe('definition');
      }
    });
  }

  it('founder_patron: blanket row is all 50, matching the spec row', () => {
    expect(grantedKeys('founder_patron', definitions)).toHaveLength(50);
  });
});

describe('static tier and tier precedence', () => {
  it('member_basic with no definition holds nothing', () => {
    expect(grantedKeys('member_basic')).toEqual([]);
    expect(grantedKeys('member_basic', new Map())).toEqual([]);
  });

  it('returning_officer with no definition holds only its static grant', () => {
    expect(grantedKeys('returning_officer')).toEqual(['canRunElections']);
    expect(resolveMatrixCell('returning_officer', 'canRunElections').source).toBe('static');
  });

  it('national_general_secretary with no definition holds only its static grant', () => {
    expect(grantedKeys('national_general_secretary')).toEqual(['canManageAgm']);
  });

  it('a definition array is authoritative: it can REMOVE a static grant', () => {
    // Static tier grants returning_officer canRunElections; a tier-1
    // array without it must win, exactly as hasServerPermission does.
    const definitions = definitionsFromSpec({ returning_officer: ['canAccessAdmin'] });
    expect(grantedKeys('returning_officer', definitions)).toEqual(['canAccessAdmin']);
  });

  it('a definition doc without an array falls through to the static tier', () => {
    const definitions: MatrixDefinitionsBySlug = new Map([
      ['returning_officer', { description: 'no permissions field' }],
    ]);
    expect(grantedKeys('returning_officer', definitions)).toEqual(['canRunElections']);
  });

  it('inert stored keys never become rows and never grant a real key', () => {
    // canManageWorkshops exists in live definition data only; it is
    // not a PermissionKey and must not leak into any row.
    const definitions = definitionsFromSpec({
      chapter_events_chair: ['canAccessAdmin', 'canManageEvents', 'canManageWorkshops'],
    });
    expect(grantedKeys('chapter_events_chair', definitions)).toEqual([
      'canAccessAdmin',
      'canManageEvents',
    ]);
  });

  it('custom roles never hold the Reserved Powers, even by definition', () => {
    const definitions = definitionsFromSpec({
      custom_chair_x: ['canManageRoles', 'canManagePermissions', 'canManageTasks'],
    });
    expect(resolveMatrixCell('custom_chair_x', 'canManageRoles' as PermissionKey, definitions).granted).toBe(false);
    expect(resolveMatrixCell('custom_chair_x', 'canManagePermissions' as PermissionKey, definitions).granted).toBe(false);
    expect(resolveMatrixCell('custom_chair_x', 'canManageTasks' as PermissionKey, definitions).granted).toBe(true);
  });
});
