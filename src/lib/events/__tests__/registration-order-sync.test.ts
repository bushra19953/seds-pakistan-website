/**
 * @jest-environment node
 */
// Defect 2 regression tests: attendee-side Verify Payment / Confirm Seat
// must converge the linked Store order, not just the registration.
//
// Link shapes covered (see DEFECT2_MAP.md):
//  - checkout registrations carry orderId = order doc id
//  - paid-route registrations share transactionId with the order doc's
//    transactionId field
//  - money-approval-mirrored registrations carry transactionId = order doc id
import {
  linkedOrderUpdate,
  syncLinkedStoreOrder,
  type LinkedOrderOps,
} from '../registration-order-sync';

function makeOps(existingIds: string[] = [], byTxn: Record<string, string> = {}) {
  const updates: Array<{ id: string; fields: Record<string, unknown> }> = [];
  const ops: LinkedOrderOps = {
    orderExists: async (id) => existingIds.includes(id),
    findOrderIdByTransactionId: async (txn) => byTxn[txn] ?? null,
    updateOrder: async (id, fields) => {
      updates.push({ id, fields });
    },
  };
  return { ops, updates };
}

describe('linkedOrderUpdate (pure convergence mapping)', () => {
  it('verifyPayment on an already-confirmed registration verifies the order fully', () => {
    expect(
      linkedOrderUpdate({ status: 'confirmed', paymentStatus: 'pending', orderId: 'ord-1' }, 'verifyPayment'),
    ).toEqual({ paymentStatus: 'completed', status: 'verified' });
  });

  it('verifyPayment before seat confirmation completes payment only (order status waits for the seat)', () => {
    expect(
      linkedOrderUpdate({ status: 'pending', paymentStatus: 'pending', orderId: 'ord-1' }, 'verifyPayment'),
    ).toEqual({ paymentStatus: 'completed' });
  });

  it('confirmSeat on an already-verified registration verifies the order fully', () => {
    expect(
      linkedOrderUpdate({ status: 'pending', paymentStatus: 'verified', orderId: 'ord-1' }, 'confirmSeat'),
    ).toEqual({ paymentStatus: 'completed', status: 'verified' });
  });

  it('confirmSeat while payment is still pending writes nothing yet (order stays pending_verification until payment is verified)', () => {
    expect(
      linkedOrderUpdate({ status: 'pending', paymentStatus: 'pending', orderId: 'ord-1' }, 'confirmSeat'),
    ).toBeNull();
  });
});

describe('syncLinkedStoreOrder (link resolution + write)', () => {
  it('orderId link: writes the converged state to that order doc', async () => {
    const { ops, updates } = makeOps();
    const outcome = await syncLinkedStoreOrder(
      { status: 'confirmed', paymentStatus: 'pending', orderId: 'ord-1' },
      'verifyPayment',
      ops,
    );
    expect(outcome).toBe('updated');
    expect(updates).toEqual([{ id: 'ord-1', fields: { paymentStatus: 'completed', status: 'verified' } }]);
  });

  it('transactionId that IS the order doc id (money-approval mirror shape) wins over a field query', async () => {
    const { ops, updates } = makeOps(['ord-9'], { 'ord-9': 'ord-OTHER' });
    const outcome = await syncLinkedStoreOrder(
      { status: 'confirmed', paymentStatus: 'pending', transactionId: 'ord-9' },
      'verifyPayment',
      ops,
    );
    expect(outcome).toBe('updated');
    expect(updates).toEqual([{ id: 'ord-9', fields: { paymentStatus: 'completed', status: 'verified' } }]);
  });

  it('transactionId payment-reference link: resolves the order by its transactionId field', async () => {
    const { ops, updates } = makeOps([], { 'txn-ref-123': 'ord-7' });
    const outcome = await syncLinkedStoreOrder(
      { status: 'pending', paymentStatus: 'verified', transactionId: 'txn-ref-123' },
      'confirmSeat',
      ops,
    );
    expect(outcome).toBe('updated');
    expect(updates).toEqual([{ id: 'ord-7', fields: { paymentStatus: 'completed', status: 'verified' } }]);
  });

  it('no link fields: no write, outcome no-link', async () => {
    const { ops, updates } = makeOps();
    const outcome = await syncLinkedStoreOrder(
      { status: 'confirmed', paymentStatus: 'pending' },
      'verifyPayment',
      ops,
    );
    expect(outcome).toBe('no-link');
    expect(updates).toEqual([]);
  });

  it('transactionId with no matching order: no write, outcome not-found', async () => {
    const { ops, updates } = makeOps([], {});
    const outcome = await syncLinkedStoreOrder(
      { status: 'confirmed', paymentStatus: 'pending', transactionId: 'txn-gone' },
      'verifyPayment',
      ops,
    );
    expect(outcome).toBe('not-found');
    expect(updates).toEqual([]);
  });

  it('confirmSeat on a pending-payment registration performs no order write even when linked', async () => {
    const { ops, updates } = makeOps();
    const outcome = await syncLinkedStoreOrder(
      { status: 'pending', paymentStatus: 'pending', orderId: 'ord-1' },
      'confirmSeat',
      ops,
    );
    expect(outcome).toBe('no-change');
    expect(updates).toEqual([]);
  });
});
