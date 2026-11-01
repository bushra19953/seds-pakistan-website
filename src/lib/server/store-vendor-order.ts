/**
 * store-vendor-order.ts: the ONE vendor-order implementation shared by
 * the two order writers (the checkout server action in
 * src/app/actions/store.ts and POST /api/store/orders). Money logic
 * written twice will drift; this module is the single copy both
 * writers call (PLAN-ge Section 1).
 *
 * Server-only. Every fact here comes from the SERVER product record a
 * writer already read for pricing; a client-sent price or spec field
 * is never read. Group-buy seats are GH's contract (R-10): writers
 * price group orders at the locked unitPricePkr returned by
 * assertGroupBuySeatAvailable and take the seat at order creation
 * through registerGroupBuySeat / registerGroupBuySeatTx; this module
 * only maps GH's error codes to buyer-facing messages.
 */

import { orderIdempotencyClaimId } from './order-idempotency';

export class VendorOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VendorOrderError';
  }
}

export const SHOP_METHOD_MISSING_ADMIN_MESSAGE =
  'Vendor checkout blocked: no shop payment method is configured. Set shopMethodKey in settings/payment_methods from Store Settings before taking shop orders.';

export const OUT_OF_STOCK_MESSAGE =
  'This product is out of stock and cannot be ordered right now.';

export const MIXED_ORDER_MESSAGE =
  'Shop products are bought one at a time. Please check out each shop product on its own.';

/** Facts about one referenced product, read from its server record. */
export interface VendorProductFacts {
  exists: boolean;
  vendorId: unknown;
  deliveryChargePkr: unknown;
  deliveryPromiseDays: unknown;
  stock: unknown;
  currency?: unknown;
}

/** Whole-rupee coercion: finite integer number or integer string, >= 0. */
export function coercePkrInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

export function isVendorFacts(facts: VendorProductFacts): boolean {
  return facts.exists && typeof facts.vendorId === 'string' && facts.vendorId !== '';
}

/** Delivery is money: a vendor product without it fails closed. */
export function requireDeliveryPkr(facts: VendorProductFacts): number {
  const delivery = coercePkrInt(facts.deliveryChargePkr);
  if (delivery === null) {
    throw new VendorOrderError('Product is missing its delivery charge. Order rejected.');
  }
  return delivery;
}

export function requireVendorStock(facts: VendorProductFacts): void {
  const stock = coercePkrInt(facts.stock);
  if (stock === null || stock < 1) {
    throw new VendorOrderError(OUT_OF_STOCK_MESSAGE);
  }
}

export interface VendorSellabilityFacts {
  exists: boolean;
  status: unknown;
  agreementStatus: unknown;
}

/**
 * The seller must be sellable AT ORDER CREATION, not only in the
 * catalogue (acceptance-audit fix, coordinator): the catalogue hides a
 * paused/exited/unsigned vendor's products, but checkout loads the
 * product directly, so without this re-check a direct checkout link
 * could still order from a vendor the founder has paused (V5's spirit)
 * or who never signed. Fail closed on every arm.
 */
export function requireVendorSellable(vendor: VendorSellabilityFacts): void {
  if (!vendor.exists) {
    throw new VendorOrderError('The seller for this product is not available. Order rejected.');
  }
  if (vendor.status !== 'active') {
    throw new VendorOrderError('The seller for this product is not currently selling. Order rejected.');
  }
  if (vendor.agreementStatus !== 'signed') {
    throw new VendorOrderError('The seller for this product has not completed onboarding. Order rejected.');
  }
}

export function requireVendorCurrencyPkr(facts: VendorProductFacts): void {
  if (facts.currency !== undefined && facts.currency !== null && facts.currency !== 'PKR') {
    throw new VendorOrderError('Vendor products are priced in PKR only. Order rejected.');
  }
}

/** Order instant + whole days, or null when the promise is unset/invalid. */
export function computePromisedDeliveryDate(nowMs: number, days: unknown): number | null {
  const parsed = coercePkrInt(days);
  if (parsed === null || parsed < 1) return null;
  return nowMs + parsed * 86400000;
}

/** GA's Order type stores promisedDeliveryDate as a YYYY-MM-DD date string. */
export function promisedDeliveryDateString(nowMs: number, days: unknown): string | null {
  const ms = computePromisedDeliveryDate(nowMs, days);
  return ms === null ? null : new Date(ms).toISOString().slice(0, 10);
}

/**
 * CHOICE-1 (R-4): the shop payment method is one top-level pointer,
 * settings/payment_methods.shopMethodKey. It resolves only when it
 * names an enabled method; anything else is "not configured".
 */
export function resolveShopMethodKey(settings: unknown): string | null {
  if (!settings || typeof settings !== 'object') return null;
  const doc = settings as Record<string, any>;
  const key = doc.shopMethodKey;
  if (typeof key !== 'string' || key === '') return null;
  return doc.methods?.[key]?.enabled === true ? key : null;
}

/* ------------------------------------------------------------ credits */

export interface StoreCreditLike {
  id: string;
  amountPkr: number;
  createdAtMs: number;
}

/**
 * Whole credits only, oldest first, skip-and-continue (CHOICE-2): a
 * credit larger than the remaining balance is left untouched for the
 * buyer's next order, never split. appliedPkr never exceeds capPkr.
 */
export function selectStoreCredits(
  credits: StoreCreditLike[],
  capPkr: number,
): { consumedIds: string[]; appliedPkr: number } {
  const sorted = [...credits].sort((a, b) =>
    a.createdAtMs !== b.createdAtMs ? a.createdAtMs - b.createdAtMs : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  let remaining = Math.max(0, capPkr);
  let appliedPkr = 0;
  const consumedIds: string[] = [];
  for (const credit of sorted) {
    if (credit.amountPkr > 0 && credit.amountPkr <= remaining) {
      consumedIds.push(credit.id);
      appliedPkr += credit.amountPkr;
      remaining -= credit.amountPkr;
    }
  }
  return { consumedIds, appliedPkr };
}

export function timestampToMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  const v = value as { toMillis?: unknown; toDate?: unknown; seconds?: unknown };
  if (typeof v.toMillis === 'function') {
    const ms = (v.toMillis as () => number)();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof v.toDate === 'function') {
    const d = (v.toDate as () => Date)();
    const ms = d instanceof Date ? d.getTime() : NaN;
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  return null;
}

/** Map credit docs (any timestamp shape) to selection input, dropping expired/invalid rows. */
export function creditsForSelection(
  docs: Array<{ id: string; data: Record<string, any> }>,
  nowMs: number,
): StoreCreditLike[] {
  const out: StoreCreditLike[] = [];
  for (const doc of docs) {
    const amountPkr = coercePkrInt(doc.data.amountPkr);
    if (amountPkr === null || amountPkr <= 0) continue;
    const expiresMs = timestampToMs(doc.data.expiresAt);
    if (expiresMs !== null && expiresMs <= nowMs) continue;
    out.push({ id: doc.id, amountPkr, createdAtMs: timestampToMs(doc.data.createdAt) ?? 0 });
  }
  return out;
}

export interface CreditTxPlan {
  creditAppliedPkr: number;
  consumedIds: string[];
  creditRefs: Array<{ id: string; ref: any }>;
}

async function readCreditPlanInTransaction(
  t: any,
  db: { collection: (name: string) => any },
  args: { buyerUid: string; capPkr: number; nowMs: number },
): Promise<CreditTxPlan> {
  const query = db
    .collection('store_credits')
    .where('userId', '==', args.buyerUid)
    .where('state', '==', 'available')
    .orderBy('createdAt', 'asc')
    .limit(50);
  const snap = await t.get(query);
  const docs: Array<{ id: string; data: Record<string, any>; ref: any }> = (snap.docs || []).map((d: any) => ({
    id: d.id,
    data: d.data() || {},
    ref: d.ref,
  }));
  const selection = selectStoreCredits(creditsForSelection(docs, args.nowMs), args.capPkr);
  const byId = new Map(docs.map((d) => [d.id, d.ref]));
  return {
    creditAppliedPkr: selection.appliedPkr,
    consumedIds: selection.consumedIds,
    creditRefs: selection.consumedIds.map((id) => ({ id, ref: byId.get(id) })),
  };
}

function applyCreditPlanInTransaction(t: any, plan: CreditTxPlan, orderId: string): void {
  for (const { ref } of plan.creditRefs) {
    // Spec 2.7 has no updatedAt on store_credits; consumption flips
    // exactly these two fields (GA's updateStoreCredit agrees).
    t.update(ref, { state: 'consumed', consumedOrderId: orderId });
  }
}

/**
 * Firestore legs: selection reads happen inside the caller's
 * transaction BEFORE any write, so a group seat registration (which
 * writes) can run between this plan and applyCreditConsumptionInTransaction
 * without breaking Firestore's reads-before-writes law.
 */
export async function planStoreCreditsInTransaction(
  t: any,
  db: { collection: (name: string) => any },
  args: { buyerUid: string; capPkr: number; nowMs: number },
): Promise<CreditTxPlan> {
  return readCreditPlanInTransaction(t, db, args);
}

export function applyCreditConsumptionInTransaction(t: any, plan: CreditTxPlan, orderId: string): void {
  applyCreditPlanInTransaction(t, plan, orderId);
}

/** Plan + apply in one call, for callers with no write between the two. */
export async function consumeStoreCreditsInTransaction(
  t: any,
  db: { collection: (name: string) => any },
  args: { buyerUid: string; capPkr: number; orderId: string; nowMs: number },
): Promise<{ creditAppliedPkr: number; consumedIds: string[] }> {
  const plan = await readCreditPlanInTransaction(t, db, args);
  applyCreditPlanInTransaction(t, plan, args.orderId);
  return { creditAppliedPkr: plan.creditAppliedPkr, consumedIds: plan.consumedIds };
}

/* --------------------------------------- primacy legs: claim-first */

export interface CreditClaimResult {
  orderId: string;
  creditAppliedPkr: number;
  consumedIds: string[];
  alreadyClaimed: boolean;
}

/**
 * Supabase primacy legs have no cross-database transaction, so credits
 * are consumed claim-first (PLAN-ge 6.4): one Firestore transaction
 * writes the consumed flips plus a claim doc at
 * store_credit_claims/{buyerUid}__{base64url(idempotencyKey)} keyed to
 * the pre-minted order id. A replay finds the claim and consumes
 * nothing. restoreStoreCreditConsumption is the compensating undo for
 * when the order write then fails or loses an idempotency race.
 */
export async function planStoreCreditConsumption(
  db: { collection: (name: string) => any; runTransaction: (fn: (t: any) => Promise<any>) => Promise<any> },
  args: { buyerUid: string; idempotencyKey: string; orderId: string; capPkr: number; nowMs: number; claimTimestamp: unknown },
): Promise<CreditClaimResult> {
  const claimRef = db
    .collection('store_credit_claims')
    .doc(orderIdempotencyClaimId(args.buyerUid, args.idempotencyKey));
  return db.runTransaction(async (t: any) => {
    const claimSnap = await t.get(claimRef);
    if (claimSnap.exists) {
      const data = claimSnap.data() || {};
      return {
        orderId: typeof data.orderId === 'string' ? data.orderId : args.orderId,
        creditAppliedPkr: typeof data.creditAppliedPkr === 'number' ? data.creditAppliedPkr : 0,
        consumedIds: Array.isArray(data.consumedIds) ? data.consumedIds : [],
        alreadyClaimed: true,
      };
    }
    const plan = await readCreditPlanInTransaction(t, db, args);
    applyCreditPlanInTransaction(t, plan, args.orderId);
    t.set(claimRef, {
      orderId: args.orderId,
      buyerUid: args.buyerUid,
      idempotencyKey: args.idempotencyKey,
      creditAppliedPkr: plan.creditAppliedPkr,
      consumedIds: plan.consumedIds,
      createdAt: args.claimTimestamp,
    });
    return {
      orderId: args.orderId,
      creditAppliedPkr: plan.creditAppliedPkr,
      consumedIds: plan.consumedIds,
      alreadyClaimed: false,
    };
  });
}

export async function restoreStoreCreditConsumption(
  db: { collection: (name: string) => any; runTransaction: (fn: (t: any) => Promise<any>) => Promise<any> },
  args: { buyerUid: string; idempotencyKey: string; consumedIds: string[] },
): Promise<void> {
  const claimRef = db
    .collection('store_credit_claims')
    .doc(orderIdempotencyClaimId(args.buyerUid, args.idempotencyKey));
  await db.runTransaction(async (t: any) => {
    const claimSnap = await t.get(claimRef);
    if (!claimSnap.exists) return;
    const claim = claimSnap.data() || {};
    const ids: string[] = Array.isArray(claim.consumedIds) ? claim.consumedIds : args.consumedIds;
    const refs = ids.map((id) => db.collection('store_credits').doc(id));
    const snaps = [];
    for (const ref of refs) snaps.push(await t.get(ref));
    for (let i = 0; i < refs.length; i++) {
      const data = snaps[i].exists ? snaps[i].data() : null;
      // Idempotent: only a credit this claim's order consumed is freed.
      if (data && data.state === 'consumed' && data.consumedOrderId === claim.orderId) {
        t.update(refs[i], { state: 'available', consumedOrderId: null });
      }
    }
    t.delete(claimRef);
  });
}

/* --------------------------------------------------------- order shape */

/** The 15 spec fields (BUILD_SPEC 2.3) a client may never set at creation. */
export const VENDOR_SPEC_FIELDS = [
  'vendorId',
  'subtotalPkr',
  'deliveryPkr',
  'promisedDeliveryDate',
  'groupBuyId',
  'escrowStatus',
  'creditAppliedPkr',
  'notFoundText',
  'courierName',
  'trackingNumber',
  'dispatchedAt',
  'deliveredAt',
  'fulfilmentNote',
  'commissionLedgerId',
  'payoutId',
] as const;

/**
 * Mass-assignment closure (OWASP): strip the spec fields from client
 * input before any spread. groupBuyId is the one sanctioned client
 * input on this surface; it is read from the original and validated
 * server-side, never spread through.
 */
export function stripVendorSpecFields(input: Record<string, any>): {
  clean: Record<string, any>;
  groupBuyId: string | null;
} {
  const groupBuyId =
    typeof input.groupBuyId === 'string' && input.groupBuyId !== '' ? input.groupBuyId : null;
  const clean = { ...input };
  for (const field of VENDOR_SPEC_FIELDS) delete clean[field];
  return { clean, groupBuyId };
}

/** The exact vendor field set both writers stamp on a vendor order. */
export function buildVendorOrderFields(args: {
  vendorId: string;
  subtotalPkr: number;
  deliveryPkr: number;
  promisedDeliveryDate: string | null;
  groupBuyId: string | null;
  creditAppliedPkr: number;
}): Record<string, unknown> {
  const totalPkr = args.subtotalPkr + args.deliveryPkr;
  return {
    vendorId: args.vendorId,
    subtotalPkr: args.subtotalPkr,
    deliveryPkr: args.deliveryPkr,
    totalPkr,
    total: totalPkr,
    promisedDeliveryDate: args.promisedDeliveryDate,
    groupBuyId: args.groupBuyId,
    escrowStatus: args.groupBuyId ? 'held' : 'none',
    creditAppliedPkr: args.creditAppliedPkr,
    notFoundText: null,
    courierName: null,
    trackingNumber: null,
    dispatchedAt: null,
    deliveredAt: null,
    fulfilmentNote: null,
    commissionLedgerId: null,
    payoutId: null,
  };
}

/* --------------------------------------------------------- classification */

export interface ReferencedLine {
  productId: string;
  quantity: number;
}

export type VendorClassification =
  | { kind: 'house' }
  | { kind: 'vendor'; productId: string; facts: VendorProductFacts };

/**
 * Vendor detection (PLAN-ge Section 2): exactly one distinct product,
 * that product is a vendor product, total quantity exactly 1. Anything
 * else involving a vendor product is rejected fail-closed.
 */
export function classifyVendorOrder(
  lines: ReferencedLine[],
  factsById: Map<string, VendorProductFacts>,
): VendorClassification {
  const referencedIds = [...new Set(lines.map((l) => l.productId).filter(Boolean))];
  const vendorIds = referencedIds.filter((id) => {
    const facts = factsById.get(id);
    return facts ? isVendorFacts(facts) : false;
  });
  if (vendorIds.length === 0) return { kind: 'house' };
  const totalQuantity = lines.reduce((sum, l) => sum + (l.quantity || 0), 0);
  if (referencedIds.length !== 1 || totalQuantity !== 1) {
    throw new VendorOrderError(MIXED_ORDER_MESSAGE);
  }
  const productId = referencedIds[0];
  return { kind: 'vendor', productId, facts: factsById.get(productId)! };
}

/** GH's GroupBuyError codes, mapped to PLAN-ge Section 7.2 buyer messages. */
const GROUP_BUY_MESSAGES: Record<string, string> = {
  TEAM_NOT_FOUND: 'That team could not be found. Please rejoin from the team page.',
  PRODUCT_MISMATCH: 'That team is for a different product.',
  TEAM_NOT_OPEN: 'That team is no longer open, so this order cannot join it.',
  TEAM_EXPIRED: 'That team is no longer open, so this order cannot join it.',
  TEAM_FULL: 'That team is already full.',
  ALREADY_SEATED: 'You already have a seat in this team.',
  SEAT_ORDER_CONFLICT: 'You already have a seat in this team.',
};

/** Convert a GH seat error to a VendorOrderError; pass anything else through. */
export function asVendorOrderError(error: unknown): unknown {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && GROUP_BUY_MESSAGES[code]) {
      return new VendorOrderError(GROUP_BUY_MESSAGES[code]);
    }
  }
  return error;
}
