/**
 * @jest-environment node
 *
 * GD waitlist POST tests (PLAN-gd Section 12, file C21):
 * spec tests W1 and W2, server half. GD owns POST only; the admin
 * GET/PATCH and the Waitlist tab are GG's (ruling R-12).
 */
import { createFakeFirestore, type FakeFirestore } from '@/lib/finance/__tests__/fake-firestore';

const holder: { db: FakeFirestore | null } = { db: null };

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    auth: () => ({
      verifyIdToken: async (token: string) => {
        if (token === 'bad') throw new Error('invalid token');
        return { uid: `uid-${token}` };
      },
    }),
    firestore: {
      FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }) },
    },
  },
}));
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => holder.db,
}));

import { POST } from '../route';

function req(body: unknown, token?: string, jsonThrows = false) {
  return {
    method: 'POST',
    url: 'http://localhost/api/store/waitlist',
    headers: {
      get: (h: string) => (h.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : null),
    },
    json: async () => {
      if (jsonThrows) throw new Error('not json');
      return body ?? {};
    },
  } as never;
}

function storedEntries(db: FakeFirestore): any[] {
  const map = (db as any).__store.get('store_waitlist') as Map<string, any> | undefined;
  return map ? [...map.values()] : [];
}

const baseBody = {
  contactName: 'Test Buyer',
  contactPhone: '+92 300 1234567',
  source: 'product_page_oos',
  productId: 'p1',
};

describe('POST /api/store/waitlist (GD)', () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = createFakeFirestore() as never;
    holder.db = db;
    db.__seed('products', 'p1', { name: 'Servo Motor', isActive: true });
  });

  it('W1: creates an open entry from a product page with the product name as requestedText', async () => {
    const res = await POST(req(baseBody));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.id).toBe('string');
    const entries = storedEntries(db);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      productId: 'p1',
      requestedText: 'Servo Motor',
      contactName: 'Test Buyer',
      contactPhone: '+92 300 1234567',
      contactEmail: null,
      searchQuery: null,
      source: 'product_page_oos',
      status: 'open',
      userId: null,
    });
  });

  it('W2: stores searchQuery and requestedText from a store_search_empty submission', async () => {
    const res = await POST(
      req({
        contactName: 'Test Buyer',
        contactPhone: '03001234567',
        source: 'store_search_empty',
        requestedText: 'flux capacitor',
        searchQuery: 'flux',
      }),
    );
    expect(res.status).toBe(201);
    const entries = storedEntries(db);
    expect(entries[0]).toMatchObject({
      productId: null,
      requestedText: 'flux capacitor',
      searchQuery: 'flux',
      source: 'store_search_empty',
    });
  });

  it('rejects a missing contactName with 400', async () => {
    const res = await POST(req({ ...baseBody, contactName: '  ' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('contactName');
    expect(storedEntries(db)).toHaveLength(0);
  });

  it('rejects a missing contactPhone with 400', async () => {
    const res = await POST(req({ ...baseBody, contactPhone: '' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('contactPhone');
  });

  it('rejects a body with neither productId nor requestedText with 400', async () => {
    const res = await POST(
      req({ contactName: 'Test Buyer', contactPhone: '03001234567', source: 'store_search_empty' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('productId or requestedText');
  });

  it('rejects an invalid source with 400', async () => {
    const res = await POST(req({ ...baseBody, source: 'carrier_pigeon' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('source');
  });

  it('rejects an unknown productId with 400', async () => {
    const res = await POST(req({ ...baseBody, productId: 'nope' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Product not found');
  });

  it('records the userId from a verified token and ignores a userId sent in the body', async () => {
    const res = await POST(req({ ...baseBody, userId: 'spoofed-uid' }, 'buyer1'));
    expect(res.status).toBe(201);
    expect(storedEntries(db)[0].userId).toBe('uid-buyer1');
  });

  it('a signed out submission succeeds with userId null', async () => {
    const res = await POST(req(baseBody));
    expect(res.status).toBe(201);
    expect(storedEntries(db)[0].userId).toBeNull();
  });

  it('a present but invalid token returns 401', async () => {
    const res = await POST(req(baseBody, 'bad'));
    expect(res.status).toBe(401);
    expect(storedEntries(db)).toHaveLength(0);
  });

  it('rejects an unparseable body with 400 Invalid JSON', async () => {
    const res = await POST(req(null, undefined, true));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid JSON');
  });
});
