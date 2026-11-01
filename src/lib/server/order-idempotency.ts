/**
 * order-idempotency.ts — SEC-RACE (audit item 11): race-safe
 * idempotency for the Firestore order-write legs.
 *
 * The Supabase legs already dedupe inside their tx functions
 * (tx_store_create_order / tx_store_order_create keyed on
 * (buyer, idempotencyKey)). The Firestore legs were bare
 * `orders.add()` calls: a retried checkout submission minted a
 * duplicate pending order even when the client sent a key.
 *
 * Pattern (same claim shape as the gamification ledger locks): a
 * deterministic claim doc at
 *   order_idempotency/{buyerUid}__{base64url(idempotencyKey)}
 * is created inside the SAME runTransaction that writes the order.
 * Firestore serializes transactions touching the claim doc, so two
 * concurrent submissions with the same key cannot both create: the
 * loser re-reads the claim inside its transaction and returns the
 * winner's orderId with `created: false` — a replay is a success
 * carrying the original order id, never a second order.
 *
 * With no key supplied the helper is a plain add, byte-identical to
 * the pre-fix behavior (callers that mint keys get the guarantee;
 * keyless legacy callers are unchanged).
 */

type OrderDb = {
  collection: (name: string) => any;
  runTransaction: (fn: (t: any) => Promise<any>) => Promise<any>;
};

export function orderIdempotencyClaimId(buyerUid: string, idempotencyKey: string): string {
  const encoded = Buffer.from(idempotencyKey, 'utf8').toString('base64url');
  return `${buyerUid}__${encoded}`;
}

export async function createOrderWithIdempotencyClaim(
  db: OrderDb,
  args: {
    buyerUid: string;
    idempotencyKey?: string | null;
    orderData: Record<string, any>;
    /** Stamp written on the claim doc; serverTimestamp supplied by the caller. */
    claimTimestamp: unknown;
    /**
     * Optional hook (GE, vendor orders only): runs inside the claim
     * transaction after the claim-exists check and before the order
     * write. Its returned object is merged over orderData, so writes
     * it makes (store-credit consumption, group seat registration)
     * commit or roll back with the order and the claim, and a replay
     * never enters it. House callers never pass it.
     */
    beforeOrderWrite?: (t: any, orderRef: any) => Promise<Record<string, unknown> | void>;
  },
): Promise<{ orderId: string; created: boolean }> {
  const key = typeof args.idempotencyKey === 'string' ? args.idempotencyKey.trim() : '';
  if (!key) {
    const ref = await db.collection('orders').add(args.orderData);
    return { orderId: ref.id, created: true };
  }

  const claimRef = db
    .collection('order_idempotency')
    .doc(orderIdempotencyClaimId(args.buyerUid, key));
  const orderRef = db.collection('orders').doc();

  return db.runTransaction(async (t: any) => {
    const claimSnap = await t.get(claimRef);
    if (claimSnap.exists) {
      const existingOrderId = claimSnap.data()?.orderId;
      if (typeof existingOrderId === 'string' && existingOrderId) {
        return { orderId: existingOrderId, created: false };
      }
    }
    let finalData = args.orderData;
    if (args.beforeOrderWrite) {
      const hookResult = await args.beforeOrderWrite(t, orderRef);
      if (hookResult) finalData = { ...args.orderData, ...hookResult };
    }
    t.set(orderRef, finalData);
    t.set(claimRef, {
      orderId: orderRef.id,
      buyerUid: args.buyerUid,
      idempotencyKey: key,
      createdAt: args.claimTimestamp,
    });
    return { orderId: orderRef.id, created: true };
  });
}
