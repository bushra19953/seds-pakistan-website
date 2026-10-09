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
export const LEGACY_ROLE_MAP: Record<string, { role: CanonicalRole; scope: RoleScope }> = {
  /* Platform and superadmin */
  superadmin: { role: 'superadmin', scope: 'national' },
  admin: { role: 'superadmin', scope: 'national' },

  /* National executive tokens */
  president_national: { role: 'president_national', scope: 'national' },
  president: { role: 'president_national', scope: 'national' },

  /* Chapter executive tokens */
  president_chapter: { role: 'chapter_president', scope: 'chapter' },

  /* VP and operations tokens */
  vice_president: { role: 'national_vp_operations', scope: 'national' },
  vp: { role: 'national_vp_operations', scope: 'national' },
  general_secretary: { role: 'national_vp_operations', scope: 'national' },

  /* Technical and engineering tokens */
  projects_director: { role: 'national_vp_engineering', scope: 'national' },
  chair_projects: { role: 'national_vp_engineering', scope: 'national' },
  director: { role: 'national_vp_engineering', scope: 'national' },
  head: { role: 'national_vp_engineering', scope: 'national' },

  /* Marketing tokens */
  marketing_head: { role: 'national_vp_marketing', scope: 'national' },
  chair_marketing: { role: 'national_vp_marketing', scope: 'national' },
  chair_design: { role: 'national_vp_marketing', scope: 'national' },
  chair_outreach: { role: 'national_vp_marketing', scope: 'national' },

  /* Operations and events tokens */
  chair_events: { role: 'national_vp_operations', scope: 'national' },

  /* Finance tokens */
  treasurer: { role: 'national_vp_finance', scope: 'national' },

  /* Membership and HR tokens */
  hr_director: { role: 'national_vp_membership', scope: 'national' },

  /* Subsystem lead tokens */
  team_leader: { role: 'lead_structures', scope: 'chapter' },
  lead: { role: 'lead_structures', scope: 'chapter' },
  chair: { role: 'lead_structures', scope: 'chapter' },

  /* Advisory and member tokens */
  advisor: { role: 'senior_advisor', scope: 'national' },
  member: { role: 'team_member', scope: 'chapter' },
  none: { role: 'applicant', scope: 'chapter' },
};

/* Extended mappings for additional legacy tokens observed in this codebase.
   These supplement the 27 audited tokens above and never override them. */
const EXTENDED_ROLE_MAP: Record<string, { role: CanonicalRole; scope: RoleScope }> = {
  presidential_national: { role: 'president_national', scope: 'national' },
  pakistan_president: { role: 'president_national', scope: 'national' },
  pakistan_national_president: { role: 'president_national', scope: 'national' },
  national_vice_president: { role: 'national_vp_operations', scope: 'national' },
  marketingoutreach_head: { role: 'national_vp_marketing', scope: 'national' },
  marketing_lead: { role: 'national_vp_marketing', scope: 'national' },
  chair_marketing_communications: { role: 'national_vp_marketing', scope: 'national' },
  chair_projects_committee: { role: 'national_vp_engineering', scope: 'national' },
  hr_or_membership_director: { role: 'national_vp_membership', scope: 'national' },
  chair_recruitment: { role: 'national_vp_membership', scope: 'national' },
  chair_recruitment_membership: { role: 'national_vp_membership', scope: 'national' },
  secretary: { role: 'national_vp_operations', scope: 'national' },
  advisor_faculty_head: { role: 'senior_advisor', scope: 'national' },
};

function lookupRoleEntry(clean: string): { role: CanonicalRole; scope: RoleScope } | undefined {
  return LEGACY_ROLE_MAP[clean] || EXTENDED_ROLE_MAP[clean];
}

/* Canonical roles that operate at national scope (spec 2.1). Used when
   resolveUserScope receives an already-canonical role instead of a raw token. */
const NATIONAL_SCOPE_ROLES: CanonicalRole[] = [
  'superadmin',
  'developer',
  'president_national',
  'national_vp_engineering',
  'national_vp_operations',
  'national_vp_marketing',
  'national_vp_finance',
  'national_vp_membership',
  'lead_propulsion',
  'lead_structures',
  'lead_avionics',
  'lead_robotics',
  'lead_materials',
  'lead_ground_systems',
  'senior_advisor',
];

/* Normalizes any raw role string into a validated canonical role with safe fallback. */
export function normalizeUserRole(rawRole: string | undefined | null): CanonicalRole {
  if (!rawRole) return 'guest';
  const clean = rawRole.toLowerCase().trim();
  const entry = lookupRoleEntry(clean);
  return entry ? entry.role : 'team_member';
}

/* Resolves the operational scope (national vs chapter). */
export function resolveUserScope(rawRole: string | undefined | null): RoleScope {
  if (!rawRole) return 'chapter';
  const clean = rawRole.toLowerCase().trim();
  const entry = lookupRoleEntry(clean);
  if (entry) return entry.scope;
  if ((NATIONAL_SCOPE_ROLES as string[]).includes(clean)) return 'national';
  return 'chapter';
}

/* Permission gate helpers. */
export function isNationalExecutive(role: CanonicalRole): boolean {
  return [
    'superadmin',
    'president_national',
    'national_vp_engineering',
    'national_vp_operations',
    'national_vp_marketing',
    'national_vp_finance',
    'national_vp_membership',
  ].includes(role);
}

export function isChapterExecutive(role: CanonicalRole): boolean {
  return [
    'chapter_president',
    'chapter_vp_technical',
    'chapter_vp_operations',
    'chapter_vp_marketing',
    'chapter_treasurer',
    'chapter_general_secretary',
  ].includes(role);
}

export function isSubsystemLead(role: CanonicalRole): boolean {
  return [
    'lead_propulsion',
    'lead_structures',
    'lead_avionics',
    'lead_robotics',
    'lead_materials',
    'lead_ground_systems',
  ].includes(role);
}

export function canCreateTasks(role: CanonicalRole): boolean {
  return isNationalExecutive(role) || isChapterExecutive(role) || isSubsystemLead(role);
}

export function canReviewTasks(role: CanonicalRole): boolean {
  return isNationalExecutive(role) || isChapterExecutive(role);
}

// Canonical role tokens to short human titles (ASCII only).
// Used for the delegation-engine assignee/reviewer labels (spec 6.1).
export const CANONICAL_ROLE_TITLES: Record<CanonicalRole, string> = {
  superadmin: 'Super Admin',
  developer: 'Developer',
  president_national: 'National President',
  national_vp_engineering: 'VP Engineering',
  national_vp_operations: 'VP Operations',
  national_vp_marketing: 'VP Marketing',
  national_vp_finance: 'VP Finance',
  national_vp_membership: 'VP Membership',
  chapter_president: 'Chapter President',
  chapter_vp_technical: 'VP Technical',
  chapter_vp_operations: 'VP Operations',
  chapter_vp_marketing: 'VP Marketing',
  chapter_treasurer: 'Treasurer',
  chapter_general_secretary: 'General Secretary',
  chapter_faculty_advisor: 'Faculty Advisor',
  lead_propulsion: 'Lead Propulsion',
  lead_structures: 'Lead Structures',
  lead_avionics: 'Lead Avionics',
  lead_robotics: 'Lead Robotics',
  lead_materials: 'Lead Materials',
  lead_ground_systems: 'Lead Ground Systems',
  senior_advisor: 'Senior Advisor',
  team_member: 'Team Member',
  crucible_candidate: 'Crucible Candidate',
  applicant: 'Applicant',
  alumni: 'Alumni',
  guest: 'Guest',
};

/**
 * Title lookup that never throws on unknown tokens: legacy tokens are
 * normalized first (so e.g. 'chair_marketing' renders 'VP Marketing'),
 * anything unrecognized falls back to the raw token, and empty input
 * renders 'Guest'.
 */
export function canonicalRoleTitle(role: string | null | undefined): string {
  const canonical = normalizeUserRole(role);
  const known = CANONICAL_ROLE_TITLES[canonical];
  if (known) return known;
  const raw = (role || '').trim();
  return raw || 'Guest';
}

/**
 * Format a delegation-engine user label per spec 6.1:
 * [Scope] Full Name (Canonical Title - Subsystem)
 *
 * Scope renders 'National' for national-scope roles, otherwise the chapter
 * slug uppercased (e.g. 'SEDS-IST'). The subsystem part renders only when a
 * subsystem value is present; no subsystem field exists on user docs yet,
 * so the label is normally '[Scope] Full Name (Canonical Title)'.
 */
export function formatCanonicalUserLabel(user: {
  displayName?: string | null;
  email?: string | null;
  role?: string | null;
  chapterId?: string | null;
  subsystem?: string | null;
}): string {
  const name = (user.displayName || '').trim() || (user.email || '').trim() || 'Unknown user';
  const canonical = normalizeUserRole(user.role);
  const title = canonicalRoleTitle(user.role);
  const scope = resolveUserScope(canonical);
  const chapterSlug = (user.chapterId || '').trim();
  const scopeLabel = scope === 'national' ? 'National' : (chapterSlug ? chapterSlug.toUpperCase() : 'CHAPTER');
  const subsystem = (user.subsystem || '').trim();
  const parenthetical = subsystem ? `${title} - ${subsystem}` : title;
  return `[${scopeLabel}] ${name} (${parenthetical})`;
}
