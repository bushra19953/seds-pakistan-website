/**
 * Defect 2: attendee-side Verify Payment / Confirm Seat must converge the
 * linked Store order, not just the registration.
 *
 * The attendees panel writes the registration directly (its long-standing
 * behaviour), while the Store order surface reads the ORDER doc
 * (`status: 'pending_verification' -> 'verified'`,
 * `paymentStatus: 'pending' -> 'completed'`, order vocabulary). Before this
 * module the panel never touched the order, so the two records diverged and
 * the order's Issue Ticket (gated on paymentStatus 'completed') never
 * enabled for a registration confirmed from the panel.
 *
 * Link shapes (DEFECT2_MAP.md): a registration links to its order by
 * `orderId` (store checkout mirror), or by a shared `transactionId`
 * (paid-route payment reference — the order doc carries the same value in
 * its own `transactionId` field), or by `transactionId` being the order
 * doc id itself (money-approval apply mirror).
 */

export interface RegistrationOrderState {
  status?: string | null;
  paymentStatus?: string | null;
  orderId?: string | null;
  transactionId?: string | null;
}

export type RegistrationVerifyAction = 'verifyPayment' | 'confirmSeat';

/**
 * The order fields that make the order agree with the registration AFTER
 * the given panel action, or null when the action alone does not move the
 * order yet:
 *  - verifyPayment completes the payment; if the seat is already confirmed
 *    the order is fully verified.
 *  - confirmSeat verifies the order only when payment is already verified;
 *    confirming a seat whose payment is still pending leaves the order in
 *    pending_verification until Verify Payment lands (the pair of actions
 *    converges in either order).
 */
export function linkedOrderUpdate(
  reg: RegistrationOrderState,
  action: RegistrationVerifyAction,
): Record<string, string> | null {
  if (action === 'verifyPayment') {
    const update: Record<string, string> = { paymentStatus: 'completed' };
    if (reg.status === 'confirmed') update.status = 'verified';
    return update;
  }
  // confirmSeat
  if (reg.paymentStatus === 'verified') {
    return { paymentStatus: 'completed', status: 'verified' };
  }
  return null;
}

export interface LinkedOrderOps {
  orderExists: (id: string) => Promise<boolean>;
  findOrderIdByTransactionId: (transactionId: string) => Promise<string | null>;
  updateOrder: (id: string, fields: Record<string, unknown>) => Promise<void>;
}

export type LinkedOrderSyncOutcome = 'updated' | 'no-change' | 'no-link' | 'not-found';

/**
 * Resolve the linked order for a registration and write the converged
 * state to it. Resolution order: explicit `orderId`; then `transactionId`
 * as an order doc id (money-approval mirror shape); then an order whose
 * `transactionId` field equals the registration's (paid-route shape).
 */
export async function syncLinkedStoreOrder(
  reg: RegistrationOrderState,
  action: RegistrationVerifyAction,
  ops: LinkedOrderOps,
): Promise<LinkedOrderSyncOutcome> {
  const fields = linkedOrderUpdate(reg, action);
  if (!fields) return 'no-change';

  if (reg.orderId) {
    await ops.updateOrder(reg.orderId, fields);
    return 'updated';
  }
  if (reg.transactionId) {
    if (await ops.orderExists(reg.transactionId)) {
      await ops.updateOrder(reg.transactionId, fields);
      return 'updated';
    }
    const byField = await ops.findOrderIdByTransactionId(reg.transactionId);
    if (byField) {
      await ops.updateOrder(byField, fields);
      return 'updated';
    }
    return 'not-found';
  }
  return 'no-link';
}
