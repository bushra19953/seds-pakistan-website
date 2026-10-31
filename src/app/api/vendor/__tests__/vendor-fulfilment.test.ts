/**
 * @jest-environment node
 */
// T3: vendor fulfilment tests (GG plan Section 8). Proofs: F1, F2, V2 API half, P4 route half.
import { createVendorFakeDb, type VendorFakeDb } from '@/lib/server/__tests__/vendor-fake-db';

const holder: { db: VendorFakeDb | null } = { db: null };
const mockDeliver = jest.fn();

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
jest.mock('@/lib/server/vendor-delivery', () => ({
  deliverVendorOrder: (...args: unknown[]) => mockDeliver(...args),
}));

import { GET as getDetail, PATCH as patchDetail } from '../orders/[id]/route';

function req(token: string, body?: unknown) {
  return {
    method: 'PATCH',
    url: 'http://localhost/api/vendor/orders/ORD-1',
    headers: { get: (h: string) => (h.toLowerCase() === 'authorization' ? `Bearer ${token}` : null) },
    json: async () => body ?? {},
  } as never;
}

function seed(status = 'verified') {
  const db = createVendorFakeDb({
    vendors: {
      'VEND-A': { userId: 'uid-vendor-a', businessName: 'Alpha Parts', status: 'active', agreementStatus: 'signed', commissionRate: 0.1 },
    },
    orders: {
      'ORD-1': {
        vendorId: 'VEND-A',
        status,
        paymentStatus: 'completed',
        items: [{ productId: 'P1', productName: 'Widget', quantity: 1, price: 1000, subtotal: 1000 }],
        subtotalPkr: 1000,
        deliveryPkr: 150,
        totalPkr: 1150,
        currency: 'PKR',
        buyer: { fullName: 'Buyer One', phone: '0300-1' },
        buyerUserId: 'uid-buyer',
        courierName: status === 'shipped' ? 'TCS' : null,
        trackingNumber: status === 'shipped' ? 'T-1' : null,
        createdAt: new Date('2026-10-30T10:00:00Z'),
      },
    },
  });
  holder.db = db;
  return db;
}

async function orderData(db: VendorFakeDb) {
  const snap = await db.collection('orders').doc('ORD-1').get();
  return snap.data() as Record<string, unknown>;
}

describe('vendor fulfilment', () => {
  beforeEach(() => {
    mockDeliver.mockReset();
    mockDeliver.mockImplementation(async (db: VendorFakeDb, input: { orderId: string }) => {
      const ref = db.collection('orders').doc(input.orderId);
      const snap = await ref.get();
      const data = snap.data() as Record<string, unknown>;
      if (data.status !== 'shipped') {
        throw Object.assign(new Error('Only a shipped order can be marked delivered'), { status: 409, code: 'INVALID_TRANSITION' });
      }
      await ref.update({ status: 'delivered', deliveredAt: new Date() });
      return { orderId: input.orderId, alreadyDelivered: false, ledgerState: 'payable' };
    });
  });

  it('opening a verified order marks it processing and stamps relayedBy vendor_open (F1)', async () => {
    const db = seed('verified');
    const res = await getDetail(req('vendor-a'), { params: Promise.resolve({ id: 'ORD-1' }) });
    expect(res.status).toBe(200);
    const data = await orderData(db);
    expect(data.status).toBe('processing');
    expect(data.relayedBy).toBe('vendor_open');
    expect(data.relayedAt).toBeTruthy();
  });

  it('opening an already processing order changes nothing', async () => {
    const db = seed('processing');
    const res = await getDetail(req('vendor-a'), { params: Promise.resolve({ id: 'ORD-1' }) });
    expect(res.status).toBe(200);
    const data = await orderData(db);
    expect(data.status).toBe('processing');
    expect(data.relayedAt).toBeUndefined();
  });

  it('ship with courier and tracking sets shipped and dispatchedAt (F1, V2)', async () => {
    const db = seed('processing');
    const res = await patchDetail(req('vendor-a', { courierName: 'TCS', trackingNumber: 'T-9', status: 'shipped' }), {
      params: Promise.resolve({ id: 'ORD-1' }),
    });
    expect(res.status).toBe(200);
    const data = await orderData(db);
    expect(data.status).toBe('shipped');
    expect(data.courierName).toBe('TCS');
    expect(data.trackingNumber).toBe('T-9');
    expect(data.dispatchedAt).toBeTruthy();
  });

  it('ship without tracking returns 422 and leaves status unchanged', async () => {
    const db = seed('processing');
    const res = await patchDetail(req('vendor-a', { courierName: 'TCS', status: 'shipped' }), {
      params: Promise.resolve({ id: 'ORD-1' }),
    });
    expect(res.status).toBe(422);
    expect((await orderData(db)).status).toBe('processing');
  });

  it('PATCH with a price field returns 409 and the order is unchanged (P4)', async () => {
    const db = seed('processing');
    const res = await patchDetail(req('vendor-a', { price: 1 }), { params: Promise.resolve({ id: 'ORD-1' }) });
    expect(res.status).toBe(409);
    const data = await orderData(db);
    expect(data.status).toBe('processing');
    expect((data as Record<string, unknown>).price).toBeUndefined();
  });

  it('deliver from shipped sets deliveredAt and calls the delivery helper once with the order id (F2)', async () => {
    const db = seed('shipped');
    const res = await patchDetail(req('vendor-a', { status: 'delivered' }), { params: Promise.resolve({ id: 'ORD-1' }) });
    expect(res.status).toBe(200);
    expect(mockDeliver).toHaveBeenCalledTimes(1);
    expect(mockDeliver.mock.calls[0][1]).toMatchObject({ orderId: 'ORD-1' });
    const data = await orderData(db);
    expect(data.status).toBe('delivered');
    expect(data.deliveredAt).toBeTruthy();
  });

  it('deliver from processing returns 409', async () => {
    seed('processing');
    const res = await patchDetail(req('vendor-a', { status: 'delivered' }), { params: Promise.resolve({ id: 'ORD-1' }) });
    expect(res.status).toBe(409);
  });

  it('tracking correction on a shipped order succeeds without a status change', async () => {
    const db = seed('shipped');
    const res = await patchDetail(req('vendor-a', { trackingNumber: 'T-2' }), { params: Promise.resolve({ id: 'ORD-1' }) });
    expect(res.status).toBe(200);
    const data = await orderData(db);
    expect(data.status).toBe('shipped');
    expect(data.trackingNumber).toBe('T-2');
  });
});
