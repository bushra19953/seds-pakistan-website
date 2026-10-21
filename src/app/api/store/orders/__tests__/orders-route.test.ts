/**
 * @jest-environment node
 */
// Canonical orders writer tests (spec Part C 4.8, CH-13): all writers must
// round-trip through the canonical shape.
import { createFakeFirestore, type FakeFirestore } from '@/lib/finance/__tests__/fake-firestore';

const holder: { db: FakeFirestore | null } = { db: null };

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    auth: () => ({
      verifyIdToken: async (token: string) => {
        if (token === 'bad') throw new Error('invalid');
        return { uid: `uid-${token}`, role: token === 'buyer' ? 'member' : 'store_admin' };
      },
    }),
    firestore: {
      Timestamp: { now: () => new Date() },
      FieldValue: { serverTimestamp: () => new Date(), arrayUnion: (v: unknown) => v },
    },
  },
}));
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => holder.db,
  admin: {
    auth: () => ({
      verifyIdToken: async (token: string) => {
        if (token === 'bad') throw new Error('invalid');
        return { uid: `uid-${token}`, role: token === 'buyer' ? 'member' : 'store_admin' };
      },
    }),
  },
}));
jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    broadcastByRoles: jest.fn(() => Promise.resolve()),
    send: jest.fn(() => Promise.resolve()),
  },
}));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async (role: string, perm: string) => role === 'store_admin' && perm === 'canManageStore'),
  resolveCanonicalRole: jest.fn(async () => 'store_admin'),
}));

import { POST, PATCH, DELETE } from '../route';
import { normalizeOrder } from '@/lib/finance/order-canonical';

function req(token: string | null, body?: unknown, url = 'http://localhost/api/store/orders') {
  return {
    method: 'POST',
    url,
    headers: { get: (h: string) => (h.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : null) },
    json: async () => body ?? {},
  } as never;
}

describe('orders API canonical writers (CH-13)', () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = createFakeFirestore() as never;
    holder.db = db;
    db.__seed('products', 'prod-1', { name: 'Ticket', price: 500 });
    db.__seed('orders', 'ord-x', {
      status: 'pending_verification', paymentStatus: 'pending', total: 500, totalPkr: 500,
      buyerUserId: 'uid-buyer', items: [],
    });
  });

  it('POST without a token is 401 (anonymous creation closed)', async () => {
    const res = await POST(req(null, { amount: 500, productId: 'prod-1' }));
    expect(res.status).toBe(401);
  });

  it('POST with a price mismatch is 422', async () => {
    const res = await POST(req('buyer', { amount: 999, productId: 'prod-1', buyer: { fullName: 'B' } }));
    expect(res.status).toBe(422);
  });

  it('POST writes the canonical shape and round-trips through normalizeOrder', async () => {
    const res = await POST(req('buyer', { amount: 500, productId: 'prod-1', buyer: { fullName: 'B' }, receiptUrl: 'https://drive.example/r' }));
    expect(res.status).toBe(200);
    const { orderId } = await res.json();
    const stored = db.__doc('orders', orderId)!;
    expect(stored.status).toBe('pending_verification');
    expect(stored.paymentStatus).toBe('pending');
    expect(stored.totalPkr).toBe(500);
    expect(stored.buyerUserId).toBe('uid-buyer');
    const canonical = normalizeOrder(stored, orderId);
    expect(canonical.totalPkr).toBe(500);
    expect(canonical.buyerUserId).toBe('uid-buyer');
    expect(canonical.receiptUrl).toBe('https://drive.example/r');
  });

  it('PATCH with a money field is 409 pointing at the approvals flow', async () => {
    const res = await PATCH(req('admin1', { orderId: 'ord-x', updates: { paymentStatus: 'completed' } }));
    expect(res.status).toBe(409);
    expect((await res.json()).useInstead).toContain('approvals');
  });

  it('PATCH with a non-money fulfilment change succeeds', async () => {
    const res = await PATCH(req('admin1', { orderId: 'ord-x', updates: { status: 'shipped', fulfilmentNote: 'TCS 123' } }));
    expect(res.status).toBe(200);
    expect(db.__doc('orders', 'ord-x')?.status).toBe('shipped');
    expect(db.__doc('orders', 'ord-x')?.fulfilmentNote).toBe('TCS 123');
  });

  it('DELETE is 410 Gone (soft delete via approvals instead)', async () => {
    const res = await DELETE(req('admin1', undefined, 'http://localhost/api/store/orders?orderId=ord-x'));
    expect(res.status).toBe(410);
    expect(db.__doc('orders', 'ord-x')).toBeDefined();
  });
});
