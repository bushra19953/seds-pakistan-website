/**
 * @jest-environment node
 */
// GF refund hooks (PLAN-gf Section 9.2): ledger reversal or paid
// adjustment, stock restore, escrow refunded, credit restore.
// Maps to spec tests S3, the GF halves of G3, and F2's refund pair.
// Fixtures and mocks only.
import { createFakeFirestore, type FakeFirestore } from './fake-firestore';

const rolePerms: Record<string, Set<string>> = {
  store_officer: new Set(['canManageStore']),
  president: new Set(['canApproveMoney']),
  treasurer: new Set(['canApproveMoney', 'canManageFinance']),
  finance_officer: new Set(['canManageFinance']),
};

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => ({ __serverTimestamp: true }),
    arrayUnion: (v: unknown) => ({ __arrayUnion: v }),
  },
}));

jest.mock('@/lib/supa/vendor-shop-mirror', () => ({
  mirrorVendorShopSet: jest.fn(async () => true),
  mirrorVendorShopUpdate: jest.fn(async () => true),
}));

const uidRoles: Record<string, string> = {
  'maker-1': 'treasurer',
  'checker-1': 'president',
  'checker-2': 'treasurer',
  'fin-1': 'finance_officer',
};
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async (role: string, perm: string) => rolePerms[role]?.has(perm) ?? false),
  hasServerPermissionForUser: jest.fn(
    async (_db: unknown, uid: string, perm: string) =>
      rolePerms[uidRoles[uid] ?? 'member']?.has(perm) ?? false,
  ),
  resolveCanonicalRole: jest.fn(async () => 'officer'),
}));

import { createMoneyApprovalRequest, decideMoneyApproval } from '../money-approval';
import { isLedgerEntryPayoutEligible } from '@/lib/server/vendor-money';

const maker = { uid: 'maker-1', role: 'store_officer' };
const checker = { uid: 'checker-1', role: 'president' };

function seedVerifiedVendorOrder(
  db: FakeFirestore,
  orderOverrides: Record<string, unknown> = {},
  entryOverrides: Record<string, unknown> = {},
) {
  db.__seed('vendors', 'vendor-1', { businessName: 'Test Vendor', status: 'active', commissionRate: 0.1 });
  db.__seed('products', 'prod-1', { name: 'Test Widget', stock: 4, price: 1000 });
  db.__seed('orders', 'ord-1', {
    status: 'verified',
    paymentStatus: 'completed',
    total: 1200,
    totalPkr: 1200,
    subtotalPkr: 1000,
    deliveryPkr: 200,
    vendorId: 'vendor-1',
    buyerUserId: 'buyer-1',
    buyer: { fullName: 'Buyer One', email: 'b@example.com' },
    items: [{ productId: 'prod-1', productName: 'Test Widget', quantity: 1, price: 1000, subtotal: 1000 }],
    productId: 'prod-1',
    originatingModule: 'store',
    commissionLedgerId: 'ord-1',
    ...orderOverrides,
  });
  db.__seed('commission_ledger', 'ord-1', {
    id: 'ord-1',
    type: 'accrual',
    vendorId: 'vendor-1',
    orderId: 'ord-1',
    salePricePkr: 1000,
    commissionRate: 0.1,
    commissionPkr: 100,
    vendorDuePkr: 900,
    state: 'accrued',
    payoutId: null,
    ...entryOverrides,
  });
}

async function raiseAndApproveRefund(db: FakeFirestore) {
  const { id } = await createMoneyApprovalRequest(db as never, maker, {
    targetType: 'order_refund',
    targetId: 'ord-1',
    changePayload: {},
    reason: 'Buyer reported a defective unit',
  });
  return decideMoneyApproval(db as never, checker, id, 'approve');
}

describe('vendor refund hooks', () => {
  it('s3_refund_restores_stock_and_reverses_the_entry', async () => {
    const db = createFakeFirestore();
    // Full path: verify first (stock 5 to 4, entry accrued), then refund.
    db.__seed('vendors', 'vendor-1', { businessName: 'Test Vendor', status: 'active', commissionRate: 0.1 });
    db.__seed('products', 'prod-1', { name: 'Test Widget', stock: 5, price: 1000 });
    db.__seed('orders', 'ord-1', {
      status: 'pending_verification',
      paymentStatus: 'pending',
      total: 1200,
      totalPkr: 1200,
      subtotalPkr: 1000,
      deliveryPkr: 200,
      vendorId: 'vendor-1',
      buyerUserId: 'buyer-1',
      buyer: { fullName: 'Buyer One', email: 'b@example.com' },
      items: [{ productId: 'prod-1', productName: 'Test Widget', quantity: 1, price: 1000, subtotal: 1000 }],
      productId: 'prod-1',
      originatingModule: 'store',
    });
    const verify = await createMoneyApprovalRequest(db as never, maker, {
      targetType: 'order_verify_payment',
      targetId: 'ord-1',
      changePayload: {},
    });
    await decideMoneyApproval(db as never, checker, verify.id, 'approve');
    expect(db.__doc('products', 'prod-1')?.stock).toBe(4);

    await raiseAndApproveRefund(db);
    expect(db.__doc('products', 'prod-1')?.stock).toBe(5);
    expect(db.__doc('commission_ledger', 'ord-1')?.state).toBe('reversed');
    expect(db.__doc('orders', 'ord-1')?.status).toBe('refunded');
    expect(db.__doc('orders', 'ord-1')?.paymentStatus).toBe('refunded');
    expect(db.__doc('commission_ledger', 'adj_ord-1')).toBeUndefined();
  });

  it('refund_of_delivered_unpaid_order_reverses_from_payable', async () => {
    const db = createFakeFirestore();
    seedVerifiedVendorOrder(
      db,
      { status: 'delivered', groupBuyId: 'gb-1', escrowStatus: 'released' },
      { state: 'payable' },
    );
    await raiseAndApproveRefund(db);
    const order = db.__doc('orders', 'ord-1')!;
    expect(order.status).toBe('delivered');
    expect(order.paymentStatus).toBe('refunded');
    expect(order.escrowStatus).toBe('refunded');
    expect(db.__doc('commission_ledger', 'ord-1')?.state).toBe('reversed');
    expect(db.__doc('products', 'prod-1')?.stock).toBe(5);
  });

  it('refund_after_payout_writes_one_negative_adjustment', async () => {
    const db = createFakeFirestore();
    seedVerifiedVendorOrder(db, { status: 'delivered' }, { state: 'paid', payoutId: 'pay-1' });
    await raiseAndApproveRefund(db);
    expect(db.__doc('commission_ledger', 'ord-1')?.state).toBe('reversed');
    const adj = db.__doc('commission_ledger', 'adj_ord-1')!;
    expect(adj.type).toBe('adjustment');
    expect(adj.adjustmentFor).toBe('ord-1');
    expect(adj.salePricePkr).toBe(-1000);
    expect(adj.commissionPkr).toBe(-100);
    expect(adj.vendorDuePkr).toBe(-900);
    expect(adj.state).toBe('payable');
    expect(
      isLedgerEntryPayoutEligible(
        { state: adj.state as string, type: adj.type as string },
        { escrowStatus: (db.__doc('orders', 'ord-1')?.escrowStatus as string) ?? null },
      ),
    ).toBe(true);
  });

  it('refund_restores_consumed_store_credit_exactly_once', async () => {
    const db = createFakeFirestore();
    seedVerifiedVendorOrder(db, { creditAppliedPkr: 300 });
    db.__seed('store_credits', 'credit-1', {
      userId: 'buyer-1', code: 'LATE-AAAAAA', amountPkr: 200, sourceOrderId: 'ord-x',
      groupBuyId: 'gb-0', state: 'consumed', consumedOrderId: 'ord-1', expiresAt: new Date(),
    });
    db.__seed('store_credits', 'credit-2', {
      userId: 'buyer-1', code: 'LATE-BBBBBB', amountPkr: 100, sourceOrderId: 'ord-y',
      groupBuyId: 'gb-0', state: 'consumed', consumedOrderId: 'ord-1', expiresAt: new Date(),
    });
    db.__seed('store_credits', 'credit-3', {
      userId: 'buyer-2', code: 'LATE-CCCCCC', amountPkr: 100, sourceOrderId: 'ord-z',
      groupBuyId: 'gb-0', state: 'consumed', consumedOrderId: 'ord-other', expiresAt: new Date(),
    });
    await raiseAndApproveRefund(db);
    expect(db.__doc('store_credits', 'credit-1')?.state).toBe('available');
    expect(db.__doc('store_credits', 'credit-1')?.consumedOrderId).toBeNull();
    expect(db.__doc('store_credits', 'credit-2')?.state).toBe('available');
    expect(db.__doc('store_credits', 'credit-2')?.consumedOrderId).toBeNull();
    expect(db.__doc('store_credits', 'credit-3')?.state).toBe('consumed');
    expect(db.__doc('store_credits', 'credit-3')?.consumedOrderId).toBe('ord-other');
  });

  it('g3_expired_team_paid_order_refund_carries_full_effects', async () => {
    const db = createFakeFirestore();
    seedVerifiedVendorOrder(db, { groupBuyId: 'gb-1', escrowStatus: 'held' });
    const before = db.__doc('commission_ledger', 'ord-1')!;
    expect(
      isLedgerEntryPayoutEligible(
        { state: before.state as string },
        { escrowStatus: 'held' },
      ),
    ).toBe(false);
    await raiseAndApproveRefund(db);
    expect(db.__doc('commission_ledger', 'ord-1')?.state).toBe('reversed');
    expect(db.__doc('products', 'prod-1')?.stock).toBe(5);
    expect(db.__doc('orders', 'ord-1')?.escrowStatus).toBe('refunded');
    const after = db.__doc('commission_ledger', 'ord-1')!;
    expect(
      isLedgerEntryPayoutEligible(
        { state: after.state as string },
        { escrowStatus: 'refunded' },
      ),
    ).toBe(false);
  });

  it('refund_house_order_has_no_commission_effects', async () => {
    const db = createFakeFirestore();
    db.__seed('orders', 'ord-1', {
      status: 'verified',
      paymentStatus: 'completed',
      total: 2000,
      totalPkr: 2000,
      buyerUserId: 'buyer-1',
      buyer: { fullName: 'Buyer One', email: 'b@example.com' },
      items: [],
      originatingModule: 'store',
    });
    await raiseAndApproveRefund(db);
    expect(db.__doc('orders', 'ord-1')?.paymentStatus).toBe('refunded');
    expect(db.__store.get('commission_ledger')?.size ?? 0).toBe(0);
  });

  it('refund_of_vendor_order_without_entry_fails_loud', async () => {
    const db = createFakeFirestore();
    seedVerifiedVendorOrder(db);
    db.__store.get('commission_ledger')!.delete('ord-1');
    const { id } = await createMoneyApprovalRequest(db as never, maker, {
      targetType: 'order_refund',
      targetId: 'ord-1',
      changePayload: {},
      reason: 'Buyer reported a defective unit',
    });
    await expect(decideMoneyApproval(db as never, checker, id, 'approve')).rejects.toMatchObject({ status: 500 });
    expect(db.__doc('money_approvals', id)?.status).toBe('apply_failed');
    expect(db.__doc('orders', 'ord-1')?.paymentStatus).toBe('completed');
    expect(db.__doc('orders', 'ord-1')?.status).toBe('verified');
  });
});
