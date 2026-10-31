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
 * - superadmin and founder_patron ALWAYS appear in EVERY list
 * - Add new keys here when adding new admin pages
 * - The role-privileges UI reads from this + Firestore overrides
 */

export const permissionsConfig: Record<PermissionKey, UserRole[]> = {
  // ── System ──
  canAccessAdmin: ['superadmin', 'founder_patron'],
  canManagePermissions: ['superadmin', 'founder_patron'],
  canManageUsers: ['superadmin', 'founder_patron'],
  canManageRoles: ['superadmin', 'founder_patron'],

  // ── Oversight ──
  canViewGovernance: ['superadmin', 'founder_patron'],
  canViewAuditLogs: ['superadmin', 'founder_patron'],
  canViewHierarchy: ['superadmin', 'founder_patron'],
  canViewAnalytics: ['superadmin', 'founder_patron'],
  canViewGovernance: ['superadmin', 'founder_patron'],

  // ── Operations ──
  canManageMeetings: ['superadmin', 'founder_patron'],
  canSignMinutes: ['superadmin', 'founder_patron'],
  canManageApplications: ['superadmin', 'founder_patron'],
  canManageCadetships: ['superadmin', 'founder_patron'],
  canManageChapterApplications: ['superadmin', 'founder_patron'],
  canManageProjects: ['superadmin', 'founder_patron'],
  canManageTasks: ['superadmin', 'founder_patron'],
  canManageWorkflows: ['superadmin', 'founder_patron'],
  canManagePrograms: ['superadmin', 'founder_patron'],
  canManageResources: ['superadmin', 'founder_patron'],
  canManageForms: ['superadmin', 'founder_patron'],
  canManageMeetings: ['superadmin', 'founder_patron'],
  canSignMinutes: ['superadmin', 'founder_patron'],

  // ── Content ──
  canManageBlogs: ['superadmin', 'founder_patron'],
  canManageEvents: ['superadmin', 'founder_patron'],
  canManageAnnouncements: ['superadmin', 'founder_patron'],
  canManageTimeline: ['superadmin', 'founder_patron'],
  canManagePages: ['superadmin', 'founder_patron'],
  canManageGallery: ['superadmin', 'founder_patron'],

  // ── Organization ──
  canManageChapters: ['superadmin', 'founder_patron'],
  canManagePositions: ['superadmin', 'founder_patron'],
  canManageBadges: ['superadmin', 'founder_patron'],
  canManageCertificates: ['superadmin', 'founder_patron'],
  canManageSkills: ['superadmin', 'founder_patron'],
  canManageSponsorsPartners: ['superadmin', 'founder_patron'],
  canManageStore: ['superadmin', 'founder_patron'],
  canManageFinance: ['superadmin', 'founder_patron'],
  canApproveMoney: ['superadmin', 'founder_patron'],
  canManageSiteSettings: ['superadmin', 'founder_patron'],
  canManageOrganizations: ['superadmin', 'founder_patron'],
  // ── Vendor shop pilot (BUILD_SPEC Section 3.1) ──
  // The 'vendor' system role holds exactly these four permissions and
  // appears in no other list (in particular not canAccessAdmin or
  // canManageStore).
  canViewOwnVendorProducts: ['superadmin', 'founder_patron', 'vendor'],
  canViewOwnVendorOrders: ['superadmin', 'founder_patron', 'vendor'],
  canUpdateOwnVendorFulfilment: ['superadmin', 'founder_patron', 'vendor'],
  canViewOwnVendorBalance: ['superadmin', 'founder_patron', 'vendor'],
  canManageGovernanceRecords: ['superadmin', 'founder_patron'],
  canApproveGovernanceRecords: ['superadmin', 'founder_patron'],

  // ── Governance (Phase 3 Workstream B) ──
  // Catalog role tokens (Phase 1) resolve through roleDefinitions once
  // seeded; these static fallbacks keep hasServerPermission working
  // before the seed lands. canRunElections is granted to the
  // returning_officer role by Phase 1 role data; per-election actions
  // still require the caller uid to equal the election's
  // returningOfficerUid - the permission is never a substitute.
  canManageElections: ['superadmin', 'founder_patron'],
  canRunElections: ['superadmin', 'founder_patron', 'returning_officer'],
  canManageAgm: ['superadmin', 'founder_patron', 'national_general_secretary'],

  // ── Communication ──
  canViewEmailLogs: ['superadmin', 'founder_patron'],
  canViewUploads: ['superadmin', 'founder_patron'],
  canManageBugReports: ['superadmin', 'founder_patron'],
  canManageDefaulters: ['superadmin', 'founder_patron'],
  canManageInbox: ['superadmin', 'founder_patron'],
};

export function hasPermissionForRole(role: UserRole | null | undefined, permission: PermissionKey): boolean {
  if (!role) return false;
  
  const canonicalRole = normalizeRoleSlug(role);
  if (canonicalRole === 'superadmin' || canonicalRole === 'founder_patron') return true; // superadmin and founder_patron bypass all checks
  
  const allowed = permissionsConfig[permission] || [];
  // Use robust matching for dynamic role handling
  return allowed.some(r => normalizeRoleSlug(r) === canonicalRole);
}

/**
 * Get all permissions for a given role as a readable list.
 */
export function getPermissionsForRole(role: UserRole): { key: PermissionKey; label: string }[] {
  if (role === 'superadmin' || role === 'founder_patron') {
    // Superadmin and founder_patron have ALL permissions
    return (Object.keys(permissionsConfig) as PermissionKey[])
      .map(key => ({ key, label: ADMIN_PERMISSIONS[key]?.label || key }));
  }
  return (Object.keys(permissionsConfig) as PermissionKey[])
    .filter(key => permissionsConfig[key].includes(role))
    .map(key => ({ key, label: ADMIN_PERMISSIONS[key]?.label || key }));
}

