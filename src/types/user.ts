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
  email: string;
  displayName: string;
  bio: string;
  githubUrl: string;
  linkedinUrl: string;
  chapterId?: string;
  chapterName?: string; // Denormalized for display
  university?: string;
  fieldOfStudy?: string;
  photoURL?: string;
  badges?: string[];
  whatsappNumber?: string; // Private field, owner/admin readable only
  points: number;

  // Warning & Accountability System
  warningCount?: number;
  activeWarningCount?: number;   // Derived: warnings where isActive=true and not expired
  isBlacklisted?: boolean;       // Set when warningCount >= blacklistThreshold
  blacklistedAt?: Timestamp;
  blacklistReason?: string;
  isBanned?: boolean;            // Hard ban (beyond blacklist)
  banReason?: string;
  warningHistory?: {
    date: string;
    reason: string;
    taskId?: string;
    revoked?: boolean;
    revokedBy?: string;
  }[];
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
  revokedBy?: string;           // Admin UID who revoked
  revokedAt?: Timestamp;
  revokedReason?: string;
  taskId?: string;              // If auto-issued for a missed task
  taskTitle?: string;
  appealStatus?: 'none' | 'pending' | 'approved' | 'rejected';
}
