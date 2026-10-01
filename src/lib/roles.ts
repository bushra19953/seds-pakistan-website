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
