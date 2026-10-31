/**
 * @jest-environment node
 *
 * Vendor shop pilot, GB (PLAN-gb Section 10.4): the listing gates in
 * /api/store/products, on POST and PATCH, on the Firestore path and
 * the Supa primacy path. Spec tests D1, D2, P1.
 *
 * The gate itself (src/lib/server/listing-gate.ts) runs REAL against
 * the fake stores; the permission seam and the store primacy seam are
 * mocked, following the sibling suites' patterns.
 *
 * Fixtures only: vendor ids 'vendor-1' / 'vendor-unknown', business
 * name "Fixture Electronics". No production data.
 */

import { NextRequest } from 'next/server';

const state = {
  permissionGranted: true,
  primary: false,
  products: new Map<string, Record<string, any>>(),
  vendors: new Map<string, Record<string, any>>(),
  auditEntries: [] as Array<any>,
  txCalls: [] as Array<{ kind: string; args: any }>,
};

let productSeq = 0;
let auditSeq = 0;

function makeDocRef(collection: string, id: string) {
  const store = collection === 'products' ? state.products : state.vendors;
  return {
    id,
    path: `${collection}/${id}`,
    get: async () => {
      const data = store.get(id);
      return { exists: !!data, id, data: () => (data ? { ...data } : undefined) };
    },
  };
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'products' || name === 'vendors') {
      return {
        doc: (id: string) => makeDocRef(name, id),
        add: async (data: any) => {
          const id = `prod-${++productSeq}`;
          state.products.set(id, data);
          return { id };
        },
        get: async () => ({
          docs: [...state.products.entries()].map(([id, data]) => ({ id, data: () => ({ ...data }) })),
        }),
      };
    }
    if (name === 'audit_logs') {
      return {
        doc: () => ({ id: `audit-${++auditSeq}`, path: `audit_logs/audit-${auditSeq}` }),
        add: async (data: any) => {
          state.auditEntries.push(data);
          return { id: 'audit-add' };
        },
      };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
  batch: () => {
    const ops: Array<{ kind: string; ref: any; data?: any }> = [];
    return {
      update: (ref: any, data: any) => ops.push({ kind: 'update', ref, data }),
      set: (ref: any, data: any) => ops.push({ kind: 'set', ref, data }),
      delete: (ref: any) => ops.push({ kind: 'delete', ref }),
      commit: async () => {
        for (const o of ops) {
          if (o.ref.path?.startsWith('audit_logs/')) state.auditEntries.push(o.data);
          else if (o.ref.path?.startsWith('products/')) {
            if (o.kind === 'delete') state.products.delete(o.ref.id);
            else if (o.kind === 'update') {
              state.products.set(o.ref.id, { ...(state.products.get(o.ref.id) || {}), ...o.data });
            }
          }
        }
      },
    };
  },
};

const adminStub = {
  auth: () => ({ verifyIdToken: async () => ({ uid: 'admin-1' }) }),
  firestore: {
    Timestamp: {
      now: () => ({ toDate: () => new Date(), toMillis: () => Date.now() }),
      fromDate: (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime() }),
    },
    FieldValue: { serverTimestamp: () => 'ts' },
  },
};

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: adminStub,
  ...adminStub,
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
  ensureAdminInitialized: jest.fn(() => true),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => state.permissionGranted),
}));

jest.mock('@/lib/supa/store-products', () => ({
  listStoreProductsFromSupa: jest.fn(async () => null),
  storeProductsPrimaryEnabled: jest.fn(() => state.primary),
  createStoreProductViaPrimary: jest.fn(async (args: any) => {
    state.txCalls.push({ kind: 'create', args });
    return { ok: true, productId: 'supa-prod-1' };
  }),
  updateStoreProductViaPrimary: jest.fn(async (args: any) => {
    state.txCalls.push({ kind: 'update', args });
    return { ok: true, productId: args.productId };
  }),
  deleteStoreProductViaPrimary: jest.fn(async () => ({ ok: true, deleted: 'x' })),
  getStoreProductFromSupa: jest.fn(async () => null),
  deleteStoreProductFromSupa: jest.fn(async () => undefined),
  updateStoreProductInSupa: jest.fn(async () => undefined),
}));

import { POST, PATCH } from '@/app/api/store/products/route';
import { evaluateListingGate } from '@/lib/server/listing-gate';

function req(method: string, body?: unknown) {
  return new NextRequest('http://localhost/api/store/products', {
    method,
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function seedVendor(overrides: Record<string, any> = {}) {
  state.vendors.set('vendor-1', {
    userId: 'vendor-user-1',
    businessName: 'Fixture Electronics',
    status: 'active',
    agreementStatus: 'signed',
    ...overrides,
  });
}

const GATE_PASS_FIELDS = {
  costPricePkr: 500,
  competitorPricePkr: 900,
  competitorSource: 'Fixture listing site',
  competitorCheckedAt: '2026-10-30T00:00:00.000Z',
  priceRule: 'parts_accessibility',
};

function vendorPostBody(overrides: Record<string, any> = {}) {
  return {
    name: 'Fixture Widget',
    description: 'A fixture product',
    price: 1000,
    currency: 'PKR',
    category: 'electronics',
    vendorId: 'vendor-1',
    ...GATE_PASS_FIELDS,
    ...overrides,
  };
}

function gateNames(body: any): string[] {
  return (body.failedGates ?? []).map((f: any) => f.gate);
}

beforeEach(() => {
  state.permissionGranted = true;
  state.primary = false;
  state.products = new Map();
  state.vendors = new Map();
  state.auditEntries = [];
  state.txCalls = [];
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('listing gates on POST', () => {
  it('D1: activation without a cost price is rejected and names the cost gate', async () => {
    seedVendor();
    const res = await POST(req('POST', vendorPostBody({ costPricePkr: undefined })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('LISTING_GATE_FAILED');
    expect(gateNames(body)).toEqual(['cost_price_missing']);
    expect(body.error).toContain('cost price is missing');
    expect(state.products.size).toBe(0);
    expect(state.auditEntries).toHaveLength(0);
  });

  it('D2a: activation without a competitor check is rejected and names the competitor gate', async () => {
    seedVendor();
    const res = await POST(req('POST', vendorPostBody({ competitorCheckedAt: undefined })));
    expect(res.status).toBe(422);
    expect(gateNames(await res.json())).toEqual(['competitor_check_missing']);
  });

  it('D2b: activation without a price rule is rejected and names the price rule gate', async () => {
    seedVendor();
    const res = await POST(req('POST', vendorPostBody({ priceRule: undefined })));
    expect(res.status).toBe(422);
    expect(gateNames(await res.json())).toEqual(['price_rule_missing']);
  });

  it('D2 combined: activation with every gate failing names every gate in order', async () => {
    seedVendor({ status: 'paused', agreementStatus: 'none' });
    const res = await POST(req('POST', { name: 'Fixture Widget', price: 1000, vendorId: 'vendor-1' }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(gateNames(body)).toEqual([
      'vendor_not_active',
      'agreement_not_signed',
      'cost_price_missing',
      'competitor_check_missing',
      'price_rule_missing',
    ]);
    expect(body.error).toBe(body.failedGates.map((f: any) => f.message).join(', '));
    expect(state.products.size).toBe(0);
  });

  it('P1a: activation is rejected while the vendor agreement is unsigned and names the agreement gate', async () => {
    seedVendor({ agreementStatus: 'none' });
    const res = await POST(req('POST', vendorPostBody()));
    expect(res.status).toBe(422);
    expect(gateNames(await res.json())).toEqual(['agreement_not_signed']);
  });

  it('P1b: activation succeeds after the signed agreement is recorded', async () => {
    seedVendor({ agreementStatus: 'none' });
    const refused = await POST(req('POST', vendorPostBody()));
    expect(refused.status).toBe(422);
    // The founder records the signed agreement (vendors PATCH in the
    // GB route suite); here the resulting doc state is seeded.
    state.vendors.set('vendor-1', { ...state.vendors.get('vendor-1'), agreementStatus: 'signed' });
    const res = await POST(req('POST', vendorPostBody()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(state.products.get(body.productId)).toMatchObject({
      vendorId: 'vendor-1', costPricePkr: 500, priceRule: 'parts_accessibility', currency: 'PKR',
    });
  });

  it('activation for a paused vendor is rejected and names the vendor status gate', async () => {
    seedVendor({ status: 'paused' });
    const res = await POST(req('POST', vendorPostBody()));
    expect(res.status).toBe(422);
    expect(gateNames(await res.json())).toEqual(['vendor_not_active']);
  });

  it('activation for an unknown vendor id is rejected and names the vendor gate', async () => {
    const res = await POST(req('POST', vendorPostBody({ vendorId: 'vendor-unknown' })));
    expect(res.status).toBe(422);
    expect(gateNames(await res.json())).toEqual(['vendor_not_found']);
  });

  it('creating an inactive vendor product skips the gates', async () => {
    seedVendor({ agreementStatus: 'none' });
    const res = await POST(req('POST', { name: 'Draft Widget', price: 100, vendorId: 'vendor-1', isActive: false }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(state.products.get(body.productId)?.isActive).toBe(false);
  });

  it('creating an active house product is unaffected by the gates', async () => {
    const res = await POST(req('POST', { name: 'House Widget', price: 100 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(state.products.get(body.productId)?.vendorId).toBeNull();
  });

  it('vendor product currency is forced to PKR on create and the response flags it', async () => {
    seedVendor();
    const res = await POST(req('POST', vendorPostBody({ currency: 'USD' })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currencyForced).toBe(true);
    expect(state.products.get(body.productId)?.currency).toBe('PKR');
  });

  it('an invalid price rule value is rejected with 400 before the gates', async () => {
    seedVendor({ agreementStatus: 'none' });
    const res = await POST(req('POST', vendorPostBody({ priceRule: 'whatever' })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('priceRule must be parts_accessibility or tools_accessibility');
    expect(state.products.size).toBe(0);
  });
});

describe('listing gates on PATCH', () => {
  function seedLiveVendorProduct(overrides: Record<string, any> = {}) {
    state.products.set('prod-1', {
      name: 'Fixture Widget',
      price: 1000,
      currency: 'PKR',
      isActive: true,
      vendorId: 'vendor-1',
      ...GATE_PASS_FIELDS,
      competitorCheckedAt: { toDate: () => new Date('2026-10-30T00:00:00.000Z') },
      ...overrides,
    });
  }

  it('activation of a draft vendor product runs the gates', async () => {
    seedVendor({ agreementStatus: 'none' });
    seedLiveVendorProduct({ isActive: false });
    const res = await PATCH(req('PATCH', { productId: 'prod-1', updates: { isActive: true } }));
    expect(res.status).toBe(422);
    expect(gateNames(await res.json())).toEqual(['agreement_not_signed']);
    expect(state.products.get('prod-1')?.isActive).toBe(false);
  });

  it('deactivating a vendor product never runs the gates', async () => {
    seedVendor({ status: 'paused', agreementStatus: 'none' });
    seedLiveVendorProduct();
    const res = await PATCH(req('PATCH', { productId: 'prod-1', updates: { isActive: false } }));
    expect(res.status).toBe(200);
    expect(state.products.get('prod-1')?.isActive).toBe(false);
  });

  it('a description-only edit on a live vendor product does not re-run the gates', async () => {
    seedVendor({ status: 'paused', agreementStatus: 'none' });
    seedLiveVendorProduct();
    const res = await PATCH(req('PATCH', { productId: 'prod-1', updates: { description: 'New text' } }));
    expect(res.status).toBe(200);
    expect(state.products.get('prod-1')?.description).toBe('New text');
  });

  it('clearing the cost price on a live vendor product is rejected and names the cost gate', async () => {
    seedVendor();
    seedLiveVendorProduct();
    const res = await PATCH(req('PATCH', { productId: 'prod-1', updates: { costPricePkr: null } }));
    expect(res.status).toBe(422);
    expect(gateNames(await res.json())).toEqual(['cost_price_missing']);
    expect(state.products.get('prod-1')?.costPricePkr).toBe(500);
  });

  it('vendor product currency is forced to PKR on update', async () => {
    seedVendor();
    seedLiveVendorProduct();
    const res = await PATCH(req('PATCH', { productId: 'prod-1', updates: { currency: 'USD' } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currencyForced).toBe(true);
    expect(state.products.get('prod-1')?.currency).toBe('PKR');
  });
});

describe('evaluateListingGate predicate (in-process consumers: GD catalogue, GG Vendors tab)', () => {
  const goodProduct = {
    vendorId: 'vendor-1',
    costPricePkr: 500,
    competitorCheckedAt: '2026-10-30T00:00:00.000Z',
    priceRule: 'parts_accessibility',
  };
  const goodVendor = { status: 'active', agreementStatus: 'signed' };

  it('passes a fully gated product with an active, signed vendor', () => {
    expect(evaluateListingGate(goodProduct, goodVendor)).toEqual({ ok: true });
  });

  it('reports the planner missing set in checklist order', () => {
    expect(evaluateListingGate({}, { status: 'paused', agreementStatus: 'none' })).toEqual({
      ok: false,
      missing: ['vendor-inactive', 'agreement', 'cost', 'competitor', 'priceRule'],
    });
  });

  it('a missing vendor record reports vendor-inactive and skips the agreement check', () => {
    expect(evaluateListingGate(goodProduct, null)).toEqual({ ok: false, missing: ['vendor-inactive'] });
  });
});

describe('listing gates above the primacy branch', () => {
  beforeEach(() => { state.primary = true; });

  it('a gate failure writes nothing on either store: the tx stub is never called', async () => {
    seedVendor({ agreementStatus: 'none' });
    const res = await POST(req('POST', vendorPostBody()));
    expect(res.status).toBe(422);
    expect(state.txCalls).toHaveLength(0);
    expect(state.products.size).toBe(0);
    expect(state.auditEntries).toHaveLength(0);
  });

  it('a passing vendor product reaches the primacy tx with PKR forced', async () => {
    seedVendor();
    const res = await POST(req('POST', vendorPostBody({ currency: 'USD' })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currencyForced).toBe(true);
    expect(state.txCalls).toHaveLength(1);
    expect(state.txCalls[0].args.data).toMatchObject({ vendorId: 'vendor-1', currency: 'PKR', costPricePkr: 500 });
  });
});
