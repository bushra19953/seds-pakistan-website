import { normalizeOrder } from '../order-canonical';

describe('normalizeOrder (spec Part C section 7, cases 1-4)', () => {
  it('case 1: shapeA_order_normalizes_total_and_userId', () => {
    const o = normalizeOrder(
      {
        total: 1500,
        status: 'pending',
        paymentStatus: 'pending',
        userId: 'user-a',
        proofOfPaymentUrl: 'https://drive.example/receipt-a',
        currency: 'PKR',
        items: [{ productId: 'p1', price: 1500, subtotal: 1500, quantity: 1 }],
      },
      'ord-a',
    );
    expect(o.totalPkr).toBe(1500);
    expect(o.buyerUserId).toBe('user-a');
    expect(o.receiptUrl).toBe('https://drive.example/receipt-a');
    expect(o.status).toBe('pending_verification');
    expect(o.paymentStatus).toBe('pending');
    expect(o.dataQuality.missingAmount).toBe(false);
  });

  it('case 2: shapeB_order_normalizes_amount_and_pending_verification', () => {
    const o = normalizeOrder(
      {
        amount: 2500,
        status: 'pending_verification',
        buyerUserId: 'user-b',
        receiptUrl: 'https://drive.example/receipt-b',
      },
      'ord-b',
    );
    expect(o.totalPkr).toBe(2500);
    expect(o.status).toBe('pending_verification');
    expect(o.paymentStatus).toBe('pending'); // absent -> pending
    expect(o.buyerUserId).toBe('user-b');
  });

  it('case 3: shapeC_paid_order_normalizes_to_verified_completed', () => {
    const paid = normalizeOrder({ amount: 900, status: 'paid', buyerUserId: 'u1' }, 'o1');
    expect(paid.status).toBe('verified');
    expect(paid.paymentStatus).toBe('completed');
    expect(paid.totalPkr).toBe(900);

    const printed = normalizeOrder({ amount: 900, status: 'printed', buyerUserId: 'u1' }, 'o2');
    expect(printed.status).toBe('processing');

    const pendingPayment = normalizeOrder(
      { amount: 900, status: 'pending_payment', buyerUserId: 'u1' },
      'o3',
    );
    expect(pendingPayment.status).toBe('pending_verification');
  });

  it('case 4: unknown_status_is_flagged_not_rewritten', () => {
    const o = normalizeOrder({ amount: 100, status: 'awaiting_courier_magic', buyerUserId: 'u9' }, 'o9');
    expect(o.status).toBe('awaiting_courier_magic');
    expect(o.dataQuality.unknownStatus).toBe(true);
  });

  it('totalPkr falls back to item subtotals, then missingAmount', () => {
    const fromItems = normalizeOrder(
      { items: [{ subtotal: 300 }, { subtotal: 200 }], status: 'pending', userId: 'u' },
      'oi',
    );
    expect(fromItems.totalPkr).toBe(500);
    const missing = normalizeOrder({ status: 'pending', userId: 'u' }, 'om');
    expect(missing.totalPkr).toBe(0);
    expect(missing.dataQuality.missingAmount).toBe(true);
  });
});
