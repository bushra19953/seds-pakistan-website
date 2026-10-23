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
        // No role claim on the token: after the Family F parity conversion
        // the gate reads the caller's holder record from Firestore by uid.
        return { uid: `uid-${token}` };
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
        return { uid: `uid-${token}` };
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
    // Holder records (Family F parity): the store gate now resolves
    // hasServerPermissionForUser(db, decoded.uid, 'canManageStore') against
    // Firestore. Token 'admin1' is the canonical custom-holder fixture:
    // primary member + unexpired custom grant supplying canManageStore.
    db.__seed('roleDefinitions', 'custom_verify_design_aide', {
      isCustom: true,
      permissions: ['canManageStore'],
    });
    db.__seed('roles', 'uid-admin1', {
      role: 'member',
      additionalRoles: ['custom_verify_design_aide'],
    });
    // Catalog holder admitted before the conversion is still admitted,
    // now via its Firestore holder record (primary role in roles/{uid}).
    db.__seed('roles', 'uid-catalog', { role: 'superadmin' });
    // Expired custom grant and grant-less member fixtures.
    db.__seed('roles', 'uid-expired', {
      role: 'member',
      additionalRoles: ['custom_verify_design_aide'],
      expiresAt: new Date('2020-01-01T00:00:00.000Z'),
      expiresRoleKey: 'custom_verify_design_aide',
    });
    db.__seed('roles', 'uid-plain', { role: 'member' });
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

  it('PATCH as catalog holder (primary superadmin in Firestore) still succeeds', async () => {
    const res = await PATCH(req('catalog', { orderId: 'ord-x', updates: { status: 'shipped' } }));
    expect(res.status).toBe(200);
  });

  it('PATCH with an expired custom grant is 403 Forbidden (unchanged denial)', async () => {
    const res = await PATCH(req('expired', { orderId: 'ord-x', updates: { status: 'shipped' } }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Forbidden');
  });

  it('PATCH with no grant at all is 403 Forbidden', async () => {
    const res = await PATCH(req('plain', { orderId: 'ord-x', updates: { status: 'shipped' } }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Forbidden');
  });

  it('DELETE is 410 Gone (soft delete via approvals instead)', async () => {
    const res = await DELETE(req('admin1', undefined, 'http://localhost/api/store/orders?orderId=ord-x'));
    expect(res.status).toBe(410);
    expect(db.__doc('orders', 'ord-x')).toBeDefined();
  });
});
