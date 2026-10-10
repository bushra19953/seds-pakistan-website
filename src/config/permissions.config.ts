import type { UserRole } from '@/lib/roles';
import { type PermissionKey, ADMIN_PERMISSIONS } from './permission-registry';
import { normalizeRoleSlug } from '@/lib/unified-roles';

export type { PermissionKey };

/**
 * CANONICAL PERMISSIONS CONFIG
 * ════════════════════════════
 * Which roles have each permission by default.
 * This is the SINGLE SOURCE OF TRUTH for all permission checks.
 *
 * Rules:
 * - superadmin ALWAYS appears in EVERY list
 * - Add new keys here when adding new admin pages
 * - The role-privileges UI reads from this + Firestore overrides
 */

export const permissionsConfig: Record<PermissionKey, UserRole[]> = {
  // ── System ──
  canAccessAdmin: ['superadmin'],
  canManagePermissions: ['superadmin'],
  canManageUsers: ['superadmin'],
  canManageRoles: ['superadmin'],

  // ── Oversight ──
  canViewAuditLogs: ['superadmin'],
  canViewHierarchy: ['superadmin'],
  canViewAnalytics: ['superadmin'],

  // ── Operations ──
  canManageApplications: ['superadmin'],
  canManageChapterApplications: ['superadmin'],
  canManageProjects: ['superadmin'],
  canManageTasks: ['superadmin'],
  canManageWorkflows: ['superadmin'],
  canManagePrograms: ['superadmin'],
  canManageResources: ['superadmin'],
  canManageForms: ['superadmin'],

  // ── Content ──
  canManageBlogs: ['superadmin'],
  canManageEvents: ['superadmin'],
  canManageAnnouncements: ['superadmin'],
  canManageTimeline: ['superadmin'],
  canManagePages: ['superadmin'],
  canManageGallery: ['superadmin'],

  // ── Organization ──
  canManageChapters: ['superadmin'],
  canManagePositions: ['superadmin'],
  canManageBadges: ['superadmin'],
  canManageCertificates: ['superadmin'],
  canManageSkills: ['superadmin'],
  canManageSponsorsPartners: ['superadmin'],
  canManageStore: ['superadmin'],
  canManageSiteSettings: ['superadmin'],
  canManageOrganizations: ['superadmin'],

  // ── Communication ──
  canViewEmailLogs: ['superadmin'],
  canViewUploads: ['superadmin'],
  canManageBugReports: ['superadmin'],
  canManageDefaulters: ['superadmin'],
  canManageInbox: ['superadmin'],
};

export function hasPermissionForRole(role: UserRole | null | undefined, permission: PermissionKey): boolean {
  if (!role) return false;
  
  const canonicalRole = normalizeRoleSlug(role);
  if (canonicalRole === 'superadmin') return true; // superadmin bypasses all checks
  
  const allowed = permissionsConfig[permission] || [];
  // Use robust matching for dynamic role handling
  return allowed.some(r => normalizeRoleSlug(r) === canonicalRole);
}

/**
 * Get all permissions for a given role as a readable list.
 */
export function getPermissionsForRole(role: UserRole): { key: PermissionKey; label: string }[] {
  if (role === 'superadmin') {
    // Superadmin has ALL permissions
    return (Object.keys(permissionsConfig) as PermissionKey[])
      .map(key => ({ key, label: ADMIN_PERMISSIONS[key]?.label || key }));
  }
  return (Object.keys(permissionsConfig) as PermissionKey[])
    .filter(key => permissionsConfig[key].includes(role))
    .map(key => ({ key, label: ADMIN_PERMISSIONS[key]?.label || key }));
}

