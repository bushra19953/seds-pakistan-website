/**
 * Role Power Matrix data model (honesty fix, 2026-10-26).
 *
 * The matrix used to render 28 hardcoded legacy tokens (assignRoles,
 * deleteUser, manageRoleDefinitions, ...) read out of the bridge config
 * in src/config/permissions.ts. Those tokens are aliases, not checks:
 * no server gate ever tests them by name, and the bridge lists they
 * pointed at are just copies of the tier-3 static fallback, so the
 * screen described neither the keys the code checks nor the grants
 * roleDefinitions actually carry.
 *
 * This module recomputes the matrix from the same inputs the server
 * resolver (hasServerPermission, src/lib/server/permissions.ts) uses:
 *
 *   rows       = the 46 PermissionKeys of src/config/permission-registry.ts
 *                (ADMIN_PERMISSIONS), grouped by the registry's own
 *                category field. No legacy token is ever a row.
 *   tier 1     = a roleDefinitions permissions array for the role is
 *                AUTHORITATIVE when one is supplied (same rule as the
 *                server: array present -> membership decides, no
 *                fallthrough to the static tier).
 *   tier 3     = the static fallback, hasPermissionForRole over
 *                src/config/permissions.config.ts, tried for the
 *                column slug, its normalized slug, its canonical slug,
 *                and (while LEGACY_RESOLUTION_NARROWED is false) every
 *                legacy token that maps to the canonical slug.
 *   blanket    = founder_patron (and the stored token superadmin) hold
 *                every key, checked before tier 1 exactly as the
 *                server checks its candidate set.
 *
 * Known divergence, stated on purpose: tier 2 of the server resolver
 * (the permissions/{role} boolean docs) has no client reader and is
 * NOT consulted here, so a role whose only grant lives in a tier-2
 * doc with no tier-1 array will read lower here than on the server.
 * The matrix banner says so. Custom-role Reserved Powers
 * (canManagePermissions / canManageRoles) are stripped for custom_
 * slugs, matching the server.
 */

import { ADMIN_PERMISSIONS, type PermissionKey } from '@/config/permission-registry';
import { hasPermissionForRole } from '@/config/permissions.config';
import { normalizeRoleSlug } from '@/lib/unified-roles';
import { normalizeUserRole } from '@/lib/roles';
import { LEGACY_TO_CATALOG, LEGACY_RESOLUTION_NARROWED, isCustomRoleSlug } from '@/lib/role-catalog';

/** The 46 real keys, in registry order. This is the matrix row set. */
export const MATRIX_PERMISSION_KEYS: PermissionKey[] = Object.keys(
  ADMIN_PERMISSIONS,
) as PermissionKey[];

/** Rows grouped by the registry's own category labels. */
export const MATRIX_CATEGORIES: { category: string; keys: PermissionKey[] }[] = (() => {
  const groups = new Map<string, PermissionKey[]>();
  for (const key of MATRIX_PERMISSION_KEYS) {
    const category = ADMIN_PERMISSIONS[key].category;
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category)!.push(key);
  }
  return [...groups.entries()].map(([category, keys]) => ({ category, keys }));
})();

/** Minimal shape of a roleDefinitions doc the matrix needs. */
export interface MatrixRoleDefinition {
  permissions?: unknown;
  [key: string]: unknown;
}

export type MatrixDefinitionsBySlug = ReadonlyMap<string, MatrixRoleDefinition>;

export type MatrixCellSource = 'blanket' | 'definition' | 'static';

export interface MatrixCell {
  granted: boolean;
  source: MatrixCellSource;
}

const RESERVED_FOR_CUSTOM: readonly string[] = ['canManagePermissions', 'canManageRoles'];

/**
 * Candidate slugs for a column, in the server's order: canonical slug
 * first, then the raw/normalized slug, then (pre-migration only) every
 * legacy token that maps to the canonical slug. Used for BOTH the
 * tier-1 doc lookup and the tier-3 static check, never to manufacture
 * the blanket for a canonical role (see the header note: the blanket
 * below keys off the column slug itself only).
 */
export function matrixCandidateSlugs(role: string): string[] {
  const legacySlug = normalizeRoleSlug(role);
  const canonicalSlug = normalizeUserRole(legacySlug);
  const slugs: string[] = [];
  const push = (s: string) => {
    if (s && !slugs.includes(s)) slugs.push(s);
  };
  if (isCustomRoleSlug(legacySlug)) {
    push(legacySlug);
    if (canonicalSlug !== legacySlug) push(canonicalSlug);
    return slugs;
  }
  push(canonicalSlug);
  if (legacySlug !== canonicalSlug) push(legacySlug);
  if (!LEGACY_RESOLUTION_NARROWED) {
    for (const [legacy, catalog] of Object.entries(LEGACY_TO_CATALOG)) {
      if (catalog === canonicalSlug) push(legacy);
    }
  }
  return slugs;
}

/** Resolve one matrix cell from the supplied resolution inputs. */
export function resolveMatrixCell(
  role: string,
  key: PermissionKey,
  definitions?: MatrixDefinitionsBySlug,
): MatrixCell {
  const columnSlug = normalizeRoleSlug(role);

  // Custom-role Reserved Powers strip (server SEC-03 point 4 parity).
  if (isCustomRoleSlug(columnSlug) && RESERVED_FOR_CUSTOM.includes(key)) {
    return { granted: false, source: 'definition' };
  }

  // Blanket: the column role itself is a blanket token.
  if (columnSlug === 'superadmin' || columnSlug === 'founder_patron') {
    return { granted: true, source: 'blanket' };
  }

  const candidates = matrixCandidateSlugs(role);

  // Tier 1: first candidate with a definition doc wins; an array on
  // the winning doc is authoritative (server semantics, verbatim).
  if (definitions) {
    for (const slug of candidates) {
      const doc = definitions.get(slug);
      if (!doc) continue;
      if (Array.isArray(doc.permissions)) {
        if ((doc.permissions as unknown[]).includes(key)) {
          return { granted: true, source: 'definition' };
        }
        if (typeof doc[key] === 'boolean') {
          return { granted: doc[key] as boolean, source: 'definition' };
        }
        return { granted: false, source: 'definition' };
      }
      // A winning doc without an array does not decide; the server
      // falls through to its tier 2, which the client cannot read,
      // so the matrix falls through to the static tier and the
      // banner discloses the tier-2 gap.
      break;
    }
  }

  // Tier 3: static fallback over every candidate slug.
  const granted = candidates.some((slug) => hasPermissionForRole(slug as never, key));
  return { granted, source: 'static' };
}

/** One full matrix row: every registry key resolved for one role. */
export function buildMatrixRow(
  role: string,
  definitions?: MatrixDefinitionsBySlug,
): Record<PermissionKey, MatrixCell> {
  const row = {} as Record<PermissionKey, MatrixCell>;
  for (const key of MATRIX_PERMISSION_KEYS) {
    row[key] = resolveMatrixCell(role, key, definitions);
  }
  return row;
}

/** Granted count / total for a role, for the honest power bar. */
export function matrixPowerPercent(
  role: string,
  definitions?: MatrixDefinitionsBySlug,
): number {
  const row = buildMatrixRow(role, definitions);
  const granted = MATRIX_PERMISSION_KEYS.filter((k) => row[k].granted).length;
  return Math.round((granted / MATRIX_PERMISSION_KEYS.length) * 100);
}
