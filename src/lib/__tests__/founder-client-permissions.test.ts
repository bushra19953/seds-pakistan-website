/**
 * @jest-environment node
 *
 * FOUNDER TRANSFER — Family B (client session + hooks).
 *
 * Pins from founder-code-plan.md §2:
 *  - B1: src/firebase/user-provider.tsx no longer manufactures a role for
 *    the founder — the hardcoded founder branch (and its literal
 *    fetchAndInjectOverrides('superadmin') call) is GONE, so the founder
 *    flows through the normal claims / roles/{uid} listener path, which
 *    passes a VARIABLE slug to fetchAndInjectOverrides.
 *  - B2: src/hooks/use-role.ts no longer overrides the founder UID to
 *    'superadmin'; the normal roles/{userId} read returns the stored slug.
 *  - B3: the client permission twin in src/config/permissions.ts grants
 *    'founder_patron' the same blanket as 'superadmin', with NO injected
 *    Firestore overrides (the client half of the absent-docs guarantee).
 *  - B4: every 'superadmin' authority comparison in the three hooks names
 *    'founder_patron' on the same expression (dual recognition).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { ADMIN_PERMISSIONS } from '@/config/permission-registry';

const repoRoot = process.cwd();

function readSource(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), 'utf8');
}

interface ClientPerms {
  hasPermission: (role: string | null, permission: string) => boolean;
  getPermissionsForRole: (role: string | null) => string[];
  permissionsConfig: Record<string, unknown>;
}

/**
 * Load a FRESH copy of src/config/permissions.ts (fresh module registry,
 * so activeRoleOverrides starts empty and no injectRoleOverrides call
 * has happened) — the pattern used by permissions-one-answer.test.ts.
 */
function freshClientPerms(): ClientPerms {
  let client: ClientPerms | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    client = require('@/config/permissions') as ClientPerms;
  });
  if (!client) throw new Error('client permissions module failed to load');
  return client;
}

const REGISTRY_KEYS = Object.keys(ADMIN_PERMISSIONS);

describe('B1 — user-provider founder branch is deleted (source pins)', () => {
  const source = readSource('src/firebase/user-provider.tsx');

  it("contains no 'superadmin' literal anywhere", () => {
    expect(source).not.toContain('superadmin');
  });

  it('contains no founder-UID branch', () => {
    expect(source).not.toContain('FOUNDER_UID');
  });

  it('never calls fetchAndInjectOverrides with a string-literal slug', () => {
    // A literal call would be the manufactured read returning; every call
    // must pass a variable (the claim role or the roles-doc role).
    expect(source).not.toMatch(/fetchAndInjectOverrides\(\s*['"]/);
    // ...and the variable-driven calls of the normal path are still there.
    expect(source).toMatch(/fetchAndInjectOverrides\(claimedRole\)/);
    expect(source).toMatch(/fetchAndInjectOverrides\(newRole\)/);
  });
});

describe('B2 — useRole founder override is deleted (source pin)', () => {
  const source = readSource('src/hooks/use-role.ts');

  it("contains no 'superadmin' literal anywhere", () => {
    expect(source).not.toContain('superadmin');
  });

  it('contains no founder-UID override constant', () => {
    expect(source).not.toContain('FOUNDER_UID');
    expect(source).not.toContain('NEXT_PUBLIC_FIREBASE_FOUNDER_UID');
  });
});

describe('B3 — client permission twin grants founder_patron with nothing injected', () => {
  it('hasPermission(founder_patron, k) is true for every registry key, fresh module, no injection', () => {
    const client = freshClientPerms();
    for (const key of REGISTRY_KEYS) {
      expect(client.hasPermission('founder_patron', key)).toBe(true);
    }
  });

  it('hasPermission(founder_patron, legacy key) is true', () => {
    const client = freshClientPerms();
    expect(client.hasPermission('founder_patron', 'manageTasks')).toBe(true);
  });

  it('hasPermission(superadmin, k) is unchanged (pre-flip pin)', () => {
    const client = freshClientPerms();
    for (const key of REGISTRY_KEYS) {
      expect(client.hasPermission('superadmin', key)).toBe(true);
    }
    expect(client.hasPermission('superadmin', 'manageTasks')).toBe(true);
  });

  it('getPermissionsForRole(founder_patron) returns all config keys', () => {
    const client = freshClientPerms();
    const allKeys = Object.keys(client.permissionsConfig);
    const founderKeys = client.getPermissionsForRole('founder_patron');
    expect(founderKeys).toEqual(allKeys);
    expect(founderKeys).toEqual(client.getPermissionsForRole('superadmin'));
    for (const key of REGISTRY_KEYS) {
      expect(founderKeys).toContain(key);
    }
  });

  it('negative control: the blanket did not widen to ordinary roles', () => {
    const client = freshClientPerms();
    expect(client.hasPermission('member', 'canManagePermissions')).toBe(false);
    expect(client.hasPermission('chapter_president', 'canManagePermissions')).toBe(false);
  });
});

describe('B4 — hook authority comparisons name founder_patron beside superadmin (source pins)', () => {
  const HOOK_FILES = [
    'src/hooks/use-role-permissions.ts',
    'src/hooks/use-authorization.ts',
    'src/hooks/use-contextual-redirect.tsx',
  ];

  for (const relPath of HOOK_FILES) {
    it(`${relPath}: every 'superadmin' comparison also names 'founder_patron' on the same line`, () => {
      const lines = readSource(relPath).split('\n');
      const offending = lines.filter(
        (line) => line.includes("'superadmin'") && !line.includes("'founder_patron'"),
      );
      expect(offending).toEqual([]);
      // Sanity: the file really does carry at least one dual-recognized
      // comparison, so the pin above is not vacuously green.
      const dual = lines.filter(
        (line) => line.includes("=== 'superadmin'") && line.includes("=== 'founder_patron'"),
      );
      expect(dual.length).toBeGreaterThan(0);
    });
  }
});
