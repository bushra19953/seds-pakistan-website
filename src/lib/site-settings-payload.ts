/**
 * Pure payload builders for the site-wide settings editor
 * (settings/siteWide), extracted verbatim from
 * src/components/admin/site-settings-management.tsx so the creation
 * payload and the save whitelist are unit-testable and reusable by the
 * Supabase mirror. Semantics are EXACTLY the component's:
 *
 * - Creation OMITS bugReportEmail, siteEnabled and maintenanceMode
 *   (they only appear on a doc via a later save).
 * - Save writes EXACTLY 14 fields; any extra state fields are dropped.
 * - Traps: the dynamic studentsCount overrides the edited
 *   studentsEngaged; globalChapters 0 -> 25 via ||; booleans via ||;
 *   siteEnabled is `!== false` (default true); maintenanceMode is
 *   `=== true` (default false).
 * - updatedAt is handled by the caller (serverTimestamp() on the
 *   Firestore write; an ISO string on the mirror payload). updatedBy is
 *   part of both payloads: creation falls back to 'system', save does
 *   not (the caller guarantees a signed-in user).
 */
import { DEFAULT_SITE_SETTINGS, type SiteWideSettings } from '@/types/site-settings';

export type SiteWideCreationPayload = {
  studentsEngaged: number;
  activeProjects: number;
  partners: number;
  globalChapters: number;
  contactFormDestinationEmail: string;
  enableDonations: boolean;
  enableChapterRegistration: boolean;
  registrationStatus: typeof DEFAULT_SITE_SETTINGS.registrationStatus;
  registrationNumber: string;
  registrationDate: string;
  registrarJurisdiction: string;
  updatedBy: string;
};

export function createSiteWidePayload(
  studentsCount: number,
  uid: string,
): SiteWideCreationPayload {
  return {
    studentsEngaged: studentsCount, // Use dynamic count
    activeProjects: DEFAULT_SITE_SETTINGS.activeProjects,
    partners: DEFAULT_SITE_SETTINGS.partners,
    globalChapters: DEFAULT_SITE_SETTINGS.globalChapters,
    contactFormDestinationEmail: DEFAULT_SITE_SETTINGS.contactFormDestinationEmail,
    enableDonations: DEFAULT_SITE_SETTINGS.enableDonations,
    enableChapterRegistration: DEFAULT_SITE_SETTINGS.enableChapterRegistration,
    registrationStatus: DEFAULT_SITE_SETTINGS.registrationStatus,
    registrationNumber: DEFAULT_SITE_SETTINGS.registrationNumber,
    registrationDate: DEFAULT_SITE_SETTINGS.registrationDate,
    registrarJurisdiction: DEFAULT_SITE_SETTINGS.registrarJurisdiction,
    updatedBy: uid || 'system',
  };
}

export type SiteWideSavePayload = {
  studentsEngaged: number;
  activeProjects: number;
  partners: number;
  globalChapters: number;
  contactFormDestinationEmail: string;
  bugReportEmail: string;
  enableDonations: boolean;
  enableChapterRegistration: boolean;
  registrationStatus: string;
  registrationNumber: string;
  registrationDate: string;
  registrarJurisdiction: string;
  siteEnabled: boolean;
  maintenanceMode: boolean;
  updatedBy: string;
};

export function buildSiteWideSave(
  settings: Partial<SiteWideSettings>,
  studentsCount: number,
  uid: string,
): SiteWideSavePayload {
  return {
    studentsEngaged: studentsCount, // Use dynamic count from users collection
    activeProjects: settings.activeProjects || 0,
    partners: settings.partners || 0,
    globalChapters: settings.globalChapters || 25,
    contactFormDestinationEmail: settings.contactFormDestinationEmail || '',
    bugReportEmail: settings.bugReportEmail || '',
    enableDonations: settings.enableDonations || false,
    enableChapterRegistration: settings.enableChapterRegistration || false,
    registrationStatus: settings.registrationStatus || 'in_process',
    registrationNumber: settings.registrationNumber || '',
    registrationDate: settings.registrationDate || '',
    registrarJurisdiction: settings.registrarJurisdiction || '',
    // Platform switches (Workstream H): BOTH fields must stay in
    // this whitelist or the toggles silently never persist
    // (the updateDoc payload is the only write path).
    siteEnabled: settings.siteEnabled !== false,
    maintenanceMode: settings.maintenanceMode === true,
    updatedBy: uid,
  };
}
