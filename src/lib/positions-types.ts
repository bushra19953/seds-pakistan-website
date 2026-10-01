/**
 * Position Management System Types for SEDS Pakistan
 * 
 * This module defines the complete type system for managing organizational positions,
 * including historical records, current appointments, and administrative workflows.
 * 
 * Key Design Principles:
 * - Integrates with existing role system (src/lib/roles.ts)
 * - Follows established Firestore data patterns
 * - Supports automated continuity management
 * - Enables public transparency and alumni networking
 */

import { UserRole } from './roles';

// ============================================================================
// CORE DATA TYPES
// ============================================================================

export interface Position {
  /** Unique identifier for the position record */
  id: string;
  
  /** The role this position represents (e.g., 'president_national', 'general_secretary') */
  role: UserRole;
  
  /** The user who holds/held this position */
  userId: string;
  
  /** When this position appointment starts */
  startDate: Date;
  
  /** When this position appointment ends (null = currently active) */
  endDate?: Date | null;
  
  /** Administrator who made this appointment */
  appointedBy: string;
  
  /** Optional notes about the appointment */
  notes?: string;
  
  /** Audit trail */
  createdAt: Date;
  updatedAt: Date;
  
  /** Metadata for display purposes */
  metadata?: {
    /** Human-readable role name at time of appointment */
    roleDisplayName: string;
    /** Human-readable user name at time of appointment */
    userDisplayName: string;
    /** Administrator name at time of appointment */
    appointedByDisplayName: string;
  };
}

// ============================================================================
// POSITION QUERY AND FILTERING
// ============================================================================

export interface PositionFilter {
  /** Filter by specific role(s) */
  roles?: UserRole[];
  
  /** Filter by specific user(s) */
  userIds?: string[];
  
  /** Filter by appointment date range */
  dateRange?: {
    startDate?: Date;
    endDate?: Date;
  };
  
  /** Filter to show only currently active positions */
  activeOnly?: boolean;
  
  /** Filter to show only historical positions */
  historicalOnly?: boolean;
  
  /** Pagination */
  limit?: number;
  offset?: number;
}

export interface PositionQueryResult {
  positions: Position[];
  totalCount: number;
  hasNext: boolean;
  hasPrevious: boolean;
  currentPage: number;
  totalPages: number;
}

// ============================================================================
// POSITION CREATION AND MANAGEMENT
// ============================================================================

export interface CreatePositionRequest {
  /** Role for the new position */
  role: UserRole;
  
  /** User to appoint to this position */
  userId: string;
  
  /** When the appointment starts */
  startDate: Date;
  
  /** Optional appointment notes */
  notes?: string;
  
  /** Administrator making the appointment (inferred from auth token) */
  appointedBy?: string;
}

export interface UpdatePositionRequest {
  /** Optional new start date */
  startDate?: Date;
  
  /** Optional new end date (setting this archives the position) */
  endDate?: Date | null;
  
  /** Optional appointment notes */
  notes?: string;
  
  /** Optional role change (requires special privileges) */
  role?: UserRole;
}

export interface PositionCreationResult {
  /** The newly created position record */
  position: Position;
  
  /** Whether the system automatically updated a previous position holder */
  continuityUpdated: boolean;
  
  /** ID of the previous position that was updated (if applicable) */
  previousPositionId?: string;
  
  /** Notification details for audit trail */
  notifications?: {
    /** User appointed to position */
    newAppointee?: boolean;
    /** Previous position holder (if continuity was updated) */
    previousAppointee?: boolean;
  };
}

// ============================================================================
// PUBLIC API TYPES
// ============================================================================

export interface CurrentLeadership {
  /** Role that currently has an active appointment */
  role: UserRole;
  
  /** Current office holder */
  officeHolder: {
    userId: string;
    displayName: string;
    startDate: Date;
    photoURL?: string;
    chapterId?: string;
  };
  
  /** Time since appointment */
  tenureDuration: {
    years: number;
    months: number;
    days: number;
  };
}

export interface LeadershipHistory {
  /** Role being displayed */
  role: UserRole;
  
  /** Human-readable role name */
  roleDisplayName: string;
  
  /** Complete history of office holders */
  officeHolders: {
    userId: string;
    displayName: string;
    startDate: Date;
    endDate?: Date | null;
    tenureDuration: {
      years: number;
      months: number;
      days: number;
    };
    photoURL?: string;
    chapterId?: string;
    isCurrent: boolean;
  }[];
  
  /** Statistical overview */
  statistics: {
    totalOfficeHolders: number;
    currentOfficeHolder?: string;
    averageTenureDays: number;
    longestTenureDays: number;
    shortestTenureDays: number;
  };
}

export interface LeadershipTimelineItem {
  /** Date when this appointment starts */
  date: Date;
  
  /** Type of event */
  eventType: 'appointment' | 'term_end' | 'reappointment';
  
  /** Role involved in this event */
  role: UserRole;
  
  /** User involved in this event */
  userId: string;
  
  /** User display name at time of event */
  userDisplayName: string;
  
  /** Additional event details */
  details?: string;
}

// ============================================================================
// ADMIN INTERFACE TYPES
// ============================================================================

export interface AdminPositionSummary {
  /** Role being summarized */
  role: UserRole;
  
  /** Current office holder (if any) */
  currentOfficeHolder?: {
    userId: string;
    displayName: string;
    startDate: Date;
    photoURL?: string;
  };
  
  /** Count of historical office holders */
  historicalCount: number;
  
  /** Last appointment date */
  lastAppointmentDate?: Date;
  
  /** Time since last appointment */
  timeSinceLastAppointment?: {
    years: number;
    months: number;
    days: number;
  };
}

export interface PositionFormData {
  /** Role to be appointed */
  role: UserRole;
  
  /** User to be appointed */
  userId: string;
  
  /** Appointment start date */
  startDate: string; // HTML datetime-local format
  
  /** Optional appointment notes */
  notes?: string;
  
  /** Validation errors */
  errors?: {
    role?: string;
    userId?: string;
    startDate?: string;
    notes?: string;
  };
}

export interface PositionManagementStats {
  /** Total number of position records */
  totalPositions: number;
  
  /** Number of currently active positions */
  activePositions: number;
  
  /** Number of unique roles with position history */
  rolesWithHistory: number;
  
  /** Most recent appointment */
  mostRecentAppointment?: {
    role: UserRole;
    userId: string;
    displayName: string;
    startDate: Date;
  };
  
  /** Appointments by month (for analytics) */
  appointmentsByMonth: {
    month: string; // YYYY-MM
    count: number;
  }[];
}

// ============================================================================
// ERROR TYPES
// ============================================================================

export interface PositionError {
  /** Error code for programmatic handling */
  code: 'INVALID_ROLE' | 'USER_NOT_FOUND' | 'INVALID_DATE_RANGE' | 'UNAUTHORIZED' | 'DUPLICATE_ACTIVE_POSITION' | 'VALIDATION_ERROR' | 'DATABASE_ERROR';
  
  /** Human-readable error message */
  message: string;
  
  /** Additional error details */
  details?: any;
  
  /** Field-specific errors for forms */
  fieldErrors?: Record<string, string>;
}

// ============================================================================
// FIREBASE CLOUD FUNCTION TYPES
// ============================================================================

export interface PositionContinuityUpdate {
  /** ID of the new position that triggered this update */
  newPositionId: string;
  
  /** ID of the previous position that was updated */
  previousPositionId: string;
  
  /** Role for which continuity was maintained */
  role: UserRole;
  
  /** Date when the previous position ended */
  endDate: Date;
  
  /** Audit information */
  audit: {
    timestamp: Date;
    triggeredBy: string;
    function: string;
  };
}

// ============================================================================
// INTEGRATION WITH EXISTING SYSTEMS
// ============================================================================

export interface PositionWithUserData extends Position {
  /** Extended user data for display */
  user: {
    uid: string;
    displayName: string;
    email: string;
    photoURL?: string;
    chapterId?: string;
    university?: string;
  };
  
  /** Extended role data for display */
  roleInfo: {
    role: UserRole;
    displayName: string;
    level: number;
  };
}

export interface PositionWithAdminData extends Position {
  /** Extended administrator data for display */
  administrator: {
    uid: string;
    displayName: string;
    email: string;
  };
}

// ============================================================================
// UTILITY TYPES
// ============================================================================

/** Utility type for position validation */
export type PositionValidationResult = 
  | { valid: true }
  | { valid: false; errors: PositionError[] };

/** Utility type for position status */
export type PositionStatus = 'active' | 'historical' | 'pending';

/** Utility type for appointment type */
export type AppointmentType = 'initial' | 'reappointment' | 'acting' | 'interim';

/** Utility type for position priority (for sorting and display) */
export type PositionPriority = 'critical' | 'high' | 'medium' | 'low';

// ============================================================================
// EXPORTS
// ============================================================================

// Types above are already exported via their declarations.