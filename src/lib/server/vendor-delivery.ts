/**
 * vendor-delivery.ts: the ONE delivery transition for vendor orders
 * (PLAN-gf Section 5.2, coordinator ruling R-9). GG's vendor PATCH
 * and GF's admin deliver route both call deliverVendorOrder; the
 * generic orders PATCH refuses vendor deliveries so this helper is
 * the only road. It runs its own transaction, all reads before all
 * writes: ledger accrued -> payable (or held_dispute when a return
 * claim is open), group escrow released, and one bounded late
 * delivery credit for a late group order. GH's team completion
 * check runs after the commit and can never roll a delivery back.
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { writeFinanceAudit } from '@/lib/server/finance-audit';
import { VendorMoneyError } from '@/lib/server/vendor-money';
import {
  buildLateDeliveryCredit,
  isLateDelivery,
  lateCreditIdForOrder,
  writeLateDeliveryCredit,
} from '@/lib/server/store-credits';
import { checkAndCompleteGroupBuy } from '@/lib/server/group-buy-hooks';

export { VendorMoneyError };

type Tx = {
  get: (ref: never) => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
  set: (ref: never, data: Record<string, unknown>, opts?: { merge?: boolean }) => unknown;
  update: (ref: never, data: Record<string, unknown>) => unknown;
  create: (ref: never, data: Record<string, unknown>) => unknown;
};

export interface DeliverOrderResult {
  orderId: string;
  alreadyDelivered: boolean;
  deliveredAt: string | null;
  ledgerState: 'payable' | 'held_dispute' | null;
  escrowStatus: 'released' | 'none' | null;
  credit: { id: string; code: string; amountPkr: number } | null;
  teamCompleted: boolean | null;
}

function toIsoString(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  const t = value as { toDate?: () => Date; seconds?: number };
  if (typeof t.toDate === 'function') return t.toDate().toISOString();
  if (typeof t.seconds === 'number') return new Date(t.seconds * 1000).toISOString();
  return null;
}

export async function deliverVendorOrder(
  db: Firestore,
  input: { orderId: string; actorUid: string },
): Promise<DeliverOrderResult> {
  const orderRef = db.collection('orders').doc(input.orderId);
  const ledgerRef = db.collection('commission_ledger').doc(input.orderId);
  const deliveredAtMs = Date.now();

  const inTx = await db.runTransaction(async (txRaw) => {
    const tx = txRaw as unknown as Tx;
    const orderSnap = await tx.get(orderRef as never);
    if (!orderSnap.exists) {
      throw new VendorMoneyError(404, 'Order not found');
    }
    const order = orderSnap.data() ?? {};
    const vendorId = typeof order.vendorId === 'string' && order.vendorId ? order.vendorId : null;
    if (!vendorId) {
      throw new VendorMoneyError(
        409,
        `Order ${input.orderId} is not a vendor order. Use the standard status update for it.`,
        { code: 'NOT_VENDOR_ORDER' },
      );
    }
    const groupBuyId =
      typeof order.groupBuyId === 'string' && order.groupBuyId ? order.groupBuyId : null;

    const ledgerSnap = await tx.get(ledgerRef as never);
    const ledger = ledgerSnap.exists ? ledgerSnap.data() ?? {} : null;

    if (order.status === 'delivered') {
      // Idempotent replay: no writes, report the existing state.
      let credit: DeliverOrderResult['credit'] = null;
      if (groupBuyId) {
        const creditSnap = await tx.get(
          db.collection('store_credits').doc(lateCreditIdForOrder(input.orderId)) as never,
        );
        if (creditSnap.exists) {
          const c = creditSnap.data() ?? {};
          credit = {
            id: lateCreditIdForOrder(input.orderId),
            code: c.code as string,
            amountPkr: c.amountPkr as number,
          };
        }
      }
      return {
        orderId: input.orderId,
        alreadyDelivered: true,
        deliveredAt: toIsoString(order.deliveredAt),
        ledgerState: (ledger?.state as 'payable' | 'held_dispute') ?? null,
        escrowStatus: groupBuyId ? ('released' as const) : null,
        credit,
        groupBuyId,
      };
    }

    if (order.status !== 'shipped') {
      throw new VendorMoneyError(
        409,
        `Order ${input.orderId} is ${String(order.status)}. Only a shipped order can be marked delivered.`,
        { code: 'INVALID_TRANSITION' },
      );
    }
    if (!ledger) {
      throw new VendorMoneyError(
        500,
        `Order ${input.orderId} has no commission ledger entry. It cannot be delivered until the entry is restored.`,
        { code: 'LEDGER_MISSING' },
      );
    }
    const ledgerState = ledger.state as string;
    if (ledgerState === 'paid' || ledgerState === 'reversed') {
      throw new VendorMoneyError(
        409,
        `Order ${input.orderId} has a commission entry in state ${ledgerState} and cannot be delivered.`,
        { code: 'LEDGER_STATE' },
      );
    }
    if (ledgerState === 'payable') {
      throw new VendorMoneyError(
        500,
        `Order ${input.orderId} has a payable commission entry before delivery. This needs a human review.`,
        { code: 'LEDGER_STATE' },
      );
    }

    const targetState = order.returnClaimOpen === true ? 'held_dispute' : 'payable';

    let credit: DeliverOrderResult['credit'] = null;
    let creditDoc: ReturnType<typeof buildLateDeliveryCredit> | null = null;
    if (groupBuyId) {
      const creditSnap = await tx.get(
        db.collection('store_credits').doc(lateCreditIdForOrder(input.orderId)) as never,
      );
      const subtotal = order.subtotalPkr;
      if (
        !creditSnap.exists &&
        isLateDelivery(deliveredAtMs, order.promisedDeliveryDate) &&
        typeof subtotal === 'number' &&
        Number.isInteger(subtotal) &&
        subtotal >= 0
      ) {
        creditDoc = buildLateDeliveryCredit({
          orderId: input.orderId,
          userId: (order.buyerUserId as string) || (order.userId as string) || '',
          groupBuyId,
          subtotalPkr: subtotal,
          deliveredAtMs,
        });
        credit = { id: creditDoc.id, code: creditDoc.code, amountPkr: creditDoc.amountPkr };
      } else if (creditSnap.exists) {
        const c = creditSnap.data() ?? {};
        credit = {
          id: lateCreditIdForOrder(input.orderId),
          code: c.code as string,
          amountPkr: c.amountPkr as number,
        };
      }
    }

    const orderUpdate: Record<string, unknown> = {
      status: 'delivered',
      deliveredAt: new Date(deliveredAtMs),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (groupBuyId) orderUpdate.escrowStatus = 'released';
    tx.update(orderRef as never, orderUpdate as never);
    if (ledgerState !== targetState) {
      tx.update(ledgerRef as never, { state: targetState, updatedAt: FieldValue.serverTimestamp() } as never);
    }
    if (creditDoc) {
      writeLateDeliveryCredit(tx, db, creditDoc);
    }
    await writeFinanceAudit(db, tx as never, {
      action: 'ORDER_DELIVERED',
      actorUid: input.actorUid,
      targetUidOrResource: `orders/${input.orderId}`,
      payload: {
        orderId: input.orderId,
        vendorId,
        ledgerState: targetState,
        creditId: credit?.id ?? null,
      },
    });
    return {
      orderId: input.orderId,
      alreadyDelivered: false,
      deliveredAt: new Date(deliveredAtMs).toISOString(),
      ledgerState: targetState as 'payable' | 'held_dispute',
      escrowStatus: groupBuyId ? ('released' as const) : null,
      credit,
      groupBuyId,
    };
  });

  const { groupBuyId, ...result } = inTx;
  let teamCompleted: boolean | null = null;
  if (groupBuyId) {
    try {
      const completion = await checkAndCompleteGroupBuy(db, groupBuyId);
      teamCompleted = completion?.outcome === 'completed';
    } catch (err) {
      console.error(`[vendor-delivery] group buy completion check failed for ${groupBuyId}:`, err);
      teamCompleted = null;
    }
  }
  return { ...result, teamCompleted };
}
