/**
 * @jest-environment node
 */
// T1: vendor-views unit tests (GG plan Section 8). Proofs: V5 unit half,
// P5 unit half, V1 unit half, P4 unit half.
const mockResolve = jest.fn();

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    auth: () => ({
      verifyIdToken: async (token: string) => {
        if (token === 'bad') throw new Error('invalid');
        return { uid: `uid-${token}` };
      },
    }),
    firestore: { Timestamp: { now: () => new Date() }, FieldValue: { serverTimestamp: () => new Date() } },
  },
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => new Date() },
}));
jest.mock('@/lib/server/firebase-admin', () => ({ getDb: () => ({}) }));
jest.mock('@/lib/server/vendor-access', () => ({
  resolveActiveVendorByUid: (...args: unknown[]) => mockResolve(...args),
}));

import {
  requireVendorContext,
  toVendorProductView,
  toVendorOrderView,
  validateFulfilmentPatch,
  nextPayoutDate,
  sumLedgerByState,
  VendorAccessError,
} from '../vendor-views';

function req(token: string | null) {
  return {
    headers: { get: (h: string) => (h.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : null) },
  } as never;
}

const ACTIVE = { id: 'VEND-A', userId: 'uid-vendor-a', businessName: 'Alpha Parts', status: 'active', agreementStatus: 'signed', commissionRate: 0.1 };

describe('requireVendorContext (rule 1)', () => {
  beforeEach(() => mockResolve.mockReset());

  it('resolveActiveVendor returns the record for an active vendor', async () => {
    mockResolve.mockResolvedValue(ACTIVE);
    const ctx = await requireVendorContext(req('vendor-a'));
    expect(ctx.vendor.id).toBe('VEND-A');
    expect(ctx.uid).toBe('uid-vendor-a');
  });

  it('resolveActiveVendor rejects 403 vendor_record_missing when no record exists', async () => {
    mockResolve.mockResolvedValue(null);
    await expect(requireVendorContext(req('norecord'))).rejects.toMatchObject({
      status: 403,
      code: 'vendor_record_missing',
    });
  });

  it('resolveActiveVendor rejects 403 vendor_not_active for paused and for exited (V5)', async () => {
    mockResolve.mockResolvedValue({ ...ACTIVE, status: 'paused' });
    await expect(requireVendorContext(req('paused'))).rejects.toMatchObject({ status: 403, code: 'vendor_not_active' });
    mockResolve.mockResolvedValue({ ...ACTIVE, status: 'exited' });
    await expect(requireVendorContext(req('paused'))).rejects.toMatchObject({ status: 403, code: 'vendor_not_active' });
  });

  it('rejects 401 without a token', async () => {
    await expect(requireVendorContext(req(null))).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
  });
});

describe('view mappers (rule 5)', () => {
  it('toVendorProductView strips every admin field (P5)', () => {
    const view = toVendorProductView({
      id: 'P1',
      data: {
        name: 'Widget',
        price: 1000,
        currency: 'PKR',
        stock: 4,
        category: 'electronics',
        imageUrl: null,
        isActive: true,
        deliveryChargePkr: 150,
        dispatchWindowWorkingDays: 2,
        deliveryPromiseDays: 5,
        groupBuyEligible: false,
        costPricePkr: 700,
        competitorPricePkr: 1200,
        competitorSource: 'rival shop',
        competitorCheckedAt: new Date(),
        priceRule: 'parts_accessibility',
        warehousePhotoDriveIds: ['drive-1'],
        createdBy: 'uid-founder',
        updatedBy: 'uid-founder',
        vendorId: 'VEND-A',
      },
    });
    const json = JSON.stringify(view);
    for (const banned of ['costPricePkr', 'competitorPricePkr', 'competitorSource', 'competitorCheckedAt', 'priceRule', 'warehousePhotoDriveIds', 'createdBy', 'vendorId']) {
      expect(json).not.toContain(banned);
    }
    expect(view.price).toBe(1000);
    expect(view.stock).toBe(4);
    expect(view.deliveryPromiseDays).toBe(5);
  });

  it('toVendorOrderView strips buyer email and admin fields, keeps phone and address (V1, P5)', () => {
    const view = toVendorOrderView({
      id: 'O1',
      data: {
        items: [{ productId: 'P1', productName: 'Widget', quantity: 1, price: 1000, subtotal: 1000 }],
        subtotalPkr: 1000,
        deliveryPkr: 150,
        totalPkr: 1150,
        currency: 'PKR',
        status: 'verified',
        paymentStatus: 'completed',
        buyer: { fullName: 'Buyer One', phone: '0300-1', email: 'buyer@example.com' },
        shippingAddress: { name: 'Buyer One', address: 'Street 1', city: 'Karachi', postalCode: '75000', country: 'Pakistan' },
        buyerUserId: 'uid-buyer',
        receiptUrl: 'https://example.com/receipt',
        commissionLedgerId: 'O1',
        payoutId: null,
        escrowStatus: 'held',
        groupBuyId: 'GB1',
      },
    });
    const json = JSON.stringify(view);
    expect(json).not.toContain('buyer@example.com');
    expect(json).not.toContain('buyerUserId');
    expect(json).not.toContain('receiptUrl');
    expect(json).not.toContain('escrowStatus');
    expect(json).not.toContain('GB1');
    expect(view.buyerName).toBe('Buyer One');
    expect(view.buyerPhone).toBe('0300-1');
    expect(view.isGroupOrder).toBe(true);
    expect((view.shippingAddress as Record<string, unknown>).city).toBe('Karachi');
  });
});

describe('validateFulfilmentPatch (rule 4)', () => {
  const current = { status: 'processing', courierName: null, trackingNumber: null };

  it('validateFulfilmentPatch rejects a price field with 409 forbidden_field (P4)', () => {
    expect(() => validateFulfilmentPatch({ price: 5 }, current)).toThrow(VendorAccessError);
    try {
      validateFulfilmentPatch({ price: 5 }, current);
    } catch (e) {
      expect(e).toMatchObject({ status: 409, code: 'forbidden_field' });
    }
  });

  it('validateFulfilmentPatch rejects status verified with 409', () => {
    try {
      validateFulfilmentPatch({ status: 'verified' }, current);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toMatchObject({ status: 409, code: 'forbidden_field' });
    }
  });

  it('validateFulfilmentPatch requires courier and tracking to ship (422)', () => {
    try {
      validateFulfilmentPatch({ status: 'shipped' }, current);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toMatchObject({ status: 422, code: 'validation' });
    }
    const ok = validateFulfilmentPatch({ status: 'shipped', courierName: 'TCS', trackingNumber: 'T-1' }, current);
    expect(ok.toStatus).toBe('shipped');
  });

  it('validateFulfilmentPatch allows deliver only from shipped (409 otherwise)', () => {
    try {
      validateFulfilmentPatch({ status: 'delivered' }, current);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toMatchObject({ status: 409, code: 'invalid_transition' });
    }
    const ok = validateFulfilmentPatch({ status: 'delivered' }, { status: 'shipped', courierName: 'TCS', trackingNumber: 'T-1' });
    expect(ok.toStatus).toBe('delivered');
  });
});

describe('helpers', () => {
  it('nextPayoutDate returns a Monday, today when Monday', () => {
    // 2026-11-02 is a Monday.
    const monday = new Date('2026-11-02T10:00:00+05:00');
    expect(nextPayoutDate(monday)).toBe('2026-11-02');
    const wednesday = new Date('2026-11-04T10:00:00+05:00');
    expect(nextPayoutDate(wednesday)).toBe('2026-11-09');
  });

  it('sumLedgerByState buckets rows by state', () => {
    const sums = sumLedgerByState([
      { state: 'accrued', vendorDuePkr: 100 },
      { state: 'payable', vendorDuePkr: 200 },
      { state: 'paid', vendorDuePkr: 300 },
      { state: 'held_dispute', vendorDuePkr: 50 },
      { state: 'payable', vendorDuePkr: -40 },
    ]);
    expect(sums).toEqual({ accruedPkr: 100, payablePkr: 160, paidPkr: 300, heldDisputePkr: 50, heldDisputeCount: 1 });
  });
});
