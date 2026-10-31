/**
 * vendor-money.ts: the vendor shop pilot's standalone money helpers
 * that are not the delivery transition (PLAN-gf Sections 5.4, 5.5,
 * 6.4, 7). Delivery lives in src/lib/server/vendor-delivery.ts
 * (ruling R-9); commission math lives in GA's
 * src/lib/server/store-commission.ts (ruling R-7); store credit
 * operations live in src/lib/server/store-credits.ts (ruling R-8).
 * This module imports none of the money-approval engine, so the
 * engine can import from it without a cycle.
 *
 * Every helper is server-only and takes every money input from
 * server documents. No caller-supplied amount, rate, or timestamp
 * is ever accepted.
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { writeFinanceAudit } from '@/lib/server/finance-audit';
import {
  prepareCreditRestore,
  writeCreditRestore,
} from '@/lib/server/store-credits';

export class VendorMoneyError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, opts?: { code?: string }) {
    super(message);
    this.status = status;
    this.code = opts?.code;
  }
}

type DocRef = ReturnType<Firestore['doc']>;
type Tx = {
  get: (ref: never) => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
  set: (ref: never, data: Record<string, unknown>, opts?: { merge?: boolean }) => unknown;
  update: (ref: never, data: Record<string, unknown>) => unknown;
  create: (ref: never, data: Record<string, unknown>) => unknown;
};

function tsNow(): unknown {
  return FieldValue.serverTimestamp();
}

/**
 * The stock line of an order: the top-level productId when present,
 * else the first item's. Quantity is the sum over matching items; a
 * missing item quantity counts as 1. Pilot checkout is
 * single-product, quantity 1, but the sum keeps this honest if an
 * item list ever carries more.
 */
export function resolveOrderStockLine(
  targetData: Record<string, unknown>,
): { productId: string; quantity: number } | null {
  const items = Array.isArray(targetData.items)
    ? (targetData.items as Array<Record<string, unknown>>)
    : [];
  let productId =
    typeof targetData.productId === 'string' && targetData.productId ? targetData.productId : null;
  if (!productId) {
    const first = items.find((i) => typeof i?.productId === 'string' && i.productId);
    productId = first ? (first.productId as string) : null;
  }
  if (!productId) return null;
  let quantity = 0;
  for (const item of items) {
    if (item?.productId === productId) {
      quantity += typeof item.quantity === 'number' && item.quantity > 0 ? item.quantity : 1;
    }
  }
  if (quantity === 0) quantity = 1;
  return { productId, quantity };
}

/**
 * The payout-draft inclusion contract (PLAN-gf Section 7), shared
 * with GG's draft builder: an entry is includable only in state
 * 'payable', and a group order's entry stays excluded while its
 * escrow is held. Adjustment entries in state 'payable' ARE
 * eligible; that is how a refund after payout is recovered from
 * the next payout.
 */
export function isLedgerEntryPayoutEligible(
  entry: { state: string; type?: string },
  order: { escrowStatus?: string | null } | null,
): boolean {
  if (!entry || entry.state !== 'payable') return false;
  if (order && order.escrowStatus === 'held') return false;
  return true;
}

/**
 * The orders PATCH guard (PLAN-gf Section 6.4). Evaluated only when
 * the requested status is 'delivered' or 'cancelled'; any other
 * PATCH is untouched. Vendor deliveries and credit-or-team
 * cancellations carry money effects that live only in the GF
 * helpers, so the bare-status path refuses them loudly.
 */
export function vendorPatchGuard(
  orderData: Record<string, unknown>,
  updates: Record<string, unknown>,
): { blocked: true; status: 409; error: string } | { blocked: false } {
  const status = updates.status;
  if (status !== 'delivered' && status !== 'cancelled') return { blocked: false };
  if (status === 'delivered') {
    if (typeof orderData.vendorId === 'string' && orderData.vendorId) {
      return {
        blocked: true,
        status: 409,
        error:
          'Vendor orders are marked delivered through the delivery action, so commission and store credit are recorded. Use the delivery action for this order.',
      };
    }
    return { blocked: false };
  }
  const creditApplied =
    typeof orderData.creditAppliedPkr === 'number' ? orderData.creditAppliedPkr : 0;
  const hasTeam = typeof orderData.groupBuyId === 'string' && !!orderData.groupBuyId;
  if (creditApplied > 0 || hasTeam) {
    return {
      blocked: true,
      status: 409,
      error:
        'This order holds store credit or a group seat. Cancel it through the cancel action, so the credit and the seat are released.',
    };
  }
  return { blocked: false };
}

/* ------------------------------------------- pre-verification cancel */

export interface CancelOrderResult {
  orderId: string;
  alreadyCancelled: boolean;
  groupBuyId: string | null;
  creditsRestored: number;
}

/**
 * Transition 2: pending_verification -> cancelled (PLAN-gf
 * Section 5.4). No ledger entry can exist yet and no stock has
 * moved, so the only side effect is restoring consumed store
 * credit. Verified-or-later orders leave only through the refund
 * approvals path; this helper never becomes a side door around
 * maker-checker. GH's expiry sweep calls this directly.
 */
export async function cancelPreVerificationOrder(
  db: Firestore,
  input: { orderId: string; actorUid: string },
): Promise<CancelOrderResult> {
  const orderRef = db.collection('orders').doc(input.orderId);
  let groupBuyId: string | null = null;
  return db.runTransaction(async (txRaw) => {
    const tx = txRaw as unknown as Tx;
    const orderSnap = await tx.get(orderRef as never);
    if (!orderSnap.exists) {
      throw new VendorMoneyError(404, 'Order not found');
    }
    const order = orderSnap.data() ?? {};
    groupBuyId = typeof order.groupBuyId === 'string' && order.groupBuyId ? order.groupBuyId : null;
    if (order.status === 'cancelled') {
      return { orderId: input.orderId, alreadyCancelled: true, groupBuyId, creditsRestored: 0 };
    }
    if (order.status !== 'pending_verification') {
      throw new VendorMoneyError(
        409,
        `Order ${input.orderId} is ${String(order.status)} and cannot be cancelled here. Verified orders are refunded through the approvals flow.`,
        { code: 'INVALID_TRANSITION' },
      );
    }
    const creditRefs = await prepareCreditRestore(db, tx, input.orderId);
    tx.update(orderRef as never, { status: 'cancelled', updatedAt: tsNow() } as never);
    writeCreditRestore(tx, creditRefs as unknown as DocRef[]);
    await writeFinanceAudit(db, tx as never, {
      action: 'ORDER_CANCELLED_PRE_VERIFICATION',
      actorUid: input.actorUid,
      targetUidOrResource: `orders/${input.orderId}`,
      payload: { orderId: input.orderId, groupBuyId, creditsRestored: creditRefs.length },
    });
    return {
      orderId: input.orderId,
      alreadyCancelled: false,
      groupBuyId,
      creditsRestored: creditRefs.length,
    };
  });
}

/* --------------------------------------------------------- claim flag */

export interface ClaimFlagResult {
  orderId: string;
  claimOpen: boolean;
  ledgerState: string | null;
  changed: boolean;
}

/**
 * The return-claim flag (PLAN-gf Section 5.5): opening a claim
 * holds a payable entry as held_dispute; closing releases it back
 * to payable. An accrued entry stays accrued (the flag on the
 * order routes its eventual delivery to held_dispute instead);
 * paid and reversed entries never move, because money already
 * left or was already reversed.
 */
export async function setReturnClaimFlag(
  db: Firestore,
  input: { orderId: string; claimOpen: boolean; actorUid: string },
): Promise<ClaimFlagResult> {
  const orderRef = db.collection('orders').doc(input.orderId);
  const ledgerRef = db.collection('commission_ledger').doc(input.orderId);
  return db.runTransaction(async (txRaw) => {
    const tx = txRaw as unknown as Tx;
    const orderSnap = await tx.get(orderRef as never);
    if (!orderSnap.exists) {
      throw new VendorMoneyError(404, 'Order not found');
    }
    const order = orderSnap.data() ?? {};
    const ledgerSnap = await tx.get(ledgerRef as never);
    const ledger = ledgerSnap.exists ? ledgerSnap.data() ?? {} : null;

    const currentClaim = order.returnClaimOpen === true;
    const currentState = ledger ? (ledger.state as string) : null;
    let nextState = currentState;
    if (ledger) {
      if (input.claimOpen && currentState === 'payable') nextState = 'held_dispute';
      if (!input.claimOpen && currentState === 'held_dispute') nextState = 'payable';
    }
    if (currentClaim === input.claimOpen && nextState === currentState) {
      return { orderId: input.orderId, claimOpen: input.claimOpen, ledgerState: currentState, changed: false };
    }
    tx.update(orderRef as never, { returnClaimOpen: input.claimOpen, updatedAt: tsNow() } as never);
    if (ledger && nextState !== currentState) {
      tx.update(ledgerRef as never, { state: nextState, updatedAt: tsNow() } as never);
    }
    await writeFinanceAudit(db, tx as never, {
      action: input.claimOpen ? 'ORDER_RETURN_CLAIM_OPENED' : 'ORDER_RETURN_CLAIM_CLOSED',
      actorUid: input.actorUid,
      targetUidOrResource: `orders/${input.orderId}`,
      payload: { orderId: input.orderId, claimOpen: input.claimOpen, ledgerState: nextState },
    });
    return { orderId: input.orderId, claimOpen: input.claimOpen, ledgerState: nextState, changed: true };
  });
}
