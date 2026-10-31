/**
 * @jest-environment node
 *
 * GA unit tests for the vendor shop data helpers (PLAN-ga Section 8.3)
 * against the fake Firestore plus the mirror module's test setter with
 * a recording fake adapter. Fakes only: no live Firestore, no live
 * Supabase, no network.
 *
 * Fixture rule: no fixture in this file contains a real name, phone,
 * CNIC, or account number. The vendor is the fictional "Fixture
 * Electronics Karachi"; amounts are round PKR; ids are fixture ids;
 * contact and bank fields are obvious placeholder strings.
 */

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __fv: 'serverTimestamp' }) },
}));

import { FakeFirestore } from '@/lib/__tests__/helpers/fake-firestore';
import {
  __resetVendorShopMirrorAdapterForTests,
  __setVendorShopMirrorAdapterForTests,
  type VendorShopMirrorAdapter,
} from '@/lib/supa/vendor-shop-mirror';
import {
  createGroupBuy,
  createLedgerAccrual,
  createStoreCredit,
  createVendor,
  createWaitlistEntry,
  getGroupBuyByShareCode,
  getVendorByUserId,
  listAvailableCreditsForUser,
  listLedgerEntriesForVendor,
  updateLedgerEntry,
  updateVendor,
  updateWaitlistEntry,
} from '@/lib/server/vendor-shop';
import type { VendorCreateInput } from '@/types/store';

function recordingAdapter() {
  const calls: Array<{ method: string; collection: string; id: string; payload: Record<string, any> }> = [];
  const adapter: VendorShopMirrorAdapter = {
    setDoc: async (collection, id, data) => {
      calls.push({ method: 'setDoc', collection, id, payload: data });
    },
    updateDoc: async (collection, id, updates) => {
      calls.push({ method: 'updateDoc', collection, id, payload: updates });
    },
  };
  return { adapter, calls };
}

const vendorInput = (): VendorCreateInput => ({
  userId: 'user-fixture-1',
  businessName: 'Fixture Electronics Karachi',
  contactName: 'Fixture Contact',
  phone: '0300-0000000',
  email: 'vendor@fixture.example',
  city: 'Karachi',
  warehouseAddress: 'Fixture Warehouse Address',
  cnicNumber: '00000-0000000-0',
  bankName: 'Fixture Bank',
  bankAccountTitle: 'Fixture Account Title',
  bankAccountNumber: 'PK00FIXT0000000000000000',
  agreementStatus: 'signed',
  agreementDriveFileId: 'drive-fixture-1',
  agreementSignedAt: null,
  commissionRate: 0.1,
  status: 'active',
  createdBy: 'fixture-admin',
});

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  __resetVendorShopMirrorAdapterForTests();
  jest.restoreAllMocks();
});

describe('vendors', () => {
  it('createVendor writes every spec field and mirrors the same body to vendors', async () => {
    const fake = new FakeFirestore();
    const { adapter, calls } = recordingAdapter();
    __setVendorShopMirrorAdapterForTests(adapter);

    const input = vendorInput();
    const vendor = await createVendor(fake.asDb(), input);

    const stored = fake.read('vendors', vendor.id);
    expect(stored).toBeDefined();
    for (const [key, value] of Object.entries(input)) {
      expect(stored![key]).toEqual(value);
    }
    expect(stored!.createdAt).toBeDefined();
    expect(stored!.updatedAt).toBeDefined();

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('setDoc');
    expect(calls[0].collection).toBe('vendors');
    expect(calls[0].id).toBe(vendor.id);
    // Same body as the Firestore write, with the serverTimestamp
    // sentinels serialized to ISO strings by the mirror module.
    expect(calls[0].payload.businessName).toBe(input.businessName);
    expect(calls[0].payload.cnicNumber).toBe(input.cnicNumber);
    expect(typeof calls[0].payload.createdAt).toBe('string');
    expect(typeof calls[0].payload.updatedAt).toBe('string');
  });

  it('getVendorByUserId returns the matching vendor and null when absent', async () => {
    const fake = new FakeFirestore();
    __setVendorShopMirrorAdapterForTests(recordingAdapter().adapter);
    const vendor = await createVendor(fake.asDb(), vendorInput());

    await expect(getVendorByUserId(fake.asDb(), 'user-fixture-1')).resolves.toMatchObject({
      id: vendor.id,
      businessName: 'Fixture Electronics Karachi',
    });
    await expect(getVendorByUserId(fake.asDb(), 'user-fixture-absent')).resolves.toBeNull();
  });

  it('updateVendor mirrors the same subset it writes', async () => {
    const fake = new FakeFirestore();
    const { adapter, calls } = recordingAdapter();
    __setVendorShopMirrorAdapterForTests(adapter);
    const vendor = await createVendor(fake.asDb(), vendorInput());
    calls.length = 0;

    await updateVendor(fake.asDb(), vendor.id, { status: 'paused', city: 'Lahore' });

    const stored = fake.read('vendors', vendor.id);
    expect(stored!.status).toBe('paused');
    expect(stored!.city).toBe('Lahore');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('updateDoc');
    expect(calls[0].collection).toBe('vendors');
    expect(calls[0].id).toBe(vendor.id);
    expect(calls[0].payload.status).toBe('paused');
    expect(calls[0].payload.city).toBe('Lahore');
    expect(typeof calls[0].payload.updatedAt).toBe('string');
  });
});

describe('commission ledger', () => {
  it('createLedgerAccrual uses the orderId as the document id', async () => {
    const fake = new FakeFirestore();
    __setVendorShopMirrorAdapterForTests(recordingAdapter().adapter);

    const entry = await createLedgerAccrual(fake.asDb(), {
      vendorId: 'vendor-fixture-1',
      orderId: 'order-fixture-1',
      type: 'accrual',
      salePricePkr: 10000,
      commissionRate: 0.1,
      commissionPkr: 1000,
      vendorDuePkr: 9000,
      state: 'accrued',
      payoutId: null,
    });

    expect(entry.id).toBe('order-fixture-1');
    expect(fake.read('commission_ledger', 'order-fixture-1')).toMatchObject({
      vendorId: 'vendor-fixture-1',
      orderId: 'order-fixture-1',
      type: 'accrual',
    });
  });

  it('a second accrual for the same orderId rejects', async () => {
    const fake = new FakeFirestore();
    __setVendorShopMirrorAdapterForTests(recordingAdapter().adapter);
    const input = {
      vendorId: 'vendor-fixture-1',
      orderId: 'order-fixture-1',
      type: 'accrual' as const,
      salePricePkr: 10000,
      commissionRate: 0.1,
      commissionPkr: 1000,
      vendorDuePkr: 9000,
      state: 'accrued' as const,
      payoutId: null,
    };
    await createLedgerAccrual(fake.asDb(), input);
    await expect(createLedgerAccrual(fake.asDb(), input)).rejects.toThrow(/ALREADY_EXISTS/);
  });

  it('createLedgerAccrual with type adjustment uses an auto id and keeps the orderId field', async () => {
    const fake = new FakeFirestore();
    __setVendorShopMirrorAdapterForTests(recordingAdapter().adapter);

    const entry = await createLedgerAccrual(fake.asDb(), {
      vendorId: 'vendor-fixture-1',
      orderId: 'order-fixture-1',
      type: 'adjustment',
      salePricePkr: 10000,
      commissionRate: 0.1,
      commissionPkr: 1000,
      vendorDuePkr: -9000,
      state: 'reversed',
      payoutId: null,
    });

    expect(entry.id).not.toBe('order-fixture-1');
    expect(fake.read('commission_ledger', entry.id)).toMatchObject({
      orderId: 'order-fixture-1',
      type: 'adjustment',
      vendorDuePkr: -9000,
    });
  });

  it('listLedgerEntriesForVendor filters by state when a state is given', async () => {
    const fake = new FakeFirestore();
    __setVendorShopMirrorAdapterForTests(recordingAdapter().adapter);
    const base = {
      vendorId: 'vendor-fixture-1',
      commissionRate: 0.1,
      commissionPkr: 100,
      vendorDuePkr: 900,
      payoutId: null,
    };
    await createLedgerAccrual(fake.asDb(), {
      ...base,
      orderId: 'order-fixture-1',
      type: 'accrual',
      salePricePkr: 1000,
      state: 'accrued',
    });
    await createLedgerAccrual(fake.asDb(), {
      ...base,
      orderId: 'order-fixture-2',
      type: 'accrual',
      salePricePkr: 2000,
      state: 'payable',
    });
    fake.seed('commission_ledger', 'entry-other-vendor', {
      ...base,
      vendorId: 'vendor-fixture-2',
      orderId: 'order-fixture-3',
      type: 'accrual',
      salePricePkr: 3000,
      state: 'accrued',
    });

    const all = await listLedgerEntriesForVendor(fake.asDb(), 'vendor-fixture-1');
    expect(all.map((e) => e.id).sort()).toEqual(['order-fixture-1', 'order-fixture-2']);
    const payable = await listLedgerEntriesForVendor(fake.asDb(), 'vendor-fixture-1', 'payable');
    expect(payable.map((e) => e.id)).toEqual(['order-fixture-2']);
  });

  it('updateLedgerEntry mirrors the same subset it writes', async () => {
    const fake = new FakeFirestore();
    const { adapter, calls } = recordingAdapter();
    __setVendorShopMirrorAdapterForTests(adapter);
    await createLedgerAccrual(fake.asDb(), {
      vendorId: 'vendor-fixture-1',
      orderId: 'order-fixture-1',
      type: 'accrual',
      salePricePkr: 10000,
      commissionRate: 0.1,
      commissionPkr: 1000,
      vendorDuePkr: 9000,
      state: 'accrued',
      payoutId: null,
    });
    calls.length = 0;

    await updateLedgerEntry(fake.asDb(), 'order-fixture-1', {
      state: 'payable',
      payoutId: 'payout-fixture-1',
    });

    expect(fake.read('commission_ledger', 'order-fixture-1')).toMatchObject({
      state: 'payable',
      payoutId: 'payout-fixture-1',
    });
    expect(calls).toEqual([
      expect.objectContaining({
        method: 'updateDoc',
        collection: 'commission_ledger',
        id: 'order-fixture-1',
        payload: expect.objectContaining({ state: 'payable', payoutId: 'payout-fixture-1' }),
      }),
    ]);
  });
});

describe('store credits', () => {
  it('listAvailableCreditsForUser returns only available credits, oldest first', async () => {
    const fake = new FakeFirestore();
    __setVendorShopMirrorAdapterForTests(recordingAdapter().adapter);
    // Seeded with numeric createdAt stand-ins so ordering is exact.
    fake.seed('store_credits', 'credit-fixture-newer', {
      userId: 'user-fixture-1',
      code: 'LATE-FIXTURE2',
      amountPkr: 200,
      sourceOrderId: 'order-fixture-2',
      groupBuyId: '',
      state: 'available',
      createdAt: 2000,
    });
    fake.seed('store_credits', 'credit-fixture-older', {
      userId: 'user-fixture-1',
      code: 'LATE-FIXTURE1',
      amountPkr: 100,
      sourceOrderId: 'order-fixture-1',
      groupBuyId: '',
      state: 'available',
      createdAt: 1000,
    });
    fake.seed('store_credits', 'credit-fixture-consumed', {
      userId: 'user-fixture-1',
      code: 'LATE-FIXTURE3',
      amountPkr: 300,
      sourceOrderId: 'order-fixture-3',
      groupBuyId: '',
      state: 'consumed',
      createdAt: 500,
    });
    fake.seed('store_credits', 'credit-fixture-other-user', {
      userId: 'user-fixture-2',
      code: 'LATE-FIXTURE4',
      amountPkr: 400,
      sourceOrderId: 'order-fixture-4',
      groupBuyId: '',
      state: 'available',
      createdAt: 100,
    });

    const credits = await listAvailableCreditsForUser(fake.asDb(), 'user-fixture-1');
    expect(credits.map((c) => c.id)).toEqual(['credit-fixture-older', 'credit-fixture-newer']);
  });
});

describe('group buys', () => {
  it('getGroupBuyByShareCode returns the matching team and null when absent', async () => {
    const fake = new FakeFirestore();
    __setVendorShopMirrorAdapterForTests(recordingAdapter().adapter);
    const team = await createGroupBuy(fake.asDb(), {
      productId: 'product-fixture-1',
      vendorId: 'vendor-fixture-1',
      shareCode: 'FIXTURECODE1',
      openerUserId: 'user-fixture-1',
      unitPricePkr: 5000,
      teamSizeTarget: 3,
      memberOrderIds: [],
      memberUserIds: ['user-fixture-1'],
      state: 'open',
      opensAt: null as never,
      expiresAt: null as never,
      refundApprovalIds: [],
    });

    await expect(getGroupBuyByShareCode(fake.asDb(), 'FIXTURECODE1')).resolves.toMatchObject({
      id: team.id,
      shareCode: 'FIXTURECODE1',
    });
    await expect(getGroupBuyByShareCode(fake.asDb(), 'NOSUCHCODE')).resolves.toBeNull();
  });
});

describe('waitlist', () => {
  it('updateWaitlistEntry mirrors the same subset it writes', async () => {
    const fake = new FakeFirestore();
    const { adapter, calls } = recordingAdapter();
    __setVendorShopMirrorAdapterForTests(adapter);
    const entry = await createWaitlistEntry(fake.asDb(), {
      productId: 'product-fixture-1',
      requestedText: '',
      searchQuery: null,
      userId: 'user-fixture-1',
      contactName: 'Fixture Contact',
      contactPhone: '0300-0000000',
      contactEmail: null,
      source: 'product_page_oos',
      status: 'open',
    });
    calls.length = 0;

    await updateWaitlistEntry(fake.asDb(), entry.id, { status: 'notified' });

    expect(fake.read('store_waitlist', entry.id)).toMatchObject({ status: 'notified' });
    expect(calls).toEqual([
      expect.objectContaining({
        method: 'updateDoc',
        collection: 'store_waitlist',
        id: entry.id,
        payload: { status: 'notified' },
      }),
    ]);
  });
});

describe('mirror failure handling', () => {
  it('a mirror failure does not fail the helper', async () => {
    const fake = new FakeFirestore();
    __setVendorShopMirrorAdapterForTests({
      setDoc: async () => {
        throw new Error('mirror boom');
      },
      updateDoc: async () => {
        throw new Error('mirror boom');
      },
    });

    const vendor = await createVendor(fake.asDb(), vendorInput());
    expect(fake.read('vendors', vendor.id)).toMatchObject({
      businessName: 'Fixture Electronics Karachi',
    });

    const credit = await createStoreCredit(fake.asDb(), {
      userId: 'user-fixture-1',
      code: 'LATE-FIXTURE1',
      amountPkr: 100,
      sourceOrderId: 'order-fixture-1',
      groupBuyId: '',
      state: 'available',
      expiresAt: null as never,
      consumedOrderId: null,
    });
    expect(fake.read('store_credits', credit.id)).toMatchObject({ code: 'LATE-FIXTURE1' });
  });
});
