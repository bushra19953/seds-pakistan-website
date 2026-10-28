/**
 * @jest-environment node
 *
 * SEC-RACE (audit item 11): orders API Firestore-leg idempotency.
 * The Supa-primary leg dedupes on the Idempotency-Key header inside
 * its tx; the Firestore leg used to ignore the header and `add()` a
 * fresh order per retry. A duplicate submission with the same key
 * now returns the original orderId and creates no second order.
 * Harness follows orders-route.test.ts (finance fake Firestore).
 */
import { createFakeFirestore, type FakeFirestore } from '@/lib/finance/__tests__/fake-firestore';

const holder: { db: FakeFirestore | null } = { db: null };

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    auth: () => ({
      verifyIdToken: async (token: string) => {
        if (token === 'bad') throw new Error('invalid');
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

import { POST } from '../route';

function req(token: string, body: unknown, idempotencyKey?: string) {
  return {
    method: 'POST',
    url: 'http://localhost/api/store/orders',
    headers: {
      get: (h: string) => {
        const name = h.toLowerCase();
        if (name === 'authorization') return `Bearer ${token}`;
        if (name === 'idempotency-key') return idempotencyKey ?? null;
        return null;
      },
    },
    json: async () => body ?? {},
  } as never;
}

function orderCount(db: FakeFirestore): number {
  return ((db as any).__store.get('orders') as Map<string, any>).size;
}

describe('orders API Idempotency-Key (SEC-RACE item 11)', () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = createFakeFirestore() as never;
    holder.db = db;
    db.__seed('products', 'prod-1', { name: 'Ticket', price: 500 });
  });

  it('duplicate submission with the same key returns the same orderId and creates one order', async () => {
    const body = { amount: 500, productId: 'prod-1', buyer: { fullName: 'B' } };
    const first = await POST(req('buyer', body, 'checkout-attempt-1'));
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(orderCount(db)).toBe(1);

    const second = await POST(req('buyer', body, 'checkout-attempt-1'));
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.orderId).toBe(firstBody.orderId);
    expect(orderCount(db)).toBe(1);
    // The claim doc is the dedupe record, keyed on (buyer, key).
    const claims = (db as any).__store.get('order_idempotency') as Map<string, any>;
    expect(claims.size).toBe(1);
    expect([...claims.values()][0].orderId).toBe(firstBody.orderId);
  });

  it('a different key creates a second order (a genuinely new purchase)', async () => {
    const body = { amount: 500, productId: 'prod-1', buyer: { fullName: 'B' } };
    const first = await POST(req('buyer', body, 'checkout-attempt-1'));
    const second = await POST(req('buyer', body, 'checkout-attempt-2'));
    expect(second.status).toBe(200);
    expect((await second.json()).orderId).not.toBe((await first.json()).orderId);
    expect(orderCount(db)).toBe(2);
  });

  it('no key keeps the legacy behavior: each POST adds an order', async () => {
    const body = { amount: 500, productId: 'prod-1', buyer: { fullName: 'B' } };
    await POST(req('buyer', body));
    await POST(req('buyer', body));
    expect(orderCount(db)).toBe(2);
  });
});
