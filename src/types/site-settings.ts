import type { Timestamp } from 'firebase/firestore';
import type { RegistrationStatus } from '@/lib/legal-status';

export type { RegistrationStatus };

/**
 * Site-Wide Settings for Homepage Credibility Hub
 * This is a singleton collection that provides global site statistics and settings
 */
export interface SiteWideSettings {
  id?: string;

  // Homepage Trust Bar Metrics (KPI Dashboard)
  studentsEngaged?: number;
  activeProjects?: number;
  partners?: number;
  globalChapters?: number; // Can be hardcoded value
  contactFormDestinationEmail?: string;
  bugReportEmail?: string; // Where bug reports/suggestions from admin users get sent

  // Feature Flags
  enableDonations?: boolean;
  enableChapterRegistration?: boolean;

  // Legal registration status (Item 8: single source of truth).
  // registrationDate is an ISO date string (YYYY-MM-DD) so the shared
  // legal-status generator can stay a plain serialisable value.
  registrationStatus?: RegistrationStatus;
  registrationNumber?: string;
  registrationDate?: string;
  registrarJurisdiction?: string;

  // Last updated timestamp
  updatedAt?: Timestamp;
  updatedBy?: string; // admin uid who made the change
}

// Default values for new installations
export const DEFAULT_SITE_SETTINGS = {
  studentsEngaged: 0,
  activeProjects: 0,
  partners: 0,
  globalChapters: 25,
  contactFormDestinationEmail: '',
  bugReportEmail: '',
  enableDonations: false,
  enableChapterRegistration: false,
  registrationStatus: 'in_process' as RegistrationStatus,
  registrationNumber: '',
  registrationDate: '',
  registrarJurisdiction: ''
};
