/**
 * Permission bundles for the eight Founder-appointed offices (spec D.2).
 *
 * Values are copied verbatim from the Phase 1 spec section D.2 matrix;
 * every other permission key is false for these offices (notably
 * canManageRoles is false for all eight). The matrix is frozen until the
 * Founder rules otherwise; a change here is a code change, reviewed like
 * one. XP for each office is the catalog row XP (spec A.1), never stored
 * here.
 */

import type { CatalogRoleKey } from '../role-catalog';

export const FOUNDER_APPOINTED_OFFICES = [
  'national_treasurer',
  'national_general_secretary',
  'national_membership_director',
  'national_audit_compliance_chair',
  'returning_officer',
  'parliamentarian',
  'faculty_advisor',
  'regional_coordinator',
] as const satisfies readonly CatalogRoleKey[];

export type FounderAppointedOffice = (typeof FOUNDER_APPOINTED_OFFICES)[number];

/** The D.2 matrix columns (canManageRoles is all-false and stays unlisted). */
export interface OfficePermissionBundle {
  canAccessAdmin: boolean;
  canViewUsers: boolean;
  canViewChapters: boolean;
  canManageApplications: boolean;
  canManageEvents: boolean;
  canManageTasks: boolean;
  canViewAnalytics: boolean;
  canManageAnnouncements: boolean;
  canManageSponsors: boolean;
  canManagePartners: boolean;
  canModerateBlogs: boolean;
  canManageCompetitions: boolean;
}

const F = false;
const T = true;

export const OFFICE_PERMISSION_SEEDS: Record<FounderAppointedOffice, OfficePermissionBundle> = {
  national_treasurer: {
    canAccessAdmin: T, canViewUsers: T, canViewChapters: T, canManageApplications: F,
    canManageEvents: F, canManageTasks: F, canViewAnalytics: T, canManageAnnouncements: F,
    canManageSponsors: T, canManagePartners: T, canModerateBlogs: F, canManageCompetitions: F,
  },
  national_general_secretary: {
    canAccessAdmin: T, canViewUsers: T, canViewChapters: T, canManageApplications: T,
    canManageEvents: T, canManageTasks: T, canViewAnalytics: T, canManageAnnouncements: T,
    canManageSponsors: F, canManagePartners: F, canModerateBlogs: F, canManageCompetitions: F,
  },
  national_membership_director: {
    canAccessAdmin: T, canViewUsers: T, canViewChapters: T, canManageApplications: T,
    canManageEvents: F, canManageTasks: F, canViewAnalytics: T, canManageAnnouncements: F,
    canManageSponsors: F, canManagePartners: F, canModerateBlogs: F, canManageCompetitions: F,
  },
  national_audit_compliance_chair: {
    canAccessAdmin: T, canViewUsers: T, canViewChapters: T, canManageApplications: F,
    canManageEvents: F, canManageTasks: F, canViewAnalytics: T, canManageAnnouncements: F,
    canManageSponsors: T, canManagePartners: T, canModerateBlogs: F, canManageCompetitions: F,
  },
  returning_officer: {
    canAccessAdmin: T, canViewUsers: T, canViewChapters: F, canManageApplications: F,
    canManageEvents: F, canManageTasks: F, canViewAnalytics: F, canManageAnnouncements: F,
    canManageSponsors: F, canManagePartners: F, canModerateBlogs: F, canManageCompetitions: F,
  },
  parliamentarian: {
    canAccessAdmin: T, canViewUsers: T, canViewChapters: F, canManageApplications: F,
    canManageEvents: F, canManageTasks: F, canViewAnalytics: F, canManageAnnouncements: F,
    canManageSponsors: F, canManagePartners: F, canModerateBlogs: F, canManageCompetitions: F,
  },
  faculty_advisor: {
    canAccessAdmin: T, canViewUsers: T, canViewChapters: T, canManageApplications: F,
    canManageEvents: F, canManageTasks: T, canViewAnalytics: T, canManageAnnouncements: F,
    canManageSponsors: F, canManagePartners: F, canModerateBlogs: F, canManageCompetitions: F,
  },
  regional_coordinator: {
    canAccessAdmin: T, canViewUsers: T, canViewChapters: T, canManageApplications: F,
    canManageEvents: T, canManageTasks: T, canViewAnalytics: F, canManageAnnouncements: T,
    canManageSponsors: F, canManagePartners: F, canModerateBlogs: F, canManageCompetitions: T,
  },
};

export function isFounderAppointedOffice(key: string): key is FounderAppointedOffice {
  return (FOUNDER_APPOINTED_OFFICES as readonly string[]).includes(key);
}
