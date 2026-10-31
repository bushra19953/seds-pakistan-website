/**
 * @jest-environment node
 */
// GF verification hooks (PLAN-gf Section 9.1): commission accrual,
// stock decrement and block, and escrow at checker completion.
// Maps to spec tests M1, M2, S1, S2, and the escrow half of G2.
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

function seedVendorOrder(db: FakeFirestore, orderOverrides: Record<string, unknown> = {}) {
  db.__seed('vendors', 'vendor-1', {
    businessName: 'Test Vendor',
    status: 'active',
    commissionRate: 0.1,
  });
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
    receiptUrl: 'https://drive.example/r1',
    ...orderOverrides,
  });
}

async function raiseVerify(db: FakeFirestore) {
  return createMoneyApprovalRequest(db as never, maker, {
    targetType: 'order_verify_payment',
    targetId: 'ord-1',
    changePayload: {},
  });
}

function collectionSize(db: FakeFirestore, name: string): number {
  return db.__store.get(name)?.size ?? 0;
}

describe('vendor verification hooks', () => {
  it('m1_vendor_verify_completes_only_under_a_different_checker', async () => {
    const db = createFakeFirestore();
    seedVendorOrder(db);
    const privilegedMaker = { uid: 'maker-1', role: 'treasurer' };
    const { id } = await createMoneyApprovalRequest(db as never, privilegedMaker, {
      targetType: 'order_verify_payment',
      targetId: 'ord-1',
      changePayload: {},
    });
    await expect(decideMoneyApproval(db as never, privilegedMaker, id, 'approve')).rejects.toMatchObject({
      status: 422,
      code: 'MAKER_EQUALS_CHECKER',
    });
    const res = await decideMoneyApproval(db as never, checker, id, 'approve');
    expect(res.status).toBe('approved_applied');
    expect(db.__doc('orders', 'ord-1')?.status).toBe('verified');
    expect(db.__doc('orders', 'ord-1')?.paymentStatus).toBe('completed');
  });

  it('m2_commission_math_uses_subtotal_and_rounds_half_up', async () => {
    const cases: Array<[number, number, number]> = [
      [1000, 100, 900],
      [1055, 106, 949],
      [999, 100, 899],
      [250, 25, 225],
      [1, 0, 1],
    ];
    for (const [subtotal, commission, due] of cases) {
      const db = createFakeFirestore();
      // totalPkr 1200-style case included in the first row: delivery
      // is in the total but must never enter the commission base.
      seedVendorOrder(db, {
        subtotalPkr: subtotal,
        total: subtotal + 200,
        totalPkr: subtotal + 200,
        deliveryPkr: 200,
      });
      const { id } = await raiseVerify(db);
      await decideMoneyApproval(db as never, checker, id, 'approve');
      const entry = db.__doc('commission_ledger', 'ord-1')!;
      expect(entry.commissionPkr).toBe(commission);
      expect(entry.vendorDuePkr).toBe(due);
      expect(entry.salePricePkr).toBe(subtotal);
      expect(entry.commissionRate).toBe(0.1);
      expect(entry.state).toBe('accrued');
      expect(entry.type).toBe('accrual');
      expect(entry.payoutId).toBeNull();
      expect(db.__doc('orders', 'ord-1')?.commissionLedgerId).toBe('ord-1');
    }
  });

  it('m2_rate_is_copied_from_the_vendor_record_at_verification', async () => {
    const db = createFakeFirestore();
    seedVendorOrder(db);
    db.__seed('vendors', 'vendor-1', { businessName: 'Test Vendor', status: 'active', commissionRate: 0.2 });
    const { id } = await raiseVerify(db);
    await decideMoneyApproval(db as never, checker, id, 'approve');
    const entry = db.__doc('commission_ledger', 'ord-1')!;
    expect(entry.commissionRate).toBe(0.2);
    expect(entry.commissionPkr).toBe(200);
    expect(entry.vendorDuePkr).toBe(800);
  });

  it('s1_stock_decrements_exactly_once_at_verification', async () => {
    const db = createFakeFirestore();
    seedVendorOrder(db);
    const { id } = await raiseVerify(db);
    expect(db.__doc('products', 'prod-1')?.stock).toBe(5);
    await decideMoneyApproval(db as never, checker, id, 'approve');
    expect(db.__doc('products', 'prod-1')?.stock).toBe(4);
  });

  it('s2_verification_blocks_loudly_when_stock_cannot_cover', async () => {
    const db = createFakeFirestore();
    seedVendorOrder(db);
    db.__seed('products', 'prod-1', { name: 'Test Widget', stock: 0, price: 1000 });
    const { id } = await raiseVerify(db);
    const err = await decideMoneyApproval(db as never, checker, id, 'approve').catch((e) => e);
    expect(err).toMatchObject({ status: 422, code: 'STOCK_INSUFFICIENT' });
    expect(err.message).toContain('Test Widget');
    expect(err.message).toContain('ord-1');
    expect(db.__doc('orders', 'ord-1')?.status).toBe('pending_verification');
    expect(db.__doc('orders', 'ord-1')?.paymentStatus).toBe('pending');
    expect(db.__doc('money_approvals', id)?.status).toBe('pending');
    expect(collectionSize(db, 'commission_ledger')).toBe(0);
    expect(collectionSize(db, 'ledger_entries')).toBe(0);
    expect(collectionSize(db, 'finance_receipts')).toBe(0);
    expect(db.__doc('products', 'prod-1')?.stock).toBe(0);
  });

  it('s2_blocked_request_succeeds_after_stock_correction', async () => {
    const db = createFakeFirestore();
    seedVendorOrder(db);
    db.__seed('products', 'prod-1', { name: 'Test Widget', stock: 0, price: 1000 });
    const { id } = await raiseVerify(db);
    await expect(decideMoneyApproval(db as never, checker, id, 'approve')).rejects.toMatchObject({
      status: 422,
      code: 'STOCK_INSUFFICIENT',
    });
    db.__seed('products', 'prod-1', { name: 'Test Widget', stock: 1, price: 1000 });
    const res = await decideMoneyApproval(db as never, checker, id, 'approve');
    expect(res.status).toBe('approved_applied');
    expect(db.__doc('orders', 'ord-1')?.status).toBe('verified');
    expect(db.__doc('commission_ledger', 'ord-1')?.state).toBe('accrued');
    expect(db.__doc('products', 'prod-1')?.stock).toBe(0);
  });

  it('s2_missing_product_and_missing_vendor_fail_closed', async () => {
    const dbNoProduct = createFakeFirestore();
    seedVendorOrder(dbNoProduct);
    dbNoProduct.__store.get('products')!.delete('prod-1');
    const reqA = await raiseVerify(dbNoProduct);
    await expect(decideMoneyApproval(dbNoProduct as never, checker, reqA.id, 'approve')).rejects.toMatchObject({
      status: 422,
      code: 'PRODUCT_MISSING',
    });
    expect(dbNoProduct.__doc('money_approvals', reqA.id)?.status).toBe('pending');
    expect(collectionSize(dbNoProduct, 'commission_ledger')).toBe(0);

    const dbNoVendor = createFakeFirestore();
    seedVendorOrder(dbNoVendor);
    dbNoVendor.__store.get('vendors')!.delete('vendor-1');
    const reqB = await raiseVerify(dbNoVendor);
    await expect(decideMoneyApproval(dbNoVendor as never, checker, reqB.id, 'approve')).rejects.toMatchObject({
      status: 422,
      code: 'VENDOR_RECORD_MISSING',
    });
    expect(dbNoVendor.__doc('money_approvals', reqB.id)?.status).toBe('pending');
    expect(collectionSize(dbNoVendor, 'commission_ledger')).toBe(0);
  });

  it('verify_house_order_is_byte_identical_to_base', async () => {
    const db = createFakeFirestore();
    db.__seed('products', 'prod-1', { name: 'House Widget', stock: 7, price: 2000 });
    db.__seed('orders', 'ord-1', {
      status: 'pending_verification',
      paymentStatus: 'pending',
      total: 2000,
      buyerUserId: 'buyer-1',
      buyer: { fullName: 'Buyer One', email: 'b@example.com' },
      items: [],
      originatingModule: 'store',
      receiptUrl: 'https://drive.example/r1',
    });
    const { id } = await raiseVerify(db);
    const res = await decideMoneyApproval(db as never, checker, id, 'approve');
    expect(res.status).toBe('approved_applied');
    expect(collectionSize(db, 'ledger_entries')).toBe(1);
    expect(collectionSize(db, 'finance_receipts')).toBe(1);
    expect(collectionSize(db, 'commission_ledger')).toBe(0);
    expect(db.__doc('products', 'prod-1')?.stock).toBe(7);
  });

  it('g2_group_order_accrues_and_stays_held_at_verification', async () => {
    const db = createFakeFirestore();
    seedVendorOrder(db, { groupBuyId: 'gb-1', escrowStatus: 'held' });
    const { id } = await raiseVerify(db);
    await decideMoneyApproval(db as never, checker, id, 'approve');
    const entry = db.__doc('commission_ledger', 'ord-1')!;
    expect(entry.state).toBe('accrued');
    const order = db.__doc('orders', 'ord-1')!;
    expect(order.escrowStatus).toBe('held');
    expect(
      isLedgerEntryPayoutEligible(
        { state: entry.state as string },
        { escrowStatus: order.escrowStatus as string },
      ),
    ).toBe(false);
  });
});
