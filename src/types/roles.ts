// SEDS Pakistan Web Platform - Role Types (Phase 1, spec A.2)
//
// The canonical role taxonomy is the Role Catalog docx (Articles 5-9),
// implemented once in src/lib/role-catalog.ts. This module re-exports the
// catalog key type so `import type { CanonicalRole } from '@/types/roles'`
// keeps working, and holds the adjacent vocabularies that are NOT roles.

import type { CatalogRoleKey } from '@/lib/role-catalog';

export type { CatalogRoleKey };

/** CanonicalRole is now exactly the 40 catalog keys. */
export type CanonicalRole = CatalogRoleKey;

// RoleScope: the legacy two-value operational scope vocabulary.
// 'national' operates across the whole federation; 'chapter' operates
// strictly within one university chapter. The catalog's four-value
// CatalogScope (global | national | chapter | none) lives in
// src/lib/role-catalog.ts; src/lib/scope.ts is the resolver that maps
// between them.
export type RoleScope = 'national' | 'chapter';

/**
 * SiteStatus: membership/application statuses. These were stored in role
 * fields by mistake in places (spec A.2 item 4); they are statuses, never
 * roles, and resolveRole returns "unknown" for all of them.
 */
export type SiteStatus =
  | 'applicant'
  | 'alumni'
  | 'guest'
  | 'crucible_candidate'
  | 'team_member';

// SubsystemTrack: technical subsystem tracks, rendered after assignee
// titles on /admin/tasks.
export type SubsystemTrack =
  | 'propulsion'
  | 'structures'
  | 'avionics'
  | 'robotics'
  | 'materials'
  | 'ground_systems';

// UserRoleProfile: shape of a user role record. The roles/{uid} document
// (schemaVersion 2) is the authoritative form; see
// src/lib/server/role-writes.ts and the Phase 1 interface contract.
// NOTE: subRole was removed in Phase 1 (Catalog Art. 4.6: hierarchy is
// rank only). Stored subRole values were captured by the Wave 1 inventory
// before the schema change.
export interface UserRoleProfile {
  role: CanonicalRole;
  additionalRoles?: CanonicalRole[];
  scope: RoleScope;
  chapterId: string | null;
  subsystemTrack?: SubsystemTrack;
}
