import type { Timestamp } from 'firebase/firestore';

// ─── Warning Types ──────────────────────────────────────────────────────────
export type WarningType =
  | 'misconduct'
  | 'missed-deadline'
  | 'insubordination'
  | 'attendance'
  | 'policy-violation'
  | 'other';

export const WARNING_TYPE_LABELS: Record<WarningType, string> = {
  'misconduct': 'Misconduct',
  'missed-deadline': 'Missed Deadline',
  'insubordination': 'Insubordination',
  'attendance': 'Attendance Issue',
  'policy-violation': 'Policy Violation',
  'other': 'Other',
};

// ─── Global Warning Settings (stored in Firestore: warningConfig/global) ────
export interface WarningSettings {
  expirationDays: number;         // Default: 90 — how many days a warning stays active
  blacklistThreshold: number;     // Default: 3  — warnings to trigger blacklisted status
  autoIssueOnDeadlineMiss: boolean; // Default: true
  penaltyPoints: number;          // Default: 5  — points deducted per warning
  publicVisibility: boolean;      // Default: true — show warning registry to public
  enforcementEnabled: boolean;     // Default: true — whether blacklisting actually blocks actions
  updatedAt?: Timestamp;
  updatedBy?: string;
}

export const DEFAULT_WARNING_SETTINGS: WarningSettings = {
  expirationDays: 90,
  blacklistThreshold: 3,
  autoIssueOnDeadlineMiss: true,
  penaltyPoints: 5,
  publicVisibility: true,
  enforcementEnabled: true,
};

// ─── User Profile ───────────────────────────────────────────────────────────
export interface UserProfile {
  uid: string;
  // LEGACY (security wave 2, 2026-10-28): contact fields no longer live on
  // the user record. They moved to the gated users/{uid}/private/contact
  // document — read them via src/lib/server/user-contact.ts (server) or
  // src/lib/client/user-contact.ts (owner leg), never from this record.
  // `email` and `whatsappNumber` remain declared here only so legacy row
  // shapes keep compiling while stored data is stripped; do not read or
  // write them on a user record.
  email: string;
  displayName: string;
  bio: string;
  githubUrl: string;
  linkedinUrl: string;
  chapterId?: string;
  chapterName?: string; // Denormalized for display
  // WS3 Member Profile Hub (shared-field decision, 2026-10-20): explicit slug
  // used by the public portfolio route /u/:username. When unset, the public
  // route derives a slug from displayName.
  username?: string;
  // WS3 shared-field decision for the Privacy workstream: explicit opt-in to
  // the public member directory / portfolio. Default when absent: false,
  // except executives (national-scope roles), who default to true. Contact
  // fields are never public either way (see /api/public/portfolio/[username]).
  publicDirectoryOptIn?: boolean;
  university?: string;
  fieldOfStudy?: string;
  photoURL?: string;
  badges?: string[];
  whatsappNumber?: string; // Private field, owner/admin readable only
  points: number;
  customTitle?: string;         // Optional custom title/designation (set via role sync)

  // Warning & Accountability System
  warningCount?: number;
  activeWarningCount?: number;   // Derived: warnings where isActive=true and not expired
  isBlacklisted?: boolean;       // Set when warningCount >= blacklistThreshold
  blacklistedAt?: Timestamp;
  blacklistReason?: string;
  blacklistStatus?: 'pending_review' | 'manual'; // 'pending_review' = threshold blacklist; 'manual' = admin toggle. Cleared (null) when the blacklist clears.
  isBanned?: boolean;            // Hard ban (beyond blacklist). Set ONLY by a manual admin toggle today and by a future Board expulsion workflow, never by the warning threshold.
  banReason?: string;
  restorationReviewNeeded?: boolean; // Set by clear-probation when a member stays banned after expiry; cleared by an admin via the ban toggle.
  warningHistory?: {
    date: string;
    reason: string;
    taskId?: string;
    revoked?: boolean;
    revokedBy?: string;
  }[];

  // Leave / vacation (set only by the approved-leave server path, never by the owner)
  isOnVacation?: boolean;
  vacationMode?: boolean;
  coveringOfficerId?: string | null;
  vacationStartDate?: string | null;
  vacationEndDate?: string | null;
  leaveRequestId?: string | null;
}

// ─── Warning Document (users/{uid}/warnings/{warningId}) ────────────────────
export interface UserWarning {
  id?: string;
  userId?: string;              // Optional denormalization
  reason: string;
  type: WarningType;
  severity?: 'low' | 'medium' | 'high';
  notes?: string;
  createdBy: string;            // Admin UID
  createdByName?: string;       // Admin display name (denormalized)
  createdAt: Timestamp;
  expiresAt: Timestamp;         // Computed from expirationDays at issuance time
  isActive: boolean;            // False when manually revoked OR expired
  status?: 'active' | 'probation_cleared' | 'revoked'; // Archive marker written by /api/cron/clear-probation ('probation_cleared' when the probation window lapses)
  expiredAt?: Timestamp;        // Set when auto-archived on probation expiry
  isPermanent?: boolean;        // True when issued as a permanent (non-expiring) warning
  revokedBy?: string;           // Admin UID who revoked
  revokedAt?: Timestamp;
  revokedReason?: string;
  penaltyPoints?: number;       // Points deducted when this warning was issued
  taskId?: string;              // If auto-issued for a missed task
  taskTitle?: string;
  appealStatus?: 'none' | 'pending' | 'approved' | 'rejected';
}
