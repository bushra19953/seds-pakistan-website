/**
 * @jest-environment node
 *
 * GA unit tests for the vendor shop mirror registration (PLAN-ga
 * Section 8.4). Mocking style follows store-products-seam.test.ts:
 * '@/lib/supa' client accessors are mocked, and adapters are injected
 * through the mirror module's own test setter. No live Supabase, no
 * network. Fixtures only.
 */

const mockState = {
  clientPresent: true,
};

jest.mock('@/lib/supa', () => ({
  getSupaClient: jest.fn(() => (mockState.clientPresent ? {} : null)),
  getSupaAdapter: jest.fn(() => {
    throw new Error('tests must inject the adapter through the test setter');
  }),
}));

import { tableForCollection } from '@/lib/supa/adapter';
import {
  __resetVendorShopMirrorAdapterForTests,
  __setVendorShopMirrorAdapterForTests,
  mirrorVendorShopSet,
  mirrorVendorShopUpdate,
  type VendorShopMirrorAdapter,
} from '@/lib/supa/vendor-shop-mirror';

function recordingAdapter(fail = false) {
  const calls: Array<{ method: string; collection: string; id: string; payload: Record<string, any> }> = [];
  const adapter: VendorShopMirrorAdapter = {
    setDoc: async (collection, id, data) => {
      if (fail) throw new Error('adapter boom');
      calls.push({ method: 'setDoc', collection, id, payload: data });
    },
    updateDoc: async (collection, id, updates) => {
      if (fail) throw new Error('adapter boom');
      calls.push({ method: 'updateDoc', collection, id, payload: updates });
    },
  };
  return { adapter, calls };
}

beforeEach(() => {
  mockState.clientPresent = true;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  __resetVendorShopMirrorAdapterForTests();
  delete process.env.SUPA_PRIMARY;
  jest.restoreAllMocks();
});

describe('mirror registration', () => {
  it('tableForCollection derives the six fs table names', () => {
    expect(tableForCollection('vendors')).toBe('fs_vendors');
    expect(tableForCollection('commission_ledger')).toBe('fs_commission_ledger');
    expect(tableForCollection('vendor_payouts')).toBe('fs_vendor_payouts');
    expect(tableForCollection('store_waitlist')).toBe('fs_store_waitlist');
    expect(tableForCollection('group_buys')).toBe('fs_group_buys');
    expect(tableForCollection('store_credits')).toBe('fs_store_credits');
  });
});

describe('mirrorVendorShopSet', () => {
  it('mirrorVendorShopSet writes through the adapter with the collection name unchanged', async () => {
    const { adapter, calls } = recordingAdapter();
    __setVendorShopMirrorAdapterForTests(adapter);

    await expect(
      mirrorVendorShopSet('vendors', 'vendor-fixture-1', { businessName: 'Fixture Electronics Karachi' }),
    ).resolves.toBe(true);
    expect(calls).toEqual([
      {
        method: 'setDoc',
        collection: 'vendors',
        id: 'vendor-fixture-1',
        payload: { businessName: 'Fixture Electronics Karachi' },
      },
    ]);
  });

  it('mirrorVendorShopSet converts serverTimestamp sentinels to ISO strings in the payload', async () => {
    const { adapter, calls } = recordingAdapter();
    __setVendorShopMirrorAdapterForTests(adapter);

    await mirrorVendorShopSet('vendors', 'vendor-fixture-1', {
      createdAt: { __fv: 'serverTimestamp' },
      signedAt: new Date('2026-01-02T03:04:05.000Z'),
    });
    expect(typeof calls[0].payload.createdAt).toBe('string');
    expect(() => new Date(calls[0].payload.createdAt).toISOString()).not.toThrow();
    expect(calls[0].payload.signedAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('mirrorVendorShopSet returns false and does not throw when no Supabase client is configured', async () => {
    mockState.clientPresent = false;
    __resetVendorShopMirrorAdapterForTests();
    await expect(
      mirrorVendorShopSet('vendors', 'vendor-fixture-1', { businessName: 'Fixture' }),
    ).resolves.toBe(false);
  });

  it('mirrorVendorShopSet returns false and does not throw when the adapter throws', async () => {
    const { adapter } = recordingAdapter(true);
    __setVendorShopMirrorAdapterForTests(adapter);
    await expect(
      mirrorVendorShopSet('vendors', 'vendor-fixture-1', { businessName: 'Fixture' }),
    ).resolves.toBe(false);
  });
});

describe('mirrorVendorShopUpdate', () => {
  it('mirrorVendorShopUpdate strips a top-level id key from the payload', async () => {
    const { adapter, calls } = recordingAdapter();
    __setVendorShopMirrorAdapterForTests(adapter);

    await expect(
      mirrorVendorShopUpdate('vendors', 'vendor-fixture-1', {
        id: 'vendor-fixture-1',
        status: 'paused',
      }),
    ).resolves.toBe(true);
    expect(calls).toEqual([
      {
        method: 'updateDoc',
        collection: 'vendors',
        id: 'vendor-fixture-1',
        payload: { status: 'paused' },
      },
    ]);
  });
});

describe('flag posture (CHOICE C9)', () => {
  it('the mirror module never consults SUPA_PRIMARY', async () => {
    // C9: mirror writes resolve whenever a Supabase client is
    // configured, independent of SUPA_SURFACES and SUPA_PRIMARY.
    // Setting the primary flag for a store surface must not change
    // behaviour in either direction.
    const { adapter, calls } = recordingAdapter();
    __setVendorShopMirrorAdapterForTests(adapter);

    process.env.SUPA_PRIMARY = 'products';
    await expect(
      mirrorVendorShopSet('vendors', 'vendor-fixture-1', { businessName: 'Fixture' }),
    ).resolves.toBe(true);
    delete process.env.SUPA_PRIMARY;
    await expect(
      mirrorVendorShopSet('vendors', 'vendor-fixture-1', { businessName: 'Fixture' }),
    ).resolves.toBe(true);
    expect(calls).toHaveLength(2);
  });
});
