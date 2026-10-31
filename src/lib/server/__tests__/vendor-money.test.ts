/**
 * @jest-environment node
 */
// GF standalone helpers (PLAN-gf Section 9.3): money math, delivery,
// cancel, claim flag, and the PATCH guard. Maps to M2, the ledger
// half of F2, the escrow and credit halves of G2 and G4, and the
// state half of M7. Fixtures and mocks only.
import { createFakeFirestore, type FakeFirestore } from '../../finance/__tests__/fake-firestore';

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

jest.mock('@/lib/server/group-buy-hooks', () => ({
  checkAndCompleteGroupBuy: jest.fn(async () => ({ outcome: 'not_filled', state: 'open' })),
}));

import { computeCommission } from '@/lib/server/store-commission';
import {
  computeLateDeliveryCreditPkr,
  isLateDelivery,
} from '@/lib/server/store-credits';
import {
  cancelPreVerificationOrder,
  isLedgerEntryPayoutEligible,
  setReturnClaimFlag,
  vendorPatchGuard,
} from '@/lib/server/vendor-money';
import { deliverVendorOrder } from '@/lib/server/vendor-delivery';

const ACTOR = 'admin-1';

function seedShippedOrder(db: FakeFirestore, orderOverrides: Record<string, unknown> = {}, entryState = 'accrued') {
  db.__seed('orders', 'ord-1', {
    status: 'shipped',
    paymentStatus: 'completed',
    vendorId: 'vendor-1',
    buyerUserId: 'buyer-1',
    subtotalPkr: 1000,
    totalPkr: 1200,
    items: [{ productId: 'prod-1', quantity: 1 }],
    productId: 'prod-1',
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
    state: entryState,
    payoutId: null,
  });
}

describe('money math', () => {
  it('commission_math_table', () => {
    const cases: Array<[number, number, number]> = [
      [1000, 100, 900],
      [1055, 106, 949],
      [999, 100, 899],
      [250, 25, 225],
      [1, 0, 1],
      [0, 0, 0],
    ];
    for (const [subtotal, commission, due] of cases) {
      const out = computeCommission(subtotal, 0.1);
      expect(out.commissionPkr).toBe(commission);
      expect(out.vendorDuePkr).toBe(due);
    }
  });

  it('late_credit_math_table_and_bounds', () => {
    const cases: Array<[number, number]> = [
      [800, 100],
      [4000, 400],
      [4550, 460],
      [1050, 110],
      [9999, 500],
    ];
    for (const [subtotal, amount] of cases) {
      expect(computeLateDeliveryCreditPkr(subtotal)).toBe(amount);
    }
  });

  it('late_delivery_boundary_is_pakistan_time', () => {
    // Promised 2026-11-05; 23:00 PKT that day is 18:00 UTC, on time.
    expect(isLateDelivery(Date.UTC(2026, 10, 5, 18, 0), '2026-11-05')).toBe(false);
    // 00:30 PKT on 2026-11-06 is 19:30 UTC on the 5th, late.
    expect(isLateDelivery(Date.UTC(2026, 10, 5, 19, 30), '2026-11-05')).toBe(true);
    expect(isLateDelivery(Date.UTC(2026, 10, 5, 19, 30), null)).toBe(false);
    expect(isLateDelivery(Date.UTC(2026, 10, 5, 19, 30), 'not-a-date')).toBe(false);
  });
});

describe('deliverVendorOrder', () => {
  it('f2_delivery_moves_the_entry_accrued_to_payable', async () => {
    const db = createFakeFirestore();
    seedShippedOrder(db);
    const result = await deliverVendorOrder(db as never, { orderId: 'ord-1', actorUid: ACTOR });
    expect(result.alreadyDelivered).toBe(false);
    expect(result.ledgerState).toBe('payable');
    expect(result.credit).toBeNull();
    expect(result.teamCompleted).toBeNull();
    const order = db.__doc('orders', 'ord-1')!;
    expect(order.status).toBe('delivered');
    expect(order.deliveredAt).toBeTruthy();
    expect(db.__doc('commission_ledger', 'ord-1')?.state).toBe('payable');
  });

  it('delivery_with_an_open_claim_goes_to_held_dispute', async () => {
    const db = createFakeFirestore();
    seedShippedOrder(db, { returnClaimOpen: true });
    const result = await deliverVendorOrder(db as never, { orderId: 'ord-1', actorUid: ACTOR });
    expect(result.ledgerState).toBe('held_dispute');
    expect(db.__doc('commission_ledger', 'ord-1')?.state).toBe('held_dispute');
  });

  it('delivery_replay_is_a_no_op', async () => {
    const db = createFakeFirestore();
    seedShippedOrder(db, { groupBuyId: 'gb-1', escrowStatus: 'held', promisedDeliveryDate: '2026-10-01', subtotalPkr: 4000 });
    const first = await deliverVendorOrder(db as never, { orderId: 'ord-1', actorUid: ACTOR });
    expect(first.credit).not.toBeNull();
    const second = await deliverVendorOrder(db as never, { orderId: 'ord-1', actorUid: ACTOR });
    expect(second.alreadyDelivered).toBe(true);
    expect(second.credit?.id).toBe('late_ord-1');
    expect(db.__store.get('store_credits')?.size).toBe(1);
    expect(db.__doc('commission_ledger', 'ord-1')?.state).toBe('payable');
  });

  it('delivery_rejects_wrong_states_and_house_orders', async () => {
    const dbProcessing = createFakeFirestore();
    seedShippedOrder(dbProcessing, { status: 'processing' });
    await expect(
      deliverVendorOrder(dbProcessing as never, { orderId: 'ord-1', actorUid: ACTOR }),
    ).rejects.toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });

    const dbHouse = createFakeFirestore();
    dbHouse.__seed('orders', 'ord-1', { status: 'shipped', paymentStatus: 'completed', buyerUserId: 'buyer-1' });
    await expect(
      deliverVendorOrder(dbHouse as never, { orderId: 'ord-1', actorUid: ACTOR }),
    ).rejects.toMatchObject({ status: 409, code: 'NOT_VENDOR_ORDER' });

    const dbNoLedger = createFakeFirestore();
    seedShippedOrder(dbNoLedger);
    dbNoLedger.__store.get('commission_ledger')!.delete('ord-1');
    await expect(
      deliverVendorOrder(dbNoLedger as never, { orderId: 'ord-1', actorUid: ACTOR }),
    ).rejects.toMatchObject({ status: 500, code: 'LEDGER_MISSING' });
    expect(dbNoLedger.__doc('orders', 'ord-1')?.status).toBe('shipped');
  });

  it('g4_late_group_delivery_issues_one_bounded_credit', async () => {
    const db = createFakeFirestore();
    seedShippedOrder(db, {
      groupBuyId: 'gb-1',
      escrowStatus: 'held',
      promisedDeliveryDate: '2026-10-01',
      subtotalPkr: 4000,
    });
    const result = await deliverVendorOrder(db as never, { orderId: 'ord-1', actorUid: ACTOR });
    expect(result.credit).toEqual({ id: 'late_ord-1', code: 'LATE-ORD-1', amountPkr: 400 });
    expect(result.escrowStatus).toBe('released');
    expect(result.teamCompleted).toBe(false);
    const credit = db.__doc('store_credits', 'late_ord-1')!;
    expect(credit.state).toBe('available');
    expect(credit.userId).toBe('buyer-1');
    expect(credit.sourceOrderId).toBe('ord-1');
    expect(credit.groupBuyId).toBe('gb-1');
    expect(credit.consumedOrderId).toBeNull();
    const order = db.__doc('orders', 'ord-1')!;
    expect(order.escrowStatus).toBe('released');
    const deliveredMs = (order.deliveredAt as Date).getTime();
    const expiryMs = (credit.expiresAt as Date).getTime();
    expect(Math.abs(expiryMs - deliveredMs - 90 * 24 * 60 * 60 * 1000)).toBeLessThan(5000);
  });

  it('g4_on_time_group_delivery_and_late_single_order_issue_no_credit', async () => {
    const todayPkt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const dbOnTime = createFakeFirestore();
    seedShippedOrder(dbOnTime, { groupBuyId: 'gb-1', escrowStatus: 'held', promisedDeliveryDate: todayPkt });
    const onTime = await deliverVendorOrder(dbOnTime as never, { orderId: 'ord-1', actorUid: ACTOR });
    expect(onTime.credit).toBeNull();
    expect(dbOnTime.__store.get('store_credits')?.size ?? 0).toBe(0);

    const dbSingle = createFakeFirestore();
    seedShippedOrder(dbSingle, { promisedDeliveryDate: '2026-10-01' });
    const single = await deliverVendorOrder(dbSingle as never, { orderId: 'ord-1', actorUid: ACTOR });
    expect(single.credit).toBeNull();
    expect(dbSingle.__store.get('store_credits')?.size ?? 0).toBe(0);
  });

  it('g2_delivery_releases_escrow_and_makes_the_entry_eligible', async () => {
    const db = createFakeFirestore();
    seedShippedOrder(db, { groupBuyId: 'gb-1', escrowStatus: 'held' });
    expect(
      isLedgerEntryPayoutEligible({ state: 'accrued' }, { escrowStatus: 'held' }),
    ).toBe(false);
    await deliverVendorOrder(db as never, { orderId: 'ord-1', actorUid: ACTOR });
    const order = db.__doc('orders', 'ord-1')!;
    const entry = db.__doc('commission_ledger', 'ord-1')!;
    expect(order.escrowStatus).toBe('released');
    expect(entry.state).toBe('payable');
    expect(
      isLedgerEntryPayoutEligible(
        { state: entry.state as string },
        { escrowStatus: order.escrowStatus as string },
      ),
    ).toBe(true);
  });
});

describe('cancelPreVerificationOrder', () => {
  it('cancel_restores_credit_and_refuses_later_states', async () => {
    const db = createFakeFirestore();
    db.__seed('orders', 'ord-1', {
      status: 'pending_verification', paymentStatus: 'pending', vendorId: 'vendor-1',
      buyerUserId: 'buyer-1', groupBuyId: 'gb-1', creditAppliedPkr: 200,
    });
    db.__seed('store_credits', 'credit-1', {
      userId: 'buyer-1', code: 'LATE-AAAAAA', amountPkr: 200, sourceOrderId: 'ord-x',
      groupBuyId: 'gb-0', state: 'consumed', consumedOrderId: 'ord-1', expiresAt: new Date(),
    });
    const result = await cancelPreVerificationOrder(db as never, { orderId: 'ord-1', actorUid: ACTOR });
    expect(result).toEqual({ orderId: 'ord-1', alreadyCancelled: false, groupBuyId: 'gb-1', creditsRestored: 1 });
    expect(db.__doc('orders', 'ord-1')?.status).toBe('cancelled');
    expect(db.__doc('store_credits', 'credit-1')?.state).toBe('available');
    expect(db.__doc('store_credits', 'credit-1')?.consumedOrderId).toBeNull();

    const replay = await cancelPreVerificationOrder(db as never, { orderId: 'ord-1', actorUid: ACTOR });
    expect(replay.alreadyCancelled).toBe(true);

    const dbVerified = createFakeFirestore();
    dbVerified.__seed('orders', 'ord-1', {
      status: 'verified', paymentStatus: 'completed', vendorId: 'vendor-1',
      buyerUserId: 'buyer-1', creditAppliedPkr: 200,
    });
    dbVerified.__seed('store_credits', 'credit-1', {
      userId: 'buyer-1', code: 'LATE-AAAAAA', amountPkr: 200, sourceOrderId: 'ord-x',
      groupBuyId: 'gb-0', state: 'consumed', consumedOrderId: 'ord-1', expiresAt: new Date(),
    });
    await expect(
      cancelPreVerificationOrder(dbVerified as never, { orderId: 'ord-1', actorUid: ACTOR }),
    ).rejects.toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });
    expect(dbVerified.__doc('store_credits', 'credit-1')?.state).toBe('consumed');
  });
});

describe('setReturnClaimFlag', () => {
  it('m7_claim_flag_flips_payable_both_ways_and_spares_other_states', async () => {
    const db = createFakeFirestore();
    seedShippedOrder(db, { status: 'delivered' }, 'payable');
    const opened = await setReturnClaimFlag(db as never, { orderId: 'ord-1', claimOpen: true, actorUid: ACTOR });
    expect(opened).toEqual({ orderId: 'ord-1', claimOpen: true, ledgerState: 'held_dispute', changed: true });
    expect(db.__doc('orders', 'ord-1')?.returnClaimOpen).toBe(true);
    expect(
      isLedgerEntryPayoutEligible({ state: 'held_dispute' }, { escrowStatus: 'released' }),
    ).toBe(false);

    const repeat = await setReturnClaimFlag(db as never, { orderId: 'ord-1', claimOpen: true, actorUid: ACTOR });
    expect(repeat.changed).toBe(false);

    const closed = await setReturnClaimFlag(db as never, { orderId: 'ord-1', claimOpen: false, actorUid: ACTOR });
    expect(closed.ledgerState).toBe('payable');
    expect(db.__doc('commission_ledger', 'ord-1')?.state).toBe('payable');

    const dbAccrued = createFakeFirestore();
    seedShippedOrder(dbAccrued, { status: 'verified' }, 'accrued');
    const accruedOpen = await setReturnClaimFlag(dbAccrued as never, { orderId: 'ord-1', claimOpen: true, actorUid: ACTOR });
    expect(accruedOpen.ledgerState).toBe('accrued');
    expect(dbAccrued.__doc('orders', 'ord-1')?.returnClaimOpen).toBe(true);

    const dbPaid = createFakeFirestore();
    seedShippedOrder(dbPaid, { status: 'delivered' }, 'paid');
    const paidOpen = await setReturnClaimFlag(dbPaid as never, { orderId: 'ord-1', claimOpen: true, actorUid: ACTOR });
    expect(paidOpen.ledgerState).toBe('paid');
    expect(dbPaid.__doc('commission_ledger', 'ord-1')?.state).toBe('paid');
  });
});

describe('vendorPatchGuard', () => {
  it('patch_guard_blocks_only_the_two_vendor_cases', () => {
    expect(vendorPatchGuard({ vendorId: 'vendor-1' }, { status: 'delivered' })).toMatchObject({ blocked: true, status: 409 });
    expect(
      vendorPatchGuard({ vendorId: 'vendor-1', creditAppliedPkr: 200 }, { status: 'cancelled' }),
    ).toMatchObject({ blocked: true });
    expect(
      vendorPatchGuard({ vendorId: 'vendor-1', groupBuyId: 'gb-1' }, { status: 'cancelled' }),
    ).toMatchObject({ blocked: true });
    expect(vendorPatchGuard({ vendorId: 'vendor-1' }, { status: 'cancelled' })).toEqual({ blocked: false });
    expect(vendorPatchGuard({}, { status: 'delivered' })).toEqual({ blocked: false });
    expect(vendorPatchGuard({}, { status: 'cancelled' })).toEqual({ blocked: false });
    expect(vendorPatchGuard({ vendorId: 'vendor-1' }, { status: 'shipped' })).toEqual({ blocked: false });
    expect(vendorPatchGuard({ vendorId: 'vendor-1' }, { fulfilmentNote: 'x' })).toEqual({ blocked: false });
  });
});
