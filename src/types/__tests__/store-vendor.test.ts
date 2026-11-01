/**
 * @jest-environment node
 *
 * GA unit tests for the vendor shop enum guards (PLAN-ga Section 8.2).
 * Fixtures only.
 */

import {
  COMMISSION_LEDGER_STATES,
  COMMISSION_LEDGER_TYPES,
  GROUP_BUY_STATES,
  ORDER_ESCROW_STATUSES,
  PRODUCT_PRICE_RULES,
  STORE_CREDIT_STATES,
  STORE_WAITLIST_SOURCES,
  STORE_WAITLIST_STATUSES,
  VENDOR_AGREEMENT_STATUSES,
  VENDOR_PAYOUT_STATUSES,
  VENDOR_STATUSES,
  isCommissionLedgerState,
  isCommissionLedgerType,
  isGroupBuyState,
  isOrderEscrowStatus,
  isProductPriceRule,
  isStoreCreditState,
  isStoreWaitlistSource,
  isStoreWaitlistStatus,
  isVendorAgreementStatus,
  isVendorPayoutStatus,
  isVendorStatus,
  type Product,
} from '@/types/store';

const GUARDS: Array<{
  name: string;
  values: readonly string[];
  guard: (value: unknown) => boolean;
}> = [
  { name: 'isVendorStatus', values: VENDOR_STATUSES, guard: isVendorStatus },
  { name: 'isVendorAgreementStatus', values: VENDOR_AGREEMENT_STATUSES, guard: isVendorAgreementStatus },
  { name: 'isProductPriceRule', values: PRODUCT_PRICE_RULES, guard: isProductPriceRule },
  { name: 'isOrderEscrowStatus', values: ORDER_ESCROW_STATUSES, guard: isOrderEscrowStatus },
  { name: 'isCommissionLedgerState', values: COMMISSION_LEDGER_STATES, guard: isCommissionLedgerState },
  { name: 'isCommissionLedgerType', values: COMMISSION_LEDGER_TYPES, guard: isCommissionLedgerType },
  { name: 'isVendorPayoutStatus', values: VENDOR_PAYOUT_STATUSES, guard: isVendorPayoutStatus },
  { name: 'isStoreWaitlistSource', values: STORE_WAITLIST_SOURCES, guard: isStoreWaitlistSource },
  { name: 'isStoreWaitlistStatus', values: STORE_WAITLIST_STATUSES, guard: isStoreWaitlistStatus },
  { name: 'isGroupBuyState', values: GROUP_BUY_STATES, guard: isGroupBuyState },
  { name: 'isStoreCreditState', values: STORE_CREDIT_STATES, guard: isStoreCreditState },
];

for (const { name, values, guard } of GUARDS) {
  describe(name, () => {
    it('accepts every value in its array', () => {
      for (const value of values) expect(guard(value)).toBe(true);
    });

    it('rejects an unknown string, an empty string, null, undefined, and a number', () => {
      expect(guard('not-a-real-value')).toBe(false);
      expect(guard('')).toBe(false);
      expect(guard(null)).toBe(false);
      expect(guard(undefined)).toBe(false);
      expect(guard(42)).toBe(false);
    });

    it('rejects a differently-cased valid value', () => {
      const first = values[0];
      const cased = first.charAt(0).toUpperCase() + first.slice(1);
      expect(cased).not.toBe(first);
      expect(guard(cased)).toBe(false);
    });
  });
}

describe('guard arrays match the spec enums exactly', () => {
  it('asserts each array deep-equals the spec list in order', () => {
    expect([...VENDOR_STATUSES]).toEqual(['active', 'paused', 'exited']);
    expect([...VENDOR_AGREEMENT_STATUSES]).toEqual(['none', 'signed']);
    expect([...PRODUCT_PRICE_RULES]).toEqual(['parts_accessibility', 'tools_accessibility']);
    expect([...ORDER_ESCROW_STATUSES]).toEqual(['none', 'held', 'released', 'refunded']);
    expect([...COMMISSION_LEDGER_STATES]).toEqual([
      'accrued',
      'payable',
      'held_dispute',
      'paid',
      'reversed',
    ]);
    expect([...COMMISSION_LEDGER_TYPES]).toEqual(['accrual', 'adjustment']);
    expect([...VENDOR_PAYOUT_STATUSES]).toEqual([
      'draft',
      'pending_approval',
      'approved',
      'transferred',
      'rejected',
    ]);
    expect([...STORE_WAITLIST_SOURCES]).toEqual([
      'product_page_oos',
      'product_page_rail',
      'store_search_empty',
      'order_confirmation',
    ]);
    expect([...STORE_WAITLIST_STATUSES]).toEqual(['open', 'notified', 'fulfilled', 'closed']);
    expect([...GROUP_BUY_STATES]).toEqual(['open', 'filled', 'expired', 'completed', 'cancelled']);
    expect([...STORE_CREDIT_STATES]).toEqual(['available', 'consumed', 'expired']);
  });

  it('isVendorStatus rejects Active (case-sensitive)', () => {
    expect(isVendorStatus('Active')).toBe(false);
  });
});

// Compile-time support for gate tests D1 and D2 (GB owns the runtime
// gate tests): a vendor product with every gate input missing must be
// representable in the types: costPricePkr absent (D1 reads absence),
// priceRule absent, and competitorCheckedAt null (D2 reads absent or
// null). If this literal stops typechecking, GB's gates lose a missing
// state they must be able to name.
const productWithMissingGateInputs: Omit<Product, 'costPricePkr' | 'priceRule'> & {
  competitorCheckedAt: null;
} = {
  id: 'product-fixture-1',
  name: 'Fixture Widget',
  description: 'Fixture product for the D1 and D2 type check.',
  price: 5000,
  currency: 'PKR',
  stock: 3,
  category: 'electronics',
  isActive: true,
  createdAt: null as never,
  updatedAt: null as never,
  createdBy: 'fixture-admin',
  competitorCheckedAt: null,
};

describe('D1 and D2 type support', () => {
  it('a product literal with missing gate inputs is representable', () => {
    expect(productWithMissingGateInputs.competitorCheckedAt).toBeNull();
    expect('costPricePkr' in productWithMissingGateInputs).toBe(false);
    expect('priceRule' in productWithMissingGateInputs).toBe(false);
  });
});
