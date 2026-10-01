import type { Timestamp } from 'firebase/firestore';

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
  enableChapterRegistration: false
};
