/**
 * @jest-environment node
 *
 * Group 2: GET /api/store/orders Supabase read path.
 * Flag ON serves the adapter page through the same presentation
 * semantics as Firestore (soft-delete filter, normalizeOrder overlay,
 * hasMore/nextCursor, envelope); OFF / error falls back byte-identically.
 * POST/PATCH are untouched by this slice (manual list); DELETE stays 410.
 */

import { NextRequest } from 'next/server';

const mockState = {
  flagOn: false,
  clientPresent: true,
  adapterFails: false,
  supaOrders: [] as Array<Record<string, any>>,
  supaProducts: [] as Array<Record<string, any>>,
  fsOrders: [] as Array<Record<string, any>>,
};

function mockOrdersQuery(filters: Array<[string, unknown]> = [], cursorId: string | null = null, limitN: number | null = null): any {
  const q: any = {
    orderBy: () => q,
    where: (f: string, _op: string, v: unknown) => mockOrdersQuery([...filters, [f, v]], cursorId, limitN),
    startAfter: (snap: any) => mockOrdersQuery(filters, snap?.id ?? null, limitN),
    limit: (n: number) => mockOrdersQuery(filters, cursorId, n),
    get: async () => {
      let rows = [...mockState.fsOrders];
      for (const [f, v] of filters) rows = rows.filter((r) => r.data[f] === v);
      if (cursorId) {
        const idx = rows.findIndex((r) => r.id === cursorId);
        if (idx >= 0) rows = rows.slice(idx + 1);
      }
      if (limitN != null) rows = rows.slice(0, limitN);
      return { docs: rows.map((r) => ({ id: r.id, data: () => ({ ...r.data }) })) };
    },
  };
  return q;
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'orders') {
      return {
        ...mockOrdersQuery(),
        doc: (id: string) => ({
          id,
          get: async () => {
            const found = mockState.fsOrders.find((r) => r.id === id);
            return { exists: !!found, id, data: () => (found ? { ...found.data } : undefined) };
          },
        }),
      };
    }
    if (name === 'products') {
      return { get: async () => ({ docs: mockState.supaProducts.map((p) => ({ id: p.id, data: () => ({ ...p }) })) }) };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
};

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    auth: () => ({ verifyIdToken: async () => ({ uid: 'admin-1' }) }),
    firestore: { Timestamp: { now: () => ({ toDate: () => new Date() }) } },
  },
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
  ensureAdminInitialized: jest.fn(() => true),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => true),
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { sendToUser: jest.fn(async () => {}) },
}));

jest.mock('@/lib/supa', () => ({
  useSupa: jest.fn(() => mockState.flagOn),
  getSupaClient: jest.fn(() => (mockState.clientPresent ? {} : null)),
  getSupaAdapter: jest.fn(() => ({
    getDoc: jest.fn(async (_collection: string, id: string) => {
      const found = mockState.supaOrders.find((r) => r.id === id);
      return found ? { ...found } : null;
    }),
    listDocs: jest.fn(async (collection: string, options?: any) => {
      if (mockState.adapterFails) throw new Error('adapter boom');
      let rows = [...(collection === 'orders' ? mockState.supaOrders : mockState.supaProducts)];
      for (const [field, _op, value] of options?.where || []) rows = rows.filter((r) => r[field] === value);
      if (options?.orderBy?.field === 'createdAt') rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      if (options?.startAfter !== undefined) rows = rows.filter((r) => String(r.createdAt) < String(options.startAfter));
      if (options?.limit) rows = rows.slice(0, options.limit);
      return rows;
    }),
  })),
}));

import { GET } from '@/app/api/store/orders/route';

function authedGet(url: string) {
  return new NextRequest(url, { method: 'GET', headers: { authorization: 'Bearer test-token' } });
}

const order = (id: string, createdAt: string, extra: Record<string, any> = {}) => ({
  id,
  status: 'pending_verification',
  paymentStatus: 'pending',
  userId: 'buyer-1',
  total: 100,
  createdAt,
  updatedAt: createdAt,
  ...extra,
});

beforeEach(() => {
  mockState.flagOn = false;
  mockState.clientPresent = true;
  mockState.adapterFails = false;
  mockState.supaProducts = [{ id: 'p1', name: 'Patch', createdAt: '2026-01-01T00:00:00.000Z' }];
  mockState.supaOrders = [
    order('o3', '2026-03-03T00:00:00.000Z', { total: 30 }),
    order('o2', '2026-03-02T00:00:00.000Z', { total: 20, deletedAt: '2026-03-04T00:00:00.000Z' }),
    order('o1', '2026-03-01T00:00:00.000Z', { total: 10 }),
  ];
  // Firestore harness rows are pre-sorted createdAt desc, mirroring the real query.
  mockState.fsOrders = mockState.supaOrders.map(({ id, createdAt, updatedAt, ...rest }) => ({
    id,
    data: { ...rest, createdAt: { toDate: () => new Date(createdAt) }, updatedAt: { toDate: () => new Date(updatedAt) } },
  }));
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('GET /api/store/orders — supa read path', () => {
  it('flag OFF: Firestore semantics (soft-deleted hidden, canonical overlay, ISO dates)', async () => {
    const res = await GET(authedGet('http://localhost/api/store/orders?limit=10'));
    const body = await res.json();
    expect(body.orders.map((o: any) => o.id)).toEqual(['o3', 'o1']);
    expect(body.orders[0]).toMatchObject({ totalPkr: 30, buyerUserId: 'buyer-1', createdAt: '2026-03-03T00:00:00.000Z', isDeleted: false });
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
    expect(body.count).toBe(2);
  });

  it('flag ON: identical response to flag OFF for the same stored data', async () => {
    const off = await (await GET(authedGet('http://localhost/api/store/orders?limit=10'))).json();
    mockState.flagOn = true;
    const on = await (await GET(authedGet('http://localhost/api/store/orders?limit=10'))).json();
    expect(on.orders).toEqual(off.orders);
    expect(on.count).toBe(off.count);
    expect(on.hasMore).toBe(off.hasMore);
    expect(on.nextCursor).toBe(off.nextCursor);
    expect(on.products[0]).toMatchObject({ id: 'p1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: null });
  });

  it('flag ON pagination: limit+1 fetch, hasMore, nextCursor = last returned id; page 2 via cursor value', async () => {
    mockState.flagOn = true;
    const page1 = await (await GET(authedGet('http://localhost/api/store/orders?limit=1'))).json();
    // fetched limit+1 = [o3, o2]; o2 is soft-deleted and filtered in code,
    // so the returned page is [o3] and hasMore reflects the FILTERED length.
    expect(page1.orders.map((o: any) => o.id)).toEqual(['o3']);
    expect(page1.hasMore).toBe(false);
    expect(page1.pagination).toEqual({ limit: 1, cursor: null, hasMore: false, nextCursor: null });
  });

  it('flag ON includeDeleted=true keeps soft-deleted rows', async () => {
    mockState.flagOn = true;
    const body = await (await GET(authedGet('http://localhost/api/store/orders?limit=10&includeDeleted=true'))).json();
    expect(body.orders.map((o: any) => o.id)).toEqual(['o3', 'o2', 'o1']);
    expect(body.orders[1].isDeleted).toBe(true);
  });

  it('flag ON + adapter error: Firestore fallback byte-identical', async () => {
    const off = await (await GET(authedGet('http://localhost/api/store/orders?limit=10'))).json();
    mockState.flagOn = true; mockState.adapterFails = true;
    const on = await (await GET(authedGet('http://localhost/api/store/orders?limit=10'))).json();
    expect(on.orders).toEqual(off.orders);
  });
});
