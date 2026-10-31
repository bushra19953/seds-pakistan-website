/**
 * @jest-environment node
 */
// T2: vendor route tests (GG plan Section 8). Proofs: V1, V5, P3.
import { createVendorFakeDb, type VendorFakeDb } from '@/lib/server/__tests__/vendor-fake-db';

const holder: { db: VendorFakeDb | null } = { db: null };

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
jest.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => new Date() } }));
jest.mock('@/lib/server/firebase-admin', () => ({ getDb: () => holder.db }));
jest.mock('@/lib/server/vendor-access', () => ({
  resolveActiveVendorByUid: async (db: VendorFakeDb, uid: string) => {
    const snap = await db.collection('vendors').where('userId', '==', uid).limit(1).get();
    if (snap.empty) return null;
    const d = snap.docs[0];
    return { id: d.id, ...(d.data() as Record<string, unknown>) };
  },
}));
jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn(() => Promise.resolve()) },
}));
jest.mock('@/lib/server/vendor-delivery', () => ({ deliverVendorOrder: jest.fn(async () => ({})) }));

import { GET as getOrders } from '../orders/route';
import { GET as getProducts } from '../products/route';
import { GET as getBalance } from '../balance/route';
import { GET as getDetail, PATCH as patchDetail } from '../orders/[id]/route';

function req(token: string | null, url = 'http://localhost/api/vendor/orders', body?: unknown) {
  return {
    method: 'GET',
    url,
    headers: { get: (h: string) => (h.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : null) },
    json: async () => body ?? {},
  } as never;
}

const VENDOR_A = { userId: 'uid-vendor-a', businessName: 'Alpha Parts', status: 'active', agreementStatus: 'signed', commissionRate: 0.1 };
const VENDOR_B = { userId: 'uid-vendor-b', businessName: 'Beta Tools', status: 'active', agreementStatus: 'signed', commissionRate: 0.1 };

function seed() {
  const db = createVendorFakeDb({
    vendors: { 'VEND-A': { ...VENDOR_A }, 'VEND-B': { ...VENDOR_B } },
    orders: {
      'ORD-1': {
        vendorId: 'VEND-A',
        status: 'verified',
        paymentStatus: 'completed',
        items: [{ productId: 'P1', productName: 'Widget', quantity: 1, price: 1000, subtotal: 1000 }],
        subtotalPkr: 1000,
        deliveryPkr: 150,
        totalPkr: 1150,
        currency: 'PKR',
        buyer: { fullName: 'Buyer One', phone: '0300-1', email: 'buyer@example.com' },
        shippingAddress: { name: 'Buyer One', address: 'Street 1', city: 'Karachi', postalCode: '75000', country: 'Pakistan' },
        buyerUserId: 'uid-buyer',
        createdAt: new Date('2026-10-30T10:00:00Z'),
      },
      'ORD-2': {
        vendorId: 'VEND-A',
        status: 'pending_verification',
        paymentStatus: 'pending',
        items: [],
        totalPkr: 500,
        currency: 'PKR',
        buyer: { fullName: 'Buyer Two', email: 'two@example.com' },
        createdAt: new Date('2026-10-30T11:00:00Z'),
      },
      'ORD-3': {
        vendorId: 'VEND-B',
        status: 'verified',
        paymentStatus: 'completed',
        items: [],
        totalPkr: 700,
        currency: 'PKR',
        buyer: { fullName: 'Buyer Three', email: 'three@example.com' },
        createdAt: new Date('2026-10-30T12:00:00Z'),
      },
      'ORD-HOUSE': {
        vendorId: null,
        status: 'verified',
        paymentStatus: 'completed',
        items: [],
        totalPkr: 300,
        currency: 'PKR',
        createdAt: new Date('2026-10-30T09:00:00Z'),
      },
    },
    products: {
      P1: { vendorId: 'VEND-A', name: 'Widget', price: 1000, currency: 'PKR', stock: 4, isActive: true },
    },
  });
  holder.db = db;
  return db;
}

describe('vendor routes', () => {
  beforeEach(() => seed());

  it('GET orders lists only the caller vendor verified orders, newest first, paginated (V1)', async () => {
    const res = await getOrders(req('vendor-a'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.orders.map((o: { id: string }) => o.id)).toEqual(['ORD-1']);
    expect(data.orders[0].buyerName).toBe('Buyer One');
    expect(data.orders[0].buyerPhone).toBe('0300-1');
    expect(JSON.stringify(data)).not.toContain('buyer@example.com');
    expect(data.pagination).toMatchObject({ limit: 20, hasMore: false });
  });

  it('GET orders hides pending_verification orders of the same vendor', async () => {
    const res = await getOrders(req('vendor-a', 'http://localhost/api/vendor/orders?status=pending_verification'));
    expect(res.status).toBe(400);
    const list = await (await getOrders(req('vendor-a'))).json();
    expect(list.orders.map((o: { id: string }) => o.id)).not.toContain('ORD-2');
  });

  it('GET orders ignores a foreign vendorId query param', async () => {
    const res = await getOrders(req('vendor-a', 'http://localhost/api/vendor/orders?vendorId=VEND-B'));
    const data = await res.json();
    expect(data.orders.map((o: { id: string }) => o.id)).toEqual(['ORD-1']);
  });

  it('GET detail for a house order id returns 404 (P3)', async () => {
    const res = await getDetail(req('vendor-a'), { params: Promise.resolve({ id: 'ORD-HOUSE' }) });
    expect(res.status).toBe(404);
  });

  it('GET detail for another vendor order id returns 404 (P3)', async () => {
    const res = await getDetail(req('vendor-a'), { params: Promise.resolve({ id: 'ORD-3' }) });
    expect(res.status).toBe(404);
  });

  it('PATCH another vendor order returns 404 and writes nothing (P3)', async () => {
    const db = holder.db!;
    const res = await patchDetail(req('vendor-a', 'http://localhost/api/vendor/orders/ORD-3', { courierName: 'TCS' }), {
      params: Promise.resolve({ id: 'ORD-3' }),
    });
    expect(res.status).toBe(404);
    const after = await db.collection('orders').doc('ORD-3').get();
    expect((after.data() as Record<string, unknown>).courierName).toBeUndefined();
  });

  it('all vendor routes reject 403 after the vendor is paused (V5)', async () => {
    const db = holder.db!;
    await db.collection('vendors').doc('VEND-A').update({ status: 'paused' });
    expect((await getProducts(req('vendor-a'))).status).toBe(403);
    expect((await getOrders(req('vendor-a'))).status).toBe(403);
    expect((await getBalance(req('vendor-a'))).status).toBe(403);
  });

  it('unauthenticated request returns 401', async () => {
    expect((await getOrders(req(null))).status).toBe(401);
    expect((await getOrders(req('bad'))).status).toBe(401);
  });

  it('a caller with no vendor record returns 403 on every vendor route', async () => {
    expect((await getProducts(req('norecord'))).status).toBe(403);
    expect((await getOrders(req('norecord'))).status).toBe(403);
    expect((await getBalance(req('norecord'))).status).toBe(403);
  });
});
