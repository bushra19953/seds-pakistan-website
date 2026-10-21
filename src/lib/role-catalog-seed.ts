/**
 * roleDefinitions seed built mechanically from ROLE_CATALOG (spec A.7).
 *
 * The seed writes descriptive fields only and NEVER a permissions field:
 * the permissions workstream owns grants in the same docs. Seeding is
 * merge-only, so re-running after a catalog amendment updates descriptions
 * without overwriting grants.
 */

import { ROLE_CATALOG, type CatalogRole } from './role-catalog';

export const CATALOG_VERSION = '2026-10-20';

export interface RoleDefinitionSeed {
  slug: string;
  name: string;
  title: string;
  rank: string;
  xp: number;
  category: string;
  scope: string;
  appointedBy: string;
  seats: number | 'multi' | null;
  catalogVersion: string;
  seededFromCatalog: true;
}

export function buildRoleDefinitionSeed(role: CatalogRole): RoleDefinitionSeed {
  return {
    slug: role.key,
    name: role.title,
    title: role.title,
    rank: role.rank,
    xp: role.xp,
    category: role.category,
    scope: role.scope,
    appointedBy: role.appointedBy,
    seats: role.seats,
    catalogVersion: CATALOG_VERSION,
    seededFromCatalog: true,
  };
}

export function buildAllRoleDefinitionSeeds(): RoleDefinitionSeed[] {
  return ROLE_CATALOG.map(buildRoleDefinitionSeed);
}
