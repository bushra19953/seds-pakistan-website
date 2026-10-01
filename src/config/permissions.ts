/**
 * Permissions Bridge
 * ══════════════════
 * Bridges the legacy permission keys (e.g., 'manageTasks') to the canonical
 * permission config (e.g., 'canManageTasks') in permissions.config.ts.
 *
 * Many admin pages still use `hasPermission(role, 'manageTasks')`. Instead of
 * rewriting every page, this module maps old keys → new keys and delegates
 * to the canonical config.
 *
 * NEW CODE should use `hasPermissionForRole(role, 'canManageTasks')` directly
 * from permissions.config.ts or `useAuthorization('canManageTasks')` hook.
 */

import type { UserRole } from '@/lib/roles';
import { ADMIN_PERMISSIONS, type PermissionKey } from './permission-registry';
import { normalizeRoleSlug } from '@/lib/unified-roles';
import { permissionsConfig as canonicalConfig, hasPermissionForRole } from './permissions.config';

export type Role = UserRole;
export { ADMIN_PERMISSIONS };

/**
 * Legacy key → canonical PermissionKey mapping.
 * When hasPermission is called with a legacy key, it's translated here.
 */
const LEGACY_KEY_MAP: Record<string, PermissionKey> = {
  // Audit / Oversight
  viewAuditLogs: 'canViewAuditLogs',
  listAuditLogs: 'canViewAuditLogs',

  // Users / Roles
  assignRoles: 'canManageRoles',
  selfRoleChange: 'canManagePermissions',
  deleteUser: 'canManageUsers',
  adjustUserPoints: 'canManageUsers',
  adjustUserBadges: 'canManageBadges',

  // Applications
  manageApplications: 'canManageApplications',
  listApplications: 'canManageApplications',
  manageAdminApplications: 'canManagePermissions',

  // Projects & Tasks
  manageProjects: 'canManageProjects',
  manageTasks: 'canManageTasks',

  // Content
  manageBlogs: 'canManageBlogs',
  manageOwnBlogs: 'canManageBlogs',
  manageEvents: 'canManageEvents',
  manageWorkshops: 'canManageEvents',
  manageAnnouncements: 'canManageAnnouncements',
  manageGallery: 'canManageGallery',
  canManageGallery: 'canManageGallery',
  managePagesContact: 'canManagePages',
  canManagePages: 'canManagePages',

  // Organization
  manageRoleDefinitions: 'canManageRoles',
  manageTeamMembers: 'canManageUsers',
  manageRoleHistory: 'canManageRoles',
  manageChapters: 'canManageChapters',
  manageOrganizations: 'canManageChapters',
  manageBadges: 'canManageBadges',

  // Events
  listEventRegistrations: 'canManageEvents',
};

/**
 * Dynamic Firestore overrides (injected at runtime by user-provider).
 * These AUGMENT the canonical config — they never restrict.
 */
const activeRoleOverrides: Map<Role, Set<string>> = new Map();

/**
 * Injects dynamic permission overrides from Firestore roleDefinitions.
 * Overrides AUGMENT static permissions — they can only ADD, never remove.
 */
export function injectRoleOverrides(role: Role, customPermissions: string[]) {
  const validPrivileges = new Set<string>();
  for (const p of customPermissions) {
    // Accept both legacy keys and canonical keys
    if (LEGACY_KEY_MAP[p] || Object.keys(canonicalConfig).includes(p)) {
      validPrivileges.add(p);
    }
  }
  activeRoleOverrides.set(role, validPrivileges);
}

// Build the merged permissionsConfig for backward compatibility
// (some code imports permissionsConfig directly from this module)
export const permissionsConfig: Record<string, UserRole[]> = {};

// Copy all canonical config entries
for (const [key, roles] of Object.entries(canonicalConfig)) {
  permissionsConfig[key] = [...roles];
}

// Add all legacy keys pointing to the same role lists
for (const [legacyKey, canonicalKey] of Object.entries(LEGACY_KEY_MAP)) {
  if (!permissionsConfig[legacyKey]) {
    permissionsConfig[legacyKey] = canonicalConfig[canonicalKey] || [];
  }
}

export type Privilege = string;

/**
 * Check if a role has a specific permission.
 * Accepts BOTH legacy keys ('manageTasks') and canonical keys ('canManageTasks').
 * Evaluates: Firestore overrides → canonical config → legacy mapping.
 */
export function hasPermission(userRole: Role | null, requiredPermission: string): boolean {
  if (!userRole) return false;
  
  const canonicalRole = normalizeRoleSlug(userRole);
  
  if (canonicalRole === 'superadmin') return true; // superadmin bypasses all

  // 1. Check Firestore overrides (augment only)
  // We check for both the exact role key and the canonical one for maximum safety
  const exactOverrides = activeRoleOverrides.get(userRole);
  const canonicalOverrides = activeRoleOverrides.get(canonicalRole);
  
  const hasInOverrides = (p: string) => 
    (exactOverrides?.has(p)) || 
    (canonicalOverrides?.has(p)) ||
    (exactOverrides?.has(LEGACY_KEY_MAP[p]!)) || 
    (canonicalOverrides?.has(LEGACY_KEY_MAP[p]!));

  if (hasInOverrides(requiredPermission)) return true;

  // 2. Check canonical config (normalization handled inside hasPermissionForRole)
  if (requiredPermission in canonicalConfig) {
    return hasPermissionForRole(userRole, requiredPermission as PermissionKey);
  }

  // 3. Translate legacy key → canonical key and check
  const canonicalKey = LEGACY_KEY_MAP[requiredPermission];
  if (canonicalKey) {
    return hasPermissionForRole(userRole, canonicalKey);
  }

  // 4. Unknown permission key — deny
  return false;
}

/**
 * List all permissions a given role has (both canonical and legacy).
 */
export function getPermissionsForRole(role: Role | null): string[] {
  if (!role) return [];
  if (role === 'superadmin') return Object.keys(permissionsConfig);
  return Object.keys(permissionsConfig).filter(p => {
    const allowed = permissionsConfig[p];
    return allowed && allowed.includes(role);
  });
}
