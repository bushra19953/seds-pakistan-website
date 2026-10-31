/**
 * @jest-environment node
 */
// T5: waitlist admin tests (GG plan Section 8). Proofs: W1 tab half, P2 API half.
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
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: async (_db: unknown, uid: string) => uid === 'uid-founder',
}));
jest.mock('@/lib/supa/vendor-shop-mirror', () => ({
  mirrorVendorShopUpdate: async () => true,
  mirrorVendorShopSet: async () => true,
}));

import { GET } from '../route';
import { PATCH } from '../[id]/route';

function req(token: string | null, url = 'http://localhost/api/store/waitlist', body?: unknown) {
  return {
    method: 'GET',
    url,
    headers: { get: (h: string) => (h.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : null) },
    json: async () => body ?? {},
  } as never;
}

function seed() {
  const db = createVendorFakeDb({
    store_waitlist: {
      W1: {
        productId: 'P1',
        requestedText: 'Widget',
        searchQuery: null,
        userId: null,
        contactName: 'Buyer One',
        contactPhone: '0300-1',
        contactEmail: null,
        source: 'product_page_oos',
        status: 'open',
        createdAt: new Date('2026-10-30T10:00:00Z'),
      },
      W2: {
        productId: null,
        requestedText: 'Gadget',
        searchQuery: 'gadget',
        userId: null,
        contactName: 'Buyer Two',
        contactPhone: '0300-2',
        contactEmail: null,
        source: 'store_search_empty',
        status: 'notified',
        createdAt: new Date('2026-10-30T11:00:00Z'),
      },
    },
  });
  holder.db = db;
  return db;
}

describe('waitlist admin API', () => {
  beforeEach(() => seed());

  it('GET lists entries newest first with source product_page_oos (W1)', async () => {
    const res = await GET(req('founder'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entries.map((e: { id: string }) => e.id)).toEqual(['W2', 'W1']);
    expect(data.entries[1].source).toBe('product_page_oos');
  });

  it('GET filters by status', async () => {
    const data = await (await GET(req('founder', 'http://localhost/api/store/waitlist?status=open'))).json();
    expect(data.entries.map((e: { id: string }) => e.id)).toEqual(['W1']);
  });

  it('PATCH marks an entry notified and the change persists (W1)', async () => {
    const res = await PATCH(req('founder', 'http://localhost/api/store/waitlist/W1', { status: 'notified' }), {
      params: Promise.resolve({ id: 'W1' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entry.status).toBe('notified');
    const snap = await holder.db!.collection('store_waitlist').doc('W1').get();
    expect((snap.data() as Record<string, unknown>).status).toBe('notified');
    expect((snap.data() as Record<string, unknown>).statusChangedBy).toBe('uid-founder');
  });

  it('PATCH rejects an unknown status with 400', async () => {
    const res = await PATCH(req('founder', 'http://localhost/api/store/waitlist/W1', { status: 'bogus' }), {
      params: Promise.resolve({ id: 'W1' }),
    });
    expect(res.status).toBe(400);
  });

  it('PATCH with an extra field returns 409', async () => {
    const res = await PATCH(req('founder', 'http://localhost/api/store/waitlist/W1', { status: 'closed', contactPhone: 'x' }), {
      params: Promise.resolve({ id: 'W1' }),
    });
    expect(res.status).toBe(409);
  });

  it('GET and PATCH reject the vendor token with 403 (P2)', async () => {
    expect((await GET(req('vendor-a'))).status).toBe(403);
    const res = await PATCH(req('vendor-a', 'http://localhost/api/store/waitlist/W1', { status: 'closed' }), {
      params: Promise.resolve({ id: 'W1' }),
    });
    expect(res.status).toBe(403);
  });

  it('GET rejects an unauthenticated request with 401', async () => {
    expect((await GET(req(null))).status).toBe(401);
  });
});
