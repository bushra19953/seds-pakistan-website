/**
 * Canonical order shape + compatibility reader (spec Part C section 3.6, CH-13).
 *
 * The orders collection is written in THREE incompatible shapes today:
 *  A (types/checkout): money field `total`, status `pending`, paymentStatus
 *     pending/completed/failed/refunded, buyer key `userId`, receipt key
 *     `proofOfPaymentUrl`.
 *  B (orders API POST): money field `amount`, status `pending_verification`
 *     then verified/processing/shipped/delivered/cancelled, buyer key
 *     `buyerUserId`, receipt key `receiptUrl`, no paymentStatus at creation.
 *  C (legacy admin page): money field `amount`, status pending_payment /
 *     paid / printed / shipped, buyer key `buyerUserId`, receipt `receiptUrl`.
 *
 * This module is PURE (no Firestore imports) so it is unit-testable without
 * mocks. normalizeOrder NEVER writes; migration is lazy (canonical-on-touch
 * by the money-approval apply step) and reporting reads through here.
 */

export type CanonicalOrderStatus =
  | 'pending_verification'
  | 'verified'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'refunded'
  | 'soft_deleted'
  | string; // unknown legacy values pass through, flagged via dataQuality.unknownStatus

export type CanonicalPaymentStatus = 'pending' | 'completed' | 'failed' | 'refunded' | string;

export interface CanonicalOrderItem {
  productId?: string;
  productName?: string;
  title?: string;
  quantity?: number;
  price?: number;
  subtotal?: number;
  type?: string;
  eventId?: string;
  [key: string]: unknown;
}

export interface CanonicalOrder {
  id: string;
  /** THE money field: integer rupees. Only written when currency is PKR. */
  totalPkr: number | null;
  currency: string;
  status: CanonicalOrderStatus;
  paymentStatus: CanonicalPaymentStatus;
  buyerUserId: string;
  buyer: { fullName?: string; email?: string; phone?: string } | null;
  items: CanonicalOrderItem[];
  receiptUrl: string | null;
  receiptDriveId: string | null;
  originatingModule: string | null;
  /** Donations only: donor-declared amount at creation; becomes totalPkr only at verification. */
  declaredAmountPkr: number | null;
  productId?: string | null;
  eventId?: string | null;
  certificateCode?: string | null;
  chapterApplicationId?: string | null;
  holderUserId?: string | null;
  isDeleted: boolean;
  deletedBy?: string | null;
  deletedAt?: unknown;
  deleteReason?: string | null;
  deleteApprovalId?: string | null;
  createdAt?: unknown;
  updatedAt?: unknown;
  createdBy?: string | null;
  dataQuality: { missingAmount: boolean; unknownStatus: boolean };
}

/** Legacy -> canonical status mapping (spec 3.6). Canonical values pass through. */
export const ORDER_STATUS_MAP: Record<string, string> = {
  pending: 'pending_verification',
  pending_payment: 'pending_verification',
  paid: 'verified',
  printed: 'processing',
};

export const CANONICAL_ORDER_STATUSES: ReadonlySet<string> = new Set([
  'pending_verification',
  'verified',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
  'soft_deleted',
]);

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function normalizeOrder(raw: Record<string, unknown>, id?: string): CanonicalOrder {
  const items = Array.isArray(raw.items) ? (raw.items as CanonicalOrderItem[]) : [];

  // totalPkr: totalPkr > total > amount > sum of item subtotals > missing
  let totalPkr = asNumber(raw.totalPkr);
  let missingAmount = false;
  if (totalPkr == null) totalPkr = asNumber(raw.total);
  if (totalPkr == null) totalPkr = asNumber(raw.amount);
  if (totalPkr == null) {
    if (items.length > 0) {
      totalPkr = items.reduce((sum, it) => sum + (asNumber(it.subtotal) ?? 0), 0);
    } else {
      totalPkr = 0;
      missingAmount = true;
    }
  }

  const rawStatus = typeof raw.status === 'string' ? raw.status : '';
  const mappedStatus = ORDER_STATUS_MAP[rawStatus] ?? rawStatus;
  const unknownStatus = rawStatus !== '' && !CANONICAL_ORDER_STATUSES.has(mappedStatus);

  // paymentStatus: present passes; absent with paid/verified -> completed; else pending.
  let paymentStatus: string;
  if (typeof raw.paymentStatus === 'string' && raw.paymentStatus) {
    paymentStatus = raw.paymentStatus;
  } else if (rawStatus === 'paid' || mappedStatus === 'verified') {
    paymentStatus = 'completed';
  } else {
    paymentStatus = 'pending';
  }

  return {
    id: id ?? (typeof raw.id === 'string' ? raw.id : ''),
    totalPkr,
    currency: typeof raw.currency === 'string' && raw.currency ? raw.currency : 'PKR',
    status: mappedStatus,
    paymentStatus,
    buyerUserId:
      (typeof raw.buyerUserId === 'string' && raw.buyerUserId) ||
      (typeof raw.userId === 'string' ? raw.userId : ''),
    buyer: (raw.buyer as CanonicalOrder['buyer']) ?? null,
    items,
    receiptUrl:
      (typeof raw.receiptUrl === 'string' && raw.receiptUrl) ||
      (typeof raw.proofOfPaymentUrl === 'string' ? raw.proofOfPaymentUrl : null),
    receiptDriveId:
      (typeof raw.receiptDriveId === 'string' && raw.receiptDriveId) ||
      (typeof raw.proofOfPaymentDriveFileId === 'string' ? raw.proofOfPaymentDriveFileId : null),
    originatingModule: typeof raw.originatingModule === 'string' ? raw.originatingModule : null,
    declaredAmountPkr: asNumber(raw.declaredAmountPkr),
    productId: (raw.productId as string) ?? null,
    eventId: (raw.eventId as string) ?? null,
    certificateCode: (raw.certificateCode as string) ?? null,
    chapterApplicationId: (raw.chapterApplicationId as string) ?? null,
    holderUserId: (raw.holderUserId as string) ?? null,
    isDeleted: raw.isDeleted === true || mappedStatus === 'soft_deleted',
    deletedBy: (raw.deletedBy as string) ?? null,
    deletedAt: raw.deletedAt,
    deleteReason: (raw.deleteReason as string) ?? null,
    deleteApprovalId: (raw.deleteApprovalId as string) ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    createdBy: (raw.createdBy as string) ?? null,
    dataQuality: { missingAmount, unknownStatus },
  };
}

/** Map an originatingModule to its ledger income category (spec 4.5). */
export function ledgerCategoryForModule(originatingModule: string | null): string {
  switch (originatingModule) {
    case 'donation':
      return 'donations';
    case 'chapter-registration':
      return 'chapter_fees';
    case 'Events':
      return 'event_income';
    case 'Certificates':
    case 'store':
      return 'store_sales';
    default:
      return 'other_income';
  }
}
