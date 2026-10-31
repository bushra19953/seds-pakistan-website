/**
 * Vendor surface enforcement + views (GG-owned, spec 3.1 rules 1-5).
 *
 * Vendor resolution itself is GB's: this module wraps
 * `resolveActiveVendorByUid` from `@/lib/server/vendor-access` and owns
 * everything after resolution: the stripped view mappers (rule 5 lives
 * in exactly one place), the fulfilment PATCH validator (rule 4), the
 * bounded query builders, and the balance helpers.
 *
 * Authorization is resolved server-side from the verified token uid on
 * EVERY call. No vendorId, role, or status is ever read from a request.
 */
import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import type { Firestore } from 'firebase-admin/firestore';
import { getDb } from '@/lib/server/firebase-admin';
import { resolveActiveVendorByUid } from '@/lib/server/vendor-access';

export interface VendorRecord {
  id: string;
  userId: string;
  businessName: string;
  status: 'active' | 'paused' | 'exited';
  agreementStatus: 'none' | 'signed';
  commissionRate: number;
}

export interface VendorContext {
  uid: string;
  db: Firestore;
  vendor: VendorRecord;
}

export class VendorAccessError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function vendorErrorResponse(err: unknown): NextResponse {
  if (err instanceof VendorAccessError) {
    const fields = (err as unknown as { fields?: string[] }).fields;
    return NextResponse.json(
      { error: err.message, code: err.code, ...(fields ? { fields } : {}) },
      { status: err.status },
    );
  }
  console.error('[vendor] internal error:', err);
  return NextResponse.json({ error: 'Internal error' }, { status: 500 });
}

export async function authenticateVendorCaller(
  request: NextRequest,
): Promise<{ uid: string; db: Firestore }> {
  const db = getDb();
  if (!db) throw new VendorAccessError(500, 'internal', 'Firestore not initialized');
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new VendorAccessError(401, 'unauthorized', 'Unauthorized');
  }
  try {
    const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
    return { uid: decoded.uid, db };
  } catch {
    throw new VendorAccessError(401, 'unauthorized', 'Unauthorized');
  }
}

export async function requireVendorContext(request: NextRequest): Promise<VendorContext> {
  const { uid, db } = await authenticateVendorCaller(request);
  let resolved: unknown;
  try {
    resolved = await resolveActiveVendorByUid(db as never, uid);
  } catch (e) {
    const err = e as { status?: number; code?: string; message?: string };
    if (typeof err?.status === 'number') {
      throw new VendorAccessError(err.status, err.code ?? 'vendor_not_active', err.message ?? 'Vendor access denied');
    }
    throw e;
  }
  if (!resolved || typeof resolved !== 'object') {
    throw new VendorAccessError(403, 'vendor_record_missing', 'Vendor access denied');
  }
  const vendor = resolved as VendorRecord;
  if (vendor.status !== 'active') {
    throw new VendorAccessError(403, 'vendor_not_active', 'Vendor access denied');
  }
  return { uid, db, vendor };
}

export const VENDOR_VISIBLE_STATUSES = ['verified', 'processing', 'shipped', 'delivered', 'refunded'] as const;

export function vendorProductsQuery(db: Firestore, vendorId: string) {
  return db.collection('products').where('vendorId', '==', vendorId).orderBy('name', 'asc').limit(50);
}

export function vendorOrdersQuery(db: Firestore, vendorId: string) {
  return db
    .collection('orders')
    .where('vendorId', '==', vendorId)
    .where('status', 'in', [...VENDOR_VISIBLE_STATUSES])
    .orderBy('createdAt', 'desc');
}

export function vendorLedgerQuery(db: Firestore, vendorId: string) {
  return db.collection('commission_ledger').where('vendorId', '==', vendorId).orderBy('createdAt', 'desc');
}

export function vendorPayoutsQuery(db: Firestore, vendorId: string) {
  return db.collection('vendor_payouts').where('vendorId', '==', vendorId).orderBy('createdAt', 'desc');
}

export function assertVendorOwns(ctx: VendorContext, recordVendorId: unknown): void {
  if (recordVendorId !== ctx.vendor.id) {
    throw new VendorAccessError(404, 'not_found', 'Not found');
  }
}

/* ---------------- timestamps ---------------- */

export function toIsoOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  const v = value as { toDate?: () => Date; seconds?: number };
  if (typeof v.toDate === 'function') {
    try {
      return v.toDate().toISOString();
    } catch {
      return null;
    }
  }
  if (typeof v.seconds === 'number') return new Date(v.seconds * 1000).toISOString();
  return null;
}

const TIMESTAMP_FIELDS = ['createdAt', 'updatedAt', 'dispatchedAt', 'deliveredAt', 'verifiedAt', 'transferredAt'] as const;

export function serializeVendorTimestamps<T extends Record<string, unknown>>(view: T): T {
  const out = { ...view };
  for (const f of TIMESTAMP_FIELDS) {
    if (f in out) (out as Record<string, unknown>)[f] = toIsoOrNull(out[f]);
  }
  return out;
}

/* ---------------- view mappers (rule 5: allowlists, never spread) ---------------- */

type DocLike = { id: string; data: Record<string, unknown> };

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
export function toVendorProductView(doc: DocLike): Record<string, unknown> {
  const d = doc.data;
  return serializeVendorTimestamps({
    id: doc.id,
    name: d.name ?? null,
    description: d.description ?? null,
    price: d.price ?? null,
    currency: d.currency ?? null,
    stock: d.stock ?? null,
    category: d.category ?? null,
    imageUrl: d.imageUrl ?? null,
    isActive: d.isActive ?? null,
    deliveryChargePkr: d.deliveryChargePkr ?? null,
    dispatchWindowWorkingDays: d.dispatchWindowWorkingDays ?? null,
    deliveryPromiseDays: d.deliveryPromiseDays ?? null,
    groupBuyEligible: d.groupBuyEligible ?? null,
  });
}

export function toVendorOrderView(doc: DocLike): Record<string, unknown> {
  const d = doc.data;
  const buyer = (d.buyer ?? {}) as Record<string, unknown>;
  const shipping = (d.shippingAddress ?? {}) as Record<string, unknown>;
  const items = Array.isArray(d.items)
    ? (d.items as Array<Record<string, unknown>>).map((it) => ({
        productId: it.productId ?? null,
        productName: it.productName ?? it.title ?? null,
        quantity: it.quantity ?? null,
        price: it.price ?? null,
        subtotal: it.subtotal ?? null,
      }))
    : [];
  return serializeVendorTimestamps({
    id: doc.id,
    items,
    subtotalPkr: d.subtotalPkr ?? null,
    deliveryPkr: d.deliveryPkr ?? null,
    totalPkr: d.totalPkr ?? d.total ?? null,
    currency: d.currency ?? null,
    status: d.status ?? null,
    paymentStatus: d.paymentStatus ?? null,
    buyerName: str(buyer.fullName) ?? str(shipping.name),
    buyerPhone: str(buyer.phone) ?? str(buyer.whatsappNumber),
    shippingAddress: Object.keys(shipping).length > 0 ? shipping : null,
    courierName: d.courierName ?? null,
    trackingNumber: d.trackingNumber ?? null,
    dispatchedAt: d.dispatchedAt ?? null,
    deliveredAt: d.deliveredAt ?? null,
    promisedDeliveryDate: d.promisedDeliveryDate ?? null,
    verifiedAt: d.verifiedAt ?? null,
    isGroupOrder: typeof d.groupBuyId === 'string' && d.groupBuyId.length > 0,
    createdAt: d.createdAt ?? null,
    updatedAt: d.updatedAt ?? null,
  });
}

export function toVendorLedgerView(doc: DocLike): Record<string, unknown> {
  const d = doc.data;
  return serializeVendorTimestamps({
    id: doc.id,
    orderId: d.orderId ?? null,
    type: d.type ?? null,
    salePricePkr: d.salePricePkr ?? null,
    commissionRate: d.commissionRate ?? null,
    commissionPkr: d.commissionPkr ?? null,
    vendorDuePkr: d.vendorDuePkr ?? null,
    state: d.state ?? null,
    payoutId: d.payoutId ?? null,
    createdAt: d.createdAt ?? null,
    updatedAt: d.updatedAt ?? null,
  });
}

export function toVendorPayoutView(doc: DocLike): Record<string, unknown> {
  const d = doc.data;
  return serializeVendorTimestamps({
    id: doc.id,
    periodStart: d.periodStart ?? null,
    periodEnd: d.periodEnd ?? null,
    grossPkr: d.grossPkr ?? null,
    commissionPkr: d.commissionPkr ?? null,
    netPkr: d.netPkr ?? null,
    status: d.status ?? null,
    entryIds: Array.isArray(d.entryIds) ? d.entryIds : [],
    createdAt: d.createdAt ?? null,
    transferredAt: d.transferredAt ?? null,
  });
}

/* ---------------- fulfilment PATCH validation (rule 4) ---------------- */

export const FULFILMENT_PATCH_FIELDS = ['courierName', 'trackingNumber', 'status'] as const;

export function validateFulfilmentPatch(
  body: unknown,
  current: { status: string; courierName: string | null; trackingNumber: string | null },
): { courierName?: string; trackingNumber?: string; toStatus?: 'shipped' | 'delivered' } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new VendorAccessError(422, 'validation', 'Request body must be an object');
  }
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !(FULFILMENT_PATCH_FIELDS as readonly string[]).includes(k));
  if (extra.length > 0) {
    const err = new VendorAccessError(409, 'forbidden_field', 'Only courierName, trackingNumber and status can be updated');
    (err as unknown as { fields: string[] }).fields = extra;
    throw err;
  }
  const out: { courierName?: string; trackingNumber?: string; toStatus?: 'shipped' | 'delivered' } = {};
  for (const f of ['courierName', 'trackingNumber'] as const) {
    if (b[f] !== undefined) {
      if (typeof b[f] !== 'string' || (b[f] as string).trim().length === 0) {
        throw new VendorAccessError(422, 'validation', `${f} must be a non-empty string`);
      }
      out[f] = (b[f] as string).trim();
    }
  }
  if (b.status !== undefined) {
    if (b.status !== 'shipped' && b.status !== 'delivered') {
      throw new VendorAccessError(409, 'forbidden_field', 'Only shipped and delivered status changes are allowed');
    }
    out.toStatus = b.status;
  }
  if (out.toStatus === 'shipped') {
    if (!['verified', 'processing'].includes(current.status)) {
      throw new VendorAccessError(409, 'invalid_transition', 'Only a verified or processing order can be marked shipped');
    }
    const courier = out.courierName ?? current.courierName;
    const tracking = out.trackingNumber ?? current.trackingNumber;
    if (!courier || !tracking) {
      throw new VendorAccessError(422, 'validation', 'Courier name and tracking number are required to mark an order shipped');
    }
  } else if (out.toStatus === 'delivered') {
    if (current.status !== 'shipped') {
      throw new VendorAccessError(409, 'invalid_transition', 'Only a shipped order can be marked delivered');
    }
  } else {
    if (!['verified', 'processing', 'shipped'].includes(current.status)) {
      throw new VendorAccessError(409, 'invalid_transition', 'Tracking can only be updated on an active order');
    }
  }
  return out;
}

/* ---------------- balance helpers ---------------- */

export function nextPayoutDate(from: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(from);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const y = Number(get('year'));
  const m = Number(get('month'));
  const d = Number(get('day'));
  const weekday = get('weekday');
  const dayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  const addDays = (1 - dayIdx + 7) % 7; // Monday is 1; today when Monday
  const base = new Date(Date.UTC(y, m - 1, d + addDays));
  return base.toISOString().slice(0, 10);
}

export function sumLedgerByState(rows: Array<{ state: string; vendorDuePkr: number }>): {
  accruedPkr: number;
  payablePkr: number;
  paidPkr: number;
  heldDisputePkr: number;
  heldDisputeCount: number;
} {
  const out = { accruedPkr: 0, payablePkr: 0, paidPkr: 0, heldDisputePkr: 0, heldDisputeCount: 0 };
  for (const r of rows) {
    const amt = typeof r.vendorDuePkr === 'number' ? r.vendorDuePkr : 0;
    if (r.state === 'accrued') out.accruedPkr += amt;
    else if (r.state === 'payable') out.payablePkr += amt;
    else if (r.state === 'paid') out.paidPkr += amt;
    else if (r.state === 'held_dispute') {
      out.heldDisputePkr += amt;
      out.heldDisputeCount += 1;
    }
  }
  return out;
}

export function parseLimit(raw: string | null, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) throw new VendorAccessError(400, 'bad_request', 'limit is invalid');
  return Math.min(Math.floor(n), 50);
}
