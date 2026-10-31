/**
 * store-credits.ts: store credit operations for the vendor shop pilot
 * (spec 2.7). GF owns this module (coordinator ruling R-8). The data
 * layer underneath is GA's CRUD in src/lib/server/vendor-shop.ts; this
 * module adds the two operations GF's transitions need:
 *
 * - restore: credits an order consumed at creation (GE writes state
 *   'consumed' with consumedOrderId = the consuming order) go back to
 *   'available' when that order is refunded or cancelled before
 *   verification. The restore keys on exactly that pair, never on the
 *   order's creditAppliedPkr field, so a shape drift in the order
 *   cannot strand a buyer's credit.
 * - issue: a late group delivery issues one bounded credit. Its
 *   document id is deterministic, late_<orderId>, so a replayed
 *   delivery can never issue a second one.
 *
 * Transactional callers (the money-approval decide transaction, the
 * delivery and cancel helpers) use the prepare/write pair so every
 * read lands before every write, as Firestore transactions require.
 * Standalone callers use restoreCreditsForOrder, which composes GA's
 * updateStoreCredit.
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  STORE_CREDITS_COLLECTION,
  updateStoreCredit,
} from '@/lib/server/vendor-shop';

type DocRef = ReturnType<Firestore['doc']>;
type Tx = {
  get: (ref: never) => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
  update: (ref: never, data: Record<string, unknown>) => unknown;
  create: (ref: never, data: Record<string, unknown>) => unknown;
};

export const LATE_CREDIT_EXPIRY_DAYS = 90;
const MAX_CONSUMED_CREDITS_PER_ORDER = 50;

/** Spec 2.7 amount: 10% of the sale, rounded to the nearest PKR 10, floored at 100, capped at 500. */
export function computeLateDeliveryCreditPkr(subtotalPkr: number): number {
  if (!Number.isInteger(subtotalPkr) || subtotalPkr < 0) {
    throw new RangeError(
      `computeLateDeliveryCreditPkr: subtotalPkr must be a non-negative integer PKR amount, got ${subtotalPkr}`,
    );
  }
  const rounded = Math.round((subtotalPkr * 0.1) / 10) * 10;
  return Math.min(500, Math.max(100, rounded));
}

export function lateCreditIdForOrder(orderId: string): string {
  return `late_${orderId}`;
}

export function lateCreditCodeForOrder(orderId: string): string {
  return `LATE-${orderId.slice(0, 6).toUpperCase()}`;
}

function promisedToMillis(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [y, m, d] = value.split('-').map(Number);
      return Date.UTC(y, m - 1, d);
    }
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  const t = value as { toMillis?: () => number; seconds?: number };
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (typeof t.seconds === 'number') return t.seconds * 1000;
  return null;
}

/**
 * The promised date names a calendar date in Pakistan time; delivery
 * on that date is on time. Late means strictly after the end of that
 * date in Asia/Karachi (UTC+5, no daylight saving). A missing or
 * unparseable promise is never late and never an error: the promise
 * is GE's field and its absence cannot block a delivery.
 */
export function isLateDelivery(deliveredAtMs: number, promised: unknown): boolean {
  const promisedMs = promisedToMillis(promised);
  if (promisedMs == null) return false;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(promisedMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  if (!year || !month || !day) return false;
  // End of the promised date in PKT is 18:59:59.999 UTC the same day.
  const deadlineMs = Date.UTC(year, month - 1, day, 18, 59, 59, 999);
  return deliveredAtMs > deadlineMs;
}

/* ------------------------------------------------------------- restore */

export async function queryConsumedCreditRefs(db: Firestore, orderId: string): Promise<DocRef[]> {
  const snap = await db
    .collection(STORE_CREDITS_COLLECTION)
    .where('consumedOrderId', '==', orderId)
    .where('state', '==', 'consumed')
    .limit(MAX_CONSUMED_CREDITS_PER_ORDER)
    .get();
  return snap.docs.map((d) => d.ref as unknown as DocRef);
}

/** Read phase: keep only the queried credits that are still consumed by this order. */
export async function prepareCreditRestore(
  db: Firestore,
  tx: Tx,
  orderId: string,
): Promise<DocRef[]> {
  const refs = await queryConsumedCreditRefs(db, orderId);
  const kept: DocRef[] = [];
  for (const ref of refs) {
    const snap = await tx.get(ref as never);
    const data = snap.data();
    if (snap.exists && data?.state === 'consumed' && data?.consumedOrderId === orderId) {
      kept.push(ref);
    }
  }
  return kept;
}

/** Write phase: no reads, no throws by construction. */
export function writeCreditRestore(tx: Tx, creditRefs: DocRef[]): void {
  for (const ref of creditRefs) {
    tx.update(ref as never, {
      state: 'available',
      consumedOrderId: null,
      updatedAt: FieldValue.serverTimestamp(),
    } as never);
  }
}

/** Non-transactional restore for callers that hold no transaction. Returns how many credits were restored. */
export async function restoreCreditsForOrder(db: Firestore, orderId: string): Promise<number> {
  const refs = await queryConsumedCreditRefs(db, orderId);
  let restored = 0;
  for (const ref of refs) {
    const snap = await ref.get();
    const data = snap.data() as Record<string, unknown> | undefined;
    if (!snap.exists || data?.state !== 'consumed' || data?.consumedOrderId !== orderId) continue;
    await updateStoreCredit(db, ref.id, { state: 'available', consumedOrderId: null });
    restored += 1;
  }
  return restored;
}

/* --------------------------------------------------------------- issue */

export interface LateDeliveryCredit {
  id: string;
  code: string;
  amountPkr: number;
  expiresAt: Date;
  data: Record<string, unknown>;
}

export function buildLateDeliveryCredit(input: {
  orderId: string;
  userId: string;
  groupBuyId: string;
  subtotalPkr: number;
  deliveredAtMs: number;
}): LateDeliveryCredit {
  const id = lateCreditIdForOrder(input.orderId);
  const code = lateCreditCodeForOrder(input.orderId);
  const amountPkr = computeLateDeliveryCreditPkr(input.subtotalPkr);
  const expiresAt = new Date(input.deliveredAtMs + LATE_CREDIT_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  return {
    id,
    code,
    amountPkr,
    expiresAt,
    data: {
      userId: input.userId,
      code,
      amountPkr,
      sourceOrderId: input.orderId,
      groupBuyId: input.groupBuyId,
      state: 'available',
      expiresAt,
      consumedOrderId: null,
      createdAt: FieldValue.serverTimestamp(),
    },
  };
}

/** Write phase: create semantics make a second issuance for the same order fail instead of duplicating. */
export function writeLateDeliveryCredit(tx: Tx, db: Firestore, credit: LateDeliveryCredit): void {
  const ref = db.collection(STORE_CREDITS_COLLECTION).doc(credit.id);
  tx.create(ref as never, credit.data as never);
}
