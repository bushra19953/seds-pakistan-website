
import { Timestamp } from 'firebase/firestore';

/* ------------------------------------------------------------------ */
/* Vendor shop pilot enums (BUILD_SPEC Section 2, PLAN-ga Section 3.1) */
/* ------------------------------------------------------------------ */

export const VENDOR_STATUSES = ['active', 'paused', 'exited'] as const;
export type VendorStatus = (typeof VENDOR_STATUSES)[number];

export const VENDOR_AGREEMENT_STATUSES = ['none', 'signed'] as const;
export type VendorAgreementStatus = (typeof VENDOR_AGREEMENT_STATUSES)[number];

export const PRODUCT_PRICE_RULES = ['parts_accessibility', 'tools_accessibility'] as const;
export type ProductPriceRule = (typeof PRODUCT_PRICE_RULES)[number];

export const ORDER_ESCROW_STATUSES = ['none', 'held', 'released', 'refunded'] as const;
export type OrderEscrowStatus = (typeof ORDER_ESCROW_STATUSES)[number];

export const COMMISSION_LEDGER_STATES = ['accrued', 'payable', 'held_dispute', 'paid', 'reversed'] as const;
export type CommissionLedgerState = (typeof COMMISSION_LEDGER_STATES)[number];

export const COMMISSION_LEDGER_TYPES = ['accrual', 'adjustment'] as const;
export type CommissionLedgerType = (typeof COMMISSION_LEDGER_TYPES)[number];

export const VENDOR_PAYOUT_STATUSES = ['draft', 'pending_approval', 'approved', 'transferred', 'rejected'] as const;
export type VendorPayoutStatus = (typeof VENDOR_PAYOUT_STATUSES)[number];

export const STORE_WAITLIST_SOURCES = ['product_page_oos', 'product_page_rail', 'store_search_empty', 'order_confirmation'] as const;
export type StoreWaitlistSource = (typeof STORE_WAITLIST_SOURCES)[number];

export const STORE_WAITLIST_STATUSES = ['open', 'notified', 'fulfilled', 'closed'] as const;
export type StoreWaitlistStatus = (typeof STORE_WAITLIST_STATUSES)[number];

export const GROUP_BUY_STATES = ['open', 'filled', 'expired', 'completed', 'cancelled'] as const;
export type GroupBuyState = (typeof GROUP_BUY_STATES)[number];

export const STORE_CREDIT_STATES = ['available', 'consumed', 'expired'] as const;
export type StoreCreditState = (typeof STORE_CREDIT_STATES)[number];

const VENDOR_STATUS_SET: ReadonlySet<string> = new Set(VENDOR_STATUSES);
export function isVendorStatus(value: unknown): value is VendorStatus {
  return typeof value === 'string' && VENDOR_STATUS_SET.has(value);
}

const VENDOR_AGREEMENT_STATUS_SET: ReadonlySet<string> = new Set(VENDOR_AGREEMENT_STATUSES);
export function isVendorAgreementStatus(value: unknown): value is VendorAgreementStatus {
  return typeof value === 'string' && VENDOR_AGREEMENT_STATUS_SET.has(value);
}

const PRODUCT_PRICE_RULE_SET: ReadonlySet<string> = new Set(PRODUCT_PRICE_RULES);
export function isProductPriceRule(value: unknown): value is ProductPriceRule {
  return typeof value === 'string' && PRODUCT_PRICE_RULE_SET.has(value);
}

const ORDER_ESCROW_STATUS_SET: ReadonlySet<string> = new Set(ORDER_ESCROW_STATUSES);
export function isOrderEscrowStatus(value: unknown): value is OrderEscrowStatus {
  return typeof value === 'string' && ORDER_ESCROW_STATUS_SET.has(value);
}

const COMMISSION_LEDGER_STATE_SET: ReadonlySet<string> = new Set(COMMISSION_LEDGER_STATES);
export function isCommissionLedgerState(value: unknown): value is CommissionLedgerState {
  return typeof value === 'string' && COMMISSION_LEDGER_STATE_SET.has(value);
}

const COMMISSION_LEDGER_TYPE_SET: ReadonlySet<string> = new Set(COMMISSION_LEDGER_TYPES);
export function isCommissionLedgerType(value: unknown): value is CommissionLedgerType {
  return typeof value === 'string' && COMMISSION_LEDGER_TYPE_SET.has(value);
}

const VENDOR_PAYOUT_STATUS_SET: ReadonlySet<string> = new Set(VENDOR_PAYOUT_STATUSES);
export function isVendorPayoutStatus(value: unknown): value is VendorPayoutStatus {
  return typeof value === 'string' && VENDOR_PAYOUT_STATUS_SET.has(value);
}

const STORE_WAITLIST_SOURCE_SET: ReadonlySet<string> = new Set(STORE_WAITLIST_SOURCES);
export function isStoreWaitlistSource(value: unknown): value is StoreWaitlistSource {
  return typeof value === 'string' && STORE_WAITLIST_SOURCE_SET.has(value);
}

const STORE_WAITLIST_STATUS_SET: ReadonlySet<string> = new Set(STORE_WAITLIST_STATUSES);
export function isStoreWaitlistStatus(value: unknown): value is StoreWaitlistStatus {
  return typeof value === 'string' && STORE_WAITLIST_STATUS_SET.has(value);
}

const GROUP_BUY_STATE_SET: ReadonlySet<string> = new Set(GROUP_BUY_STATES);
export function isGroupBuyState(value: unknown): value is GroupBuyState {
  return typeof value === 'string' && GROUP_BUY_STATE_SET.has(value);
}

const STORE_CREDIT_STATE_SET: ReadonlySet<string> = new Set(STORE_CREDIT_STATES);
export function isStoreCreditState(value: unknown): value is StoreCreditState {
  return typeof value === 'string' && STORE_CREDIT_STATE_SET.has(value);
}

export interface Product {
    id: string;
    name: string;
    description: string;
    price: number;
    currency: string;
    stock: number;
    category: string;
    eventId?: string;
    formId?: string; // Link to a custom form (from /admin/forms)
    isActive: boolean;
    imageUrl?: string;
    createdAt: Timestamp;
    updatedAt: Timestamp;
    createdBy: string;
    updatedBy?: string;
    /* Vendor shop pilot additions (spec 2.2). All optional: every
       existing house document lacks them. Presence rules for vendor
       products are enforced by the GB listing gates, not the types. */
    /** Public. Null or absent means house product. */
    vendorId?: string | null;
    /** Admin. Integer PKR. Absent means unset (gate test D1). Never null. */
    costPricePkr?: number;
    /** Public. Integer PKR. Absent means 0 for house products. */
    deliveryChargePkr?: number;
    /** Admin. Absent means unset (gate test D2). */
    priceRule?: ProductPriceRule;
    /** Admin. */
    competitorPricePkr?: number | null;
    /** Admin. */
    competitorSource?: string | null;
    /** Admin. Absent or null means unset (gate test D2). */
    competitorCheckedAt?: Timestamp | null;
    /** Admin. Absent means empty set. */
    warehousePhotoDriveIds?: string[];
    /** Public. Pilot value 2 on vendor products. */
    dispatchWindowWorkingDays?: number;
    /** Public. */
    deliveryPromiseDays?: number;
    /** Public. Absent means false. */
    groupBuyEligible?: boolean;
    /** Public. 2 to 5 when eligible. */
    groupBuyTeamSize?: number | null;
    /** Public. Pilot default 48 when eligible. */
    groupBuyWindowHours?: number | null;
}

export interface OrderItem {
    productId: string;
    productName: string;
    quantity: number;
    price: number;
    subtotal: number;
}

export interface Order {
    id: string;
    /**
     * CANONICAL identity field (CH-13, spec Part C 3.5). userId below is a
     * deprecated alias kept only for legacy readers; new writes set
     * buyerUserId and mirror userId during the dual-write window.
     */
    buyerUserId: string;
    /** @deprecated legacy alias of buyerUserId */
    userId?: string;
    items: OrderItem[];
    /** CANONICAL amount in whole PKR (spec 3.5). Null for donation orders until verification. */
    totalPkr: number | null;
    /** @deprecated compat dual-write mirroring totalPkr (removed after the migration window) */
    total?: number;
    /** Donation orders: the donor-declared amount until verification sets totalPkr. */
    declaredAmountPkr?: number | null;
    currency: string;
    /** CANONICAL status enum (spec 3.5). */
    status: 'pending_verification' | 'verified' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded' | 'soft_deleted';
    paymentMethod?: string; // e.g., 'bank_transfer', 'easypaisa', 'jazzcash'
    paymentStatus: 'pending' | 'completed' | 'failed' | 'refunded';
    receiptUrl?: string | null;
    receiptDriveId?: string | null;
    /** Soft-delete (spec 2.3): orders are never hard-deleted. */
    isDeleted?: boolean;
    deletedBy?: string;
    deleteReason?: string;
    deleteApprovalId?: string;
    fulfilmentNote?: string | null;
    proofOfPaymentUrl?: string; // Receipt URL
    shippingAddress?: {
        name: string;
        address: string;
        city: string;
        postalCode: string;
        country: string;
    };
    buyer?: {
        fullName: string;
        email: string;
        phone?: string;
    };
    notes?: string;
    formResponses?: Record<string, any>; // Responses to the custom linked form
    createdAt: Timestamp;
    updatedAt: Timestamp;
    createdBy: string;
    updatedBy?: string;
    originatingModule?: string; // 'store', 'chapter-registration', 'donation'
    eventId?: string;
    productId?: string; // For single-product orders
    testMode?: boolean;
    /** Vendor shop pilot (GF, ruling R-16): an open return claim holds the order's commission entry. Absent means false. */
    returnClaimOpen?: boolean;
    receiptUrl?: string; // Legacy field, mapping to proofOfPaymentUrl for consistency
    deletedAt?: Timestamp | null;
    deletedBy?: string | null;
    deletedByRole?: string | null;
    deleteReason?: string | null;
    /* Vendor shop pilot additions (spec 2.3). All optional: every
       existing house and pre-pilot order lacks them. */
    /** Vendor-own. Denormalized from the product at creation. */
    vendorId?: string | null;
    /** Buyer. Integer PKR, goods only. */
    subtotalPkr?: number;
    /** Buyer. Integer PKR. */
    deliveryPkr?: number;
    /** Buyer. */
    courierName?: string | null;
    /** Buyer. */
    trackingNumber?: string | null;
    /** Buyer. */
    dispatchedAt?: Timestamp | null;
    /** Buyer. */
    deliveredAt?: Timestamp | null;
    /** Buyer. YYYY-MM-DD. */
    promisedDeliveryDate?: string | null;
    /** Admin. */
    notFoundText?: string | null;
    /** Buyer. */
    groupBuyId?: string | null;
    /** Admin. Absent means 'none' (house and pre-pilot orders). */
    escrowStatus?: OrderEscrowStatus;
    /** Buyer. Absent means 0. */
    creditAppliedPkr?: number;
    /** Admin. Equals the order id when set (ledger doc id rule). */
    commissionLedgerId?: string | null;
    /** Admin. */
    payoutId?: string | null;
}

/* ------------------------------------------------------------------ */
/* Vendor shop pilot collections (spec 2.1, 2.4 to 2.7)                */
/* ------------------------------------------------------------------ */

/**
 * Spec 2.1, collection `vendors`. Field tiers: only `businessName` is
 * public tier; every other field is admin tier and must never appear
 * in a public or vendor payload (enforcement is GB and GH work; this
 * comment is the contract). Every field is required because
 * createVendor writes every field on every create, using null where
 * the spec allows null. `commissionRate` is a fraction (pilot 0.10),
 * not a percentage and not integer PKR.
 */
export interface Vendor {
  id: string;
  userId: string;
  businessName: string;
  contactName: string;
  phone: string;
  email: string;
  city: string;
  warehouseAddress: string;
  cnicNumber: string;
  bankName: string;
  bankAccountTitle: string;
  bankAccountNumber: string;
  agreementStatus: VendorAgreementStatus;
  agreementDriveFileId: string | null;
  agreementSignedAt: Timestamp | null;
  commissionRate: number;
  status: VendorStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  createdBy: string;
}

export type VendorCreateInput = Omit<Vendor, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * Spec 2.4, collection `commission_ledger`. Id rule: an accrual's
 * document id is its orderId, which makes a second accrual for one
 * order impossible. Adjustment entries cannot use the orderId (the
 * accrual holds it): an adjustment gets a Firestore auto-id, carries
 * the same orderId, type 'adjustment', and a negative vendorDuePkr.
 */
export interface CommissionLedgerEntry {
  id: string; // always equal to orderId for accruals; see the id rule above
  vendorId: string;
  orderId: string;
  type: CommissionLedgerType;
  salePricePkr: number;
  commissionRate: number;
  commissionPkr: number;
  vendorDuePkr: number;
  state: CommissionLedgerState;
  payoutId: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type CommissionLedgerAccrualInput = Omit<CommissionLedgerEntry, 'id' | 'createdAt' | 'updatedAt'>;

/** Spec 2.4, collection `vendor_payouts`. */
export interface VendorPayout {
  id: string;
  vendorId: string;
  periodStart: string; // YYYY-MM-DD, Monday of the paid week
  periodEnd: string; // YYYY-MM-DD, Sunday of the paid week
  entryIds: string[];
  grossPkr: number;
  commissionPkr: number;
  netPkr: number;
  financeApprovalId: string | null;
  status: VendorPayoutStatus;
  createdBy: string;
  createdAt: Timestamp;
  transferredAt: Timestamp | null;
}

export type VendorPayoutCreateInput = Omit<VendorPayout, 'id' | 'createdAt'>;

/** Spec 2.5, collection `store_waitlist`. No updatedAt: the spec lists only createdAt. */
export interface StoreWaitlistEntry {
  id: string;
  productId: string | null;
  requestedText: string;
  searchQuery: string | null;
  userId: string | null;
  contactName: string;
  contactPhone: string;
  contactEmail: string | null;
  source: StoreWaitlistSource;
  status: StoreWaitlistStatus;
  createdAt: Timestamp;
}

export type StoreWaitlistCreateInput = Omit<StoreWaitlistEntry, 'id' | 'createdAt'>;

/** Spec 2.6, collection `group_buys`. The caller supplies shareCode, opensAt, and expiresAt. */
export interface GroupBuy {
  id: string;
  productId: string;
  vendorId: string;
  shareCode: string;
  openerUserId: string;
  unitPricePkr: number;
  teamSizeTarget: number;
  memberOrderIds: string[];
  memberUserIds: string[];
  state: GroupBuyState;
  opensAt: Timestamp;
  expiresAt: Timestamp;
  refundApprovalIds: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type GroupBuyCreateInput = Omit<GroupBuy, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * Spec 2.7, collection `store_credits`. No updatedAt (spec lists
 * none). The caller supplies code (format LATE-<short id>) and
 * expiresAt (issued date plus 90 days).
 */
export interface StoreCredit {
  id: string;
  userId: string;
  code: string;
  amountPkr: number;
  sourceOrderId: string;
  groupBuyId: string;
  state: StoreCreditState;
  expiresAt: Timestamp;
  consumedOrderId: string | null;
  createdAt: Timestamp;
}

export type StoreCreditCreateInput = Omit<StoreCredit, 'id' | 'createdAt'>;
