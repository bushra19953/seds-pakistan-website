/**
 * Phase 3 Finance module types (bylaws spec Part C).
 *
 * Money convention: every amount in this module is an integer number of
 * Pakistani rupees (amountPkr / allocatedPkr / totalPkr). No sub-rupee
 * transaction exists in the system; integers keep budget-vs-actual
 * addition exact. Validation everywhere: Number.isInteger, > 0 for
 * entries, >= 0 for balances/allocations.
 */

export type TimestampLike =
  | { seconds: number; nanoseconds?: number }
  | Date
  | string
  | null;

export const FINANCE_CATEGORIES = [
  'donations',
  'sponsorships',
  'event_income',
  'chapter_fees',
  'store_sales',
  'grants',
  'other_income',
  'operations',
  'projects',
  'events',
  'marketing',
  'platform_services',
  'facilities_equipment',
  'professional_fees',
  'ip_licensing',
  'contingency_fund',
  'other_expense',
] as const;

export type FinanceCategory = (typeof FINANCE_CATEGORIES)[number];

export const INCOME_CATEGORY_CODES: ReadonlySet<string> = new Set([
  'donations',
  'sponsorships',
  'event_income',
  'chapter_fees',
  'store_sales',
  'grants',
  'other_income',
]);

/** FIN-03 tier limits ([05] sec 3.1) - reference table only, not an approval chain in MVP. */
export const FIN03_TIER_LIMITS = [
  { role: 'Founder', limitPkr: 250000 },
  { role: 'National President', limitPkr: 100000 },
  { role: 'National Treasurer', limitPkr: 50000 },
  { role: 'Chapter President', limitPkr: 25000 },
  { role: 'Chapter Treasurer', limitPkr: 10000 },
] as const;

/** PKR 250,000 Expenditure Threshold ([05] sec 3.2 FIN-04): hook H2. */
export const EXPENDITURE_THRESHOLD_PKR = 250000;

/** PKR 100,000 related-party benchmarking trigger ([05] RP-05). */
export const BENCHMARKING_TRIGGER_PKR = 100000;

export type PaymentMethod =
  | 'bank_transfer'
  | 'raast'
  | 'easypaisa'
  | 'jazzcash'
  | 'sadapay'
  | 'cash'
  | 'other';

export interface FinanceAccount {
  label: string;
  slug: string;
  type: 'bank' | 'wallet';
  last4?: string | null;
  /** Opening balance for funds-held reporting (balance-sheet summary). */
  openingBalancePkr?: number;
}

/* ---------------- Budgets: finance_budgets ---------------- */

export interface BudgetLine {
  lineId: string;
  category: FinanceCategory;
  label: string;
  allocatedPkr: number;
  notes?: string;
}

export type BudgetStatus = 'draft' | 'approved' | 'superseded';

export interface Budget {
  id?: string;
  fyLabel: string;
  fyStart: string;
  fyEnd: string;
  status: BudgetStatus;
  revision: number;
  lines: BudgetLine[];
  totalAllocatedPkr: number;
  createdBy: string;
  createdAt?: TimestampLike;
  approvedBy: string | null;
  approvalId: string | null;
  consentId: string | null;
  /** Disclosure flag: approval recorded before a Founder Consent could be attached. Printed on exports. */
  consentPending?: boolean;
  approvedAt?: TimestampLike;
  supersededBy: string | null;
  updatedAt?: TimestampLike;
}

/* ---------------- Ledger: ledger_entries ---------------- */

export type LedgerEntryType = 'income' | 'expense';
export type LedgerEntryStatus = 'draft' | 'posted';

export interface LedgerEntry {
  id?: string;
  date: string; // ISO date of the transaction
  fyLabel: string; // derived server-side from date
  type: LedgerEntryType;
  category: FinanceCategory;
  amountPkr: number; // integer > 0; direction carried by type
  counterparty: string;
  counterpartyPartnerId: string | null;
  description: string;
  budgetLineId: string | null;
  unbudgeted: boolean; // hook H1, computed server-side
  overThreshold: boolean; // hook H2, computed server-side
  consentId: string | null;
  paymentMethod: PaymentMethod;
  accountLabel: string;
  receiptDriveId: string | null;
  /** Tamper-evidence aid only, NOT a proof of authenticity. */
  receiptHash: string | null;
  relatedPartyEntryId: string | null;
  enteredBy: string;
  status: LedgerEntryStatus;
  postedBy: string | null;
  postedAt?: TimestampLike;
  sourceOrderId: string | null;
  reversalOf: string | null;
  reversedBy: string | null;
  createdAt?: TimestampLike;
  updatedAt?: TimestampLike;
}

/* ---------------- Reconciliations: finance_reconciliations ---------------- */

export type ReconciliationStatus = 'draft' | 'completed';

export interface Reconciliation {
  id?: string;
  accountLabel: string;
  periodMonth: string; // YYYY-MM
  periodStart: string;
  periodEnd: string;
  openingBalancePkr: number; // any integer (statement fact)
  closingBalancePkr: number | null;
  ledgerBalancePkr: number | null; // computed at completion, never client-supplied
  differencePkr: number | null; // closing - ledger, computed at completion
  differenceExplanation: string | null;
  statementDriveId: string | null;
  reconciledBy: string; // maker
  checkedBy: string | null; // checker, != reconciledBy
  status: ReconciliationStatus;
  completedAt?: TimestampLike;
  computedAt?: TimestampLike;
  complianceObligationId: string | null;
  createdAt?: TimestampLike;
  updatedAt?: TimestampLike;
}

/* ---------------- Money approvals: money_approvals ---------------- */

export type MoneyApprovalTargetType =
  | 'order_verify_payment'
  | 'order_mark_paid'
  | 'order_confirm_seat'
  | 'order_refund'
  | 'order_soft_delete'
  | 'destination_change'
  | 'budget_approve'
  | 'ledger_post'
  | 'crm_financial_edit'
  | 'crm_status_active';

export type MoneyApprovalStatus =
  | 'pending'
  | 'approved_applied'
  | 'rejected'
  | 'expired'
  | 'apply_failed';

export interface MoneyApproval {
  id?: string;
  targetType: MoneyApprovalTargetType;
  targetId: string;
  targetCollection: string;
  changePayload: Record<string, unknown>;
  beforeSnapshot: Record<string, unknown>;
  reason: string | null;
  makerUid: string;
  makerRole: string;
  checkerUid: string | null;
  checkerRole: string | null;
  status: MoneyApprovalStatus;
  decisionNote?: string | null;
  applyError?: string | null;
  auditAction: string;
  createdAt?: TimestampLike;
  decidedAt?: TimestampLike;
  expiresAt?: TimestampLike;
}

/** The audit_logs action written when each target type is applied. */
export const MONEY_APPROVAL_AUDIT_ACTIONS: Record<MoneyApprovalTargetType, string> = {
  order_verify_payment: 'ORDER_PAYMENT_VERIFIED',
  order_mark_paid: 'ORDER_MARKED_PAID',
  order_confirm_seat: 'ORDER_SEAT_CONFIRMED',
  order_refund: 'ORDER_REFUNDED',
  order_soft_delete: 'ORDER_SOFT_DELETED',
  destination_change: 'PAYMENT_DESTINATION_CHANGED',
  budget_approve: 'BUDGET_APPROVED',
  ledger_post: 'LEDGER_POSTED',
  crm_financial_edit: 'CRM_FINANCIALS_EDITED',
  crm_status_active: 'CRM_ACTIVATED',
};

export const MONEY_APPROVAL_TARGET_COLLECTIONS: Record<MoneyApprovalTargetType, string> = {
  order_verify_payment: 'orders',
  order_mark_paid: 'orders',
  order_confirm_seat: 'orders',
  order_refund: 'orders',
  order_soft_delete: 'orders',
  destination_change: 'settings',
  budget_approve: 'finance_budgets',
  ledger_post: 'ledger_entries',
  crm_financial_edit: 'sponsors_partners',
  crm_status_active: 'sponsors_partners',
};

/* ---------------- Receipts inbox: finance_receipts ---------------- */

export type FinanceReceiptKind = 'inbound_payment' | 'officer_expense';

export interface FinanceReceipt {
  id?: string;
  officerUid: string;
  officerName: string;
  kind: FinanceReceiptKind;
  transactionDate: string; // ISO date
  amountPkr: number;
  description: string;
  receiptDriveId: string;
  receiptUrl: string;
  receiptHash: string | null;
  sourceOrderId: string | null;
  ledgerEntryId: string | null;
  deliveredToTreasurerAt?: TimestampLike;
  slaDueAt?: TimestampLike; // transactionDate + 14 days
  createdBy?: string;
  createdAt?: TimestampLike;
  updatedAt?: TimestampLike;
}

/* ---------------- Auditor appointments: auditor_appointments ---------------- */

export interface AuditorAppointment {
  id?: string; // fyLabel
  fyLabel: string;
  auditorName: string;
  firmName: string | null;
  appointedAt: string; // ISO date; duty date no later than 31 August
  appointedBy: 'board' | 'founder_fallback';
  fallback: boolean; // === (appointedBy === 'founder_fallback'); API keeps them consistent
  appointedByUid: string;
  engagementLetterDriveId: string | null;
  recordedBy?: string;
  createdAt?: TimestampLike;
  updatedAt?: TimestampLike;
}
