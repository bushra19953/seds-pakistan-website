/**
 * Compliance engine shared types (phase2_spec.md Section G.1, G.3, G.4).
 * Client-safe: no Firestore or network access lives here.
 *
 * FY CONVENTION for this module: the Calendar's Oct-Sep convention -
 * FY2026-27 = 1 Oct 2026 to 30 Sep 2027 (spec G.9). This deliberately
 * differs from the cadetship module's Jul-Jun convention; the shared
 * fiscalYearOf() helper takes the start month as a parameter precisely so
 * the two conventions never silently fork.
 */

export type DeadlineRule =
  | { kind: 'fixed_day_of_month'; day: number }
  | { kind: 'fixed_date'; month: number; day: number }
  | { kind: 'quarterly_fixed_day'; day: number; months: number[] }
  | { kind: 'days_after_trigger'; days: number }
  | { kind: 'days_before_subject_date'; days: number }
  | { kind: 'prior_to_execution' };

export type ObligationStatus =
  | 'scheduled'
  | 'reminded_30'
  | 'reminded_14'
  | 'reminded_7'
  | 'due'
  | 'evidence_submitted'
  | 'under_review'
  | 'completed'
  | 'overdue'
  | 'default_draft'
  | 'default_issued'
  | 'cure_period'
  | 'escalated'
  | 'waived';

export const TERMINAL_STATUSES: ObligationStatus[] = ['completed', 'waived'];

export type ProofType = 'tasks' | 'photo' | 'document' | 'text';

export interface ComplianceTemplate {
  templateKey: string;
  title: string;
  /** Catalog role key of the RESPONSIBLE OFFICE (an office, not a person). */
  officeRole: string;
  alsoNotifiedRoles: string[];
  cadence: 'monthly' | 'quarterly' | 'annual' | 'event';
  deadlineRule: DeadlineRule;
  reminderOffsetsDays: number[];
  proofRequired: boolean;
  proofTypes: ProofType[];
  /** Reviewer office role key (G.4): Audit Chair for finance/governance, NGS else. */
  reviewerRole: string;
  calendarRef: string;
  chapterScoped: boolean;
  active: boolean;
  /** Incremented on every PATCH edit; instances pin the version they were generated from. */
  templateVersion: number;
}

export interface ObligationEvidence {
  type: ProofType;
  ref: string;
  submittedBy: string;
  submittedAt: Date;
  note: string | null;
}

export interface ObligationReview {
  reviewedBy: string;
  reviewedAt: Date;
  outcome: 'accepted' | 'rejected';
  note: string | null;
}

export interface ObligationWaiver {
  instrumentType: 'founder_act' | 'board_resolution';
  instrumentRef: string;
  waivedBy: string;
  waivedAt: Date;
  note: string | null;
}

export interface ReminderReceipt {
  uid: string;
  offsetDays: number;
  at: Date;
  ok: boolean;
}

export interface ComplianceObligation {
  id: string;
  templateKey: string;
  templateVersion: number;
  title: string;
  officeRole: string;
  /** Last resolved holder, display only - NEVER used to route a send (G.2). */
  ownerUidSnapshot: string | null;
  chapterId: string | null;
  periodKey: string;
  dueDate: Date;
  status: ObligationStatus;
  evidence: ObligationEvidence | null;
  review: ObligationReview | null;
  waiver: ObligationWaiver | null;
  remindersSent: { d30: Date | null; d14: Date | null; d7: Date | null };
  /** Per-recipient receipts so a partial failure retries only the missing. */
  reminderReceipts: ReminderReceipt[];
  overdueNotifiedAt: Date | null;
  defaultNoticeId: string | null;
  escalation: {
    level: 'none' | 'founder_notified' | 'founder_intervention';
    at: Date | null;
    note: string | null;
  };
  completedAt: Date | null;
  completedVia:
    | 'review'
    | 'cure'
    | 'founder_intervention'
    | 'report_delivery'
    | 'superseded'
    | null;
  createdBy: 'generator' | 'trigger' | 'manual';
  /** Seed-held (Decision 16): the cron skips held instances entirely. */
  seedHold?: boolean;
  triggerId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeliveryReceipt {
  method: 'notification' | 'email';
  ref: string | null;
  at: Date | null;
  ok: boolean;
}

export interface DefaultNotice {
  id: string;
  obligationId: string;
  templateKey: string;
  officeRole: string;
  issuedToUid: string | null;
  issuedToName: string | null;
  /** Holder at draft time when the office changed hands before issue. */
  priorHolderUid?: string | null;
  issuedBy: string | null;
  issuedAt: Date | null;
  cureDeadline: Date | null;
  deliveryReceipts: {
    founder: DeliveryReceipt;
    president: DeliveryReceipt;
  };
  cure: {
    submittedBy: string;
    submittedAt: Date;
    evidenceRef: string;
    note: string | null;
  } | null;
  cureReview: {
    reviewedBy: string;
    reviewedAt: Date;
    outcome: 'accepted' | 'rejected';
    note: string | null;
  } | null;
  outcome: 'open' | 'cured' | 'escalated';
  escalatedAt: Date | null;
  intervention: {
    type: 'performed_directly' | 'interim_appointed' | 'officer_removed';
    byUid: string;
    at: Date;
    note: string | null;
    newObligationId?: string | null;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ComplianceTrigger {
  id: string;
  templateKey: string;
  triggerType: string;
  triggerDate: Date;
  subjectRef: { kind: 'person' | 'chapter' | 'document' | 'event'; id: string; label: string };
  recordedBy: string;
  recordedAt: Date;
  idempotencyKey: string;
  obligationId: string | null;
  note: string | null;
}
