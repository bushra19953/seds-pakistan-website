/**
 * Role management utilities for SEDS Pakistan website with new organizational hierarchy
 */

// New organizational hierarchy
export type UserRole = string; // Relaxed from enum to string for dynamic roles

export interface RoleAssignment {
  uid: string;
  role: UserRole;
  assignedAt: Date;
  assignedBy?: string;
}

export const USER_ROLES: Record<string, string> = {
  superadmin: 'Super Admin',
  president_national: 'Pakistan President',
};

export const ROLES = {
  SUPERADMIN: 'superadmin',
  PRESIDENT_NATIONAL: 'president_national',
};

export const ROLE_HIERARCHY: Record<UserRole, number> = {
  superadmin: 11,
  president_national: 10,
};

/**
 * Check if a user has sufficient role privileges
 * @param userRole The role of the user
 * @param requiredRole The minimum required role
 * @returns boolean indicating if user has sufficient privileges
 */
export function hasSufficientRole(userRole: UserRole, requiredRole: UserRole): boolean {
  // Superadmin always passes
  if (userRole === 'superadmin') return true;
  const userLevel = ROLE_HIERARCHY[userRole as keyof typeof ROLE_HIERARCHY] ?? 1;
  const requiredLevel = ROLE_HIERARCHY[requiredRole as keyof typeof ROLE_HIERARCHY] ?? 1;
  return userLevel >= requiredLevel;
}

export const FOUNDER_UID = 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';

/**
 * Check if a user is the absolute Founder (Dictator)
 */
export function isFounder(uid: string): boolean {
  return uid === FOUNDER_UID;
}

/**
 * Get the display name for a role
 * @param role The role to get display name for
 * @param userUid Optional UID to check for Founder override
 * @returns The display name of the role
 */
export function getRoleDisplayName(role: UserRole, userUid?: string): string {
  // 1. ABSOLUTE IDENTITY: Only the Founder is the Pakistan President
  if (userUid === FOUNDER_UID) {
    return 'Pakistan President';
  }
  
  if (!role) return 'Guest';

  // Junk-data guard: a truthy non-string role (malformed Firestore doc) must
  // not reach .split() below, which would crash the rendering page.
  if (typeof role !== 'string') return 'Guest';

  // 2. EXCLUSIVITY FILTER: No one else can display 'Pakistan President'
  // If a role was somehow assigned with this slug, we rename it for display.
  if (role === 'president_national' || role === 'superadmin') {
    return 'Chapter Advisor';
  }

  // Check hardcoded map first, then return formatted slug as fallback
  const hardcoded = USER_ROLES[role as keyof typeof USER_ROLES];
  if (hardcoded) return hardcoded;
  
  // Convert slug (e.g., 'marketing_lead') to 'Marketing Lead'
  return role.split(/[_-]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Check if a user is a president (National or Founder)
 * @param userRole The role of the user
 * @param userUid The UID of the user
 * @returns boolean indicating if user is president
 */
export function isPresident(userRole: UserRole, userUid: string): boolean {
  if (userUid === FOUNDER_UID) return true;
  return userRole === 'president_national';
}

/**
 * Check if a user is superadmin (Executive Authority)
 * SOLE AUTHORITY: Only the Founder UID possesses Superadmin power.
 * The 'superadmin' role string is ignored for all other UIDs.
 * 
 * UPDATE: Equality of Power - both 'superadmin' and 'president_national'
 * are treated as peer executive roles for permission configuration.
 */
export function isSuperAdmin(userRole: UserRole | null, userUid: string): boolean {
  if (userUid === FOUNDER_UID) return true;
  return userRole === 'superadmin' || userRole === 'president_national';
}

/**
 * Determine if a role has recruitment admin access for induction applications.
 * Checks hardcoded list first, then falls through to dynamic permission system.
 */
export function hasRecruitmentAccess(userRole: UserRole): boolean {
  if (userRole === 'superadmin' || userRole === 'president_national') return true;
  // Dynamic roles get access via the permission system (canManageApplications)
  // This is checked at the component level via useAuthorization, so return false here
  // to keep this function as a fast check for known roles.
  return false;
}

/**
 * Determine if a role should see site-wide Admin navigation/tools.
 * Checks hardcoded leadership list + any role in ROLE_HIERARCHY with level >= 7.
 * Dynamic roles with canAccessAdmin permission are handled by the permission system.
 */
export function hasSiteAdminAccess(userRole: UserRole): boolean {
  if (userRole === 'superadmin' || userRole === 'president_national') return true;
  
  // For dynamic roles: check hierarchy level if it exists
  const level = ROLE_HIERARCHY[userRole as keyof typeof ROLE_HIERARCHY];
  if (level !== undefined && level >= 7) return true;
  // Dynamic roles without hierarchy level are handled by the permission system
  // (useAuthorization('canAccessAdmin') in admin layout). Return false here.
  return false;
}

// Canonical RBAC (SEDS-DEV-SPEC-RBAC-2026-V1.0) - additive, legacy exports above unchanged

import type { CanonicalRole, RoleScope } from '@/types/roles';

/**
 * Backward-compatibility map: 27 legacy role tokens observed in the codebase
 * (Firestore user docs, API routes, permission checks) mapped to their
 * canonical taxonomy roles. Tokens already canonical are left untouched.
 */
export const LEGACY_ROLE_MAP: Record<string, CanonicalRole> = {
  president: 'president_national',
  presidential_national: 'president_national',
  pakistan_president: 'president_national',
  pakistan_national_president: 'president_national',
  national_vice_president: 'national_vp_operations',
  vice_president: 'chapter_vp_operations',
  vp: 'chapter_vp_operations',
  admin: 'developer',
  president_chapter: 'chapter_president',
  marketing_head: 'national_vp_marketing',
  marketingoutreach_head: 'chapter_vp_marketing',
  marketing_lead: 'chapter_vp_marketing',
  chair_marketing: 'chapter_vp_marketing',
  chair_marketing_communications: 'chapter_vp_marketing',
  projects_director: 'national_vp_engineering',
  chair_projects: 'chapter_vp_technical',
  chair_projects_committee: 'chapter_vp_technical',
  hr_director: 'national_vp_membership',
  hr_or_membership_director: 'national_vp_membership',
  chair_recruitment: 'national_vp_membership',
  chair_recruitment_membership: 'national_vp_membership',
  general_secretary: 'chapter_general_secretary',
  secretary: 'chapter_general_secretary',
  treasurer: 'chapter_treasurer',
  advisor: 'chapter_faculty_advisor',
  advisor_faculty_head: 'chapter_faculty_advisor',
  member: 'team_member',
};

const NATIONAL_EXECUTIVE_ROLES: CanonicalRole[] = [
  'president_national',
  'national_vp_engineering',
  'national_vp_operations',
  'national_vp_marketing',
  'national_vp_finance',
  'national_vp_membership',
];

const CHAPTER_EXECUTIVE_ROLES: CanonicalRole[] = [
  'chapter_president',
  'chapter_vp_technical',
  'chapter_vp_operations',
  'chapter_vp_marketing',
  'chapter_treasurer',
  'chapter_general_secretary',
  'chapter_faculty_advisor',
];

const SUBSYSTEM_LEAD_ROLES: CanonicalRole[] = [
  'lead_propulsion',
  'lead_structures',
  'lead_avionics',
  'lead_robotics',
  'lead_materials',
  'lead_ground_systems',
];

/**
 * Normalize any stored or incoming role token to its canonical role.
 * Lookup is case-insensitive and trims whitespace. Unknown tokens pass
 * through unchanged; empty input falls back to 'guest'.
 */
export function normalizeUserRole(role: string | null | undefined): CanonicalRole {
  const key = (role || '').trim().toLowerCase();
  if (!key) return 'guest';
  const mapped = LEGACY_ROLE_MAP[key];
  if (mapped) return mapped;
  return key as CanonicalRole;
}

/**
 * Resolve the organizational scope for a canonical role.
 * National scope covers the federation headquarters: platform owners,
 * the National Executive Council, subsystem leads, and senior advisors.
 * Everything else operates within a collegiate chapter.
 */
export function resolveUserScope(role: CanonicalRole): RoleScope {
  if (role === 'superadmin' || role === 'developer' || role === 'senior_advisor') {
    return 'national';
  }
  if (NATIONAL_EXECUTIVE_ROLES.includes(role)) return 'national';
  if (SUBSYSTEM_LEAD_ROLES.includes(role)) return 'national';
  return 'chapter';
}

/**
 * True when the role sits on the National Executive Council (Tier A).
 */
export function isNationalExecutive(role: CanonicalRole): boolean {
  return NATIONAL_EXECUTIVE_ROLES.includes(role);
}

/**
 * True when the role sits on a chapter executive board (Tier B).
 */
export function isChapterExecutive(role: CanonicalRole): boolean {
  return CHAPTER_EXECUTIVE_ROLES.includes(role);
}

/**
 * True when the role leads a technical subsystem engineering track.
 */
export function isSubsystemLead(role: CanonicalRole): boolean {
  return SUBSYSTEM_LEAD_ROLES.includes(role);
}

/**
 * Task creation gate for the delegation engine.
 * Officers at national or chapter level, subsystem leads, and platform
 * owners may create and delegate tasks.
 */
export function canCreateTasks(role: CanonicalRole): boolean {
  if (role === 'superadmin' || role === 'developer') return true;
  return (
    NATIONAL_EXECUTIVE_ROLES.includes(role) ||
    CHAPTER_EXECUTIVE_ROLES.includes(role) ||
    SUBSYSTEM_LEAD_ROLES.includes(role)
  );
}

/**
 * Task review gate for the delegation engine reviewer selector.
 * Platform owners, the National Executive Council, and chapter
 * president plus chapter vice presidents may review submissions.
 */
export function canReviewTasks(role: CanonicalRole): boolean {
  if (role === 'superadmin' || role === 'developer') return true;
  if (NATIONAL_EXECUTIVE_ROLES.includes(role)) return true;
  return (
    role === 'chapter_president' ||
    role === 'chapter_vp_technical' ||
    role === 'chapter_vp_operations' ||
    role === 'chapter_vp_marketing'
  );
}
