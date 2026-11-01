/**
 * @jest-environment node
 *
 * GD catalogue route tests (PLAN-gd Section 12, file C20):
 * spec tests C1, C2, and the catalogue half of P5.
 * Harness follows the orders route tests: fake Firestore held in a
 * holder, firebase-admin modules mocked at the boundary.
 */
import { createFakeFirestore, type FakeFirestore } from '@/lib/finance/__tests__/fake-firestore';

const holder: { db: FakeFirestore | null } = { db: null };

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    auth: () => ({ verifyIdToken: async () => ({ uid: 'unused' }) }),
    firestore: { FieldValue: { serverTimestamp: () => new Date() } },
  },
}));
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => holder.db,
}));

import { GET } from '../route';

function req(query = '') {
  return {
    method: 'GET',
    url: `http://localhost/api/store/catalogue${query}`,
    nextUrl: new URL(`http://localhost/api/store/catalogue${query}`),
    headers: { get: () => null },
  } as never;
}

const ts = (iso: string) => ({ toDate: () => new Date(iso) });

function seedCatalogue(db: FakeFirestore) {
  db.__seed('vendors', 'vendor-1', {
    businessName: 'Test Seller',
    status: 'active',
    agreementStatus: 'signed',
    contactName: 'Hidden Person',
    phone: '0300-0000000',
    email: 'hidden@example.com',
    cnicNumber: '00000-0000000-0',
    bankAccountNumber: 'PK00TEST',
    commissionRate: 0.1,
  });
  db.__seed('vendors', 'vendor-paused', {
    businessName: 'Paused Seller',
    status: 'paused',
    agreementStatus: 'signed',
  });
  db.__seed('vendors', 'vendor-exited', {
    businessName: 'Exited Seller',
    status: 'exited',
    agreementStatus: 'signed',
  });
  db.__seed('vendors', 'vendor-unsigned', {
    businessName: 'Unsigned Seller',
    status: 'active',
    agreementStatus: 'none',
  });
}

function product(overrides: Record<string, any> = {}) {
  return {
    name: 'Widget',
    description: 'A useful widget for builds',
    price: 1500,
    currency: 'PKR',
    stock: 5,
    category: 'electronics',
    isActive: true,
    imageUrl: '',
    vendorId: 'vendor-1',
    deliveryChargePkr: 200,
    dispatchWindowWorkingDays: 2,
    deliveryPromiseDays: 3,
    groupBuyEligible: false,
    groupBuyTeamSize: null,
    groupBuyWindowHours: null,
    createdAt: ts('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}

function collectKeys(value: unknown, into: Set<string>) {
  if (Array.isArray(value)) {
    value.forEach((v) => collectKeys(v, into));
  } else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      into.add(key);
      collectKeys(v, into);
    }
  }
}

describe('GET /api/store/catalogue (GD)', () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = createFakeFirestore() as never;
    holder.db = db;
    seedCatalogue(db);
  });

  it('C1: returns 200 with active products of active vendors in public shape', async () => {
    db.__seed('products', 'p1', product());
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.count).toBe(1);
    expect(body.products[0]).toMatchObject({
      id: 'p1',
      name: 'Widget',
      price: 1500,
      currency: 'PKR',
      stock: 5,
      inStock: true,
      vendorId: 'vendor-1',
      businessName: 'Test Seller',
      deliveryChargePkr: 200,
      deliveryPromiseDays: 3,
      createdAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('C1: excludes inactive products', async () => {
    db.__seed('products', 'p1', product({ isActive: false }));
    const body = await (await GET(req())).json();
    expect(body.products).toEqual([]);
    expect(body.count).toBe(0);
  });

  it('C1: excludes products of a paused vendor and of an exited vendor', async () => {
    db.__seed('products', 'p1', product({ vendorId: 'vendor-paused' }));
    db.__seed('products', 'p2', product({ vendorId: 'vendor-exited' }));
    const body = await (await GET(req())).json();
    expect(body.products).toEqual([]);
  });

  it('C1: excludes products of a vendor whose agreement is not signed (R-14)', async () => {
    db.__seed('products', 'p1', product({ vendorId: 'vendor-unsigned' }));
    const body = await (await GET(req())).json();
    expect(body.products).toEqual([]);
  });

  it('C1: excludes house products whose vendorId is null or absent', async () => {
    db.__seed('products', 'p1', product({ vendorId: null }));
    const noVendor: Record<string, any> = product();
    delete noVendor.vendorId;
    db.__seed('products', 'p2', noVendor);
    const body = await (await GET(req())).json();
    expect(body.products).toEqual([]);
  });

  it('C1: returns an empty list with 200 when there are no vendor records', async () => {
    const emptyDb = createFakeFirestore() as unknown as FakeFirestore;
    holder.db = emptyDb;
    emptyDb.__seed('products', 'p1', product());
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.products).toEqual([]);
    expect(body.count).toBe(0);
  });

  it('C2: q matches a product name fragment case-insensitively', async () => {
    db.__seed('products', 'p1', product({ name: 'Servo Motor' }));
    db.__seed('products', 'p2', product({ name: 'Wheel Kit' }));
    const body = await (await GET(req('?q=SERVO'))).json();
    expect(body.products.map((p: any) => p.id)).toEqual(['p1']);
  });

  it('C2: q matches text inside the description', async () => {
    db.__seed('products', 'p1', product({ description: 'Includes a brass gearbox' }));
    db.__seed('products', 'p2', product({ name: 'Wheel Kit', description: 'Plain kit' }));
    const body = await (await GET(req('?q=gearbox'))).json();
    expect(body.products.map((p: any) => p.id)).toEqual(['p1']);
  });

  it('C2: inStock=true hides a stock 0 product and inStock=false keeps it', async () => {
    db.__seed('products', 'p1', product({ stock: 0 }));
    db.__seed('products', 'p2', product({ name: 'In Stock Item', stock: 2 }));
    const onlyIn = await (await GET(req('?inStock=true'))).json();
    expect(onlyIn.products.map((p: any) => p.id)).toEqual(['p2']);
    const all = await (await GET(req('?inStock=false'))).json();
    expect(all.products.map((p: any) => p.id).sort()).toEqual(['p1', 'p2']);
  });

  it('C2: minPrice and maxPrice bounds are inclusive', async () => {
    db.__seed('products', 'p1', product({ price: 1000 }));
    db.__seed('products', 'p2', product({ name: 'Mid', price: 2000 }));
    db.__seed('products', 'p3', product({ name: 'Top', price: 3000 }));
    const body = await (await GET(req('?minPrice=1000&maxPrice=2000&sort=price_asc'))).json();
    expect(body.products.map((p: any) => p.id)).toEqual(['p1', 'p2']);
  });

  it('C2: sort price_asc, price_desc and newest order the results', async () => {
    db.__seed('products', 'p1', product({ price: 3000, createdAt: ts('2026-10-03T00:00:00.000Z') }));
    db.__seed('products', 'p2', product({ name: 'Cheap', price: 1000, createdAt: ts('2026-10-01T00:00:00.000Z') }));
    db.__seed('products', 'p3', product({ name: 'Mid', price: 2000, createdAt: ts('2026-10-02T00:00:00.000Z') }));
    const asc = await (await GET(req('?sort=price_asc'))).json();
    expect(asc.products.map((p: any) => p.id)).toEqual(['p2', 'p3', 'p1']);
    const desc = await (await GET(req('?sort=price_desc'))).json();
    expect(desc.products.map((p: any) => p.id)).toEqual(['p1', 'p3', 'p2']);
    const newest = await (await GET(req('?sort=newest'))).json();
    expect(newest.products.map((p: any) => p.id)).toEqual(['p1', 'p3', 'p2']);
  });

  it('C2: an unknown sort value returns 400 naming sort', async () => {
    const res = await GET(req('?sort=random'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('sort');
  });

  it('C2: minPrice greater than maxPrice returns 400', async () => {
    const res = await GET(req('?minPrice=5000&maxPrice=100'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('minPrice');
  });

  it('P5: the catalogue payload contains no admin field anywhere', async () => {
    db.__seed(
      'products',
      'p1',
      product({
        costPricePkr: 900,
        competitorPricePkr: 1800,
        competitorSource: 'rival shop',
        competitorCheckedAt: ts('2026-10-01T00:00:00.000Z'),
        priceRule: 'parts_accessibility',
        warehousePhotoDriveIds: ['drive-1'],
        createdBy: 'admin-uid',
        updatedBy: 'admin-uid',
      }),
    );
    const body = await (await GET(req())).json();
    const keys = new Set<string>();
    collectKeys(body, keys);
    const banned = [
      'costPricePkr',
      'competitorPricePkr',
      'competitorSource',
      'competitorCheckedAt',
      'priceRule',
      'warehousePhotoDriveIds',
      'createdBy',
      'updatedBy',
      'contactName',
      'phone',
      'email',
      'city',
      'warehouseAddress',
      'cnicNumber',
      'bankName',
      'bankAccountTitle',
      'bankAccountNumber',
      'agreementStatus',
      'agreementDriveFileId',
      'agreementSignedAt',
      'commissionRate',
      'status',
      'userId',
    ];
    for (const field of banned) {
      expect(keys.has(field)).toBe(false);
    }
    expect(JSON.stringify(body)).not.toContain('Hidden Person');
    expect(JSON.stringify(body)).not.toContain('0300-0000000');
  });
});
