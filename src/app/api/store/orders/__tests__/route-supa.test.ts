/**
 * @jest-environment node
 *
 * Group 2: GET /api/store/orders Supabase read path.
 * Flag ON serves the adapter page through the same presentation
 * semantics as Firestore (soft-delete filter, normalizeOrder overlay,
 * hasMore/nextCursor, envelope); OFF / error falls back byte-identically.
 * POST/PATCH are untouched by this slice (manual list); DELETE stays 410.
 *
 * CUTOVER (S-K3/S-K4): the Supa path now paginates by (createdAt,id)
 * KEYSET — the fake adapter's rpc('store_orders_page') implements the
 * SQL predicate with the keyset module; nextCursor on the Supa path is
 * an opaque v1 cursor (the Firestore path still returns bare ids);
 * invalid cursors answer 400 invalid_cursor, including end-to-end
 * same-timestamp-heavy walks at page sizes 1/2/5.
 */

import { NextRequest } from 'next/server';
import {
  compareStoreOrderKeys,
  isAfterStoreOrderKey,
  keyOfStoreOrder,
  type StoreOrderKeysetRow,
} from '@/lib/supa/store-orders-keyset';

type SupaOrderRow = StoreOrderKeysetRow & { createdAt: string; updatedAt: string };

const mockState = {
  flagOn: false,
  clientPresent: true,
  adapterFails: false,
  supaOrders: [] as Array<SupaOrderRow>,
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
    rpc: jest.fn(async (fn: string, args: any) => {
      if (mockState.adapterFails) throw new Error('adapter boom');
      if (fn !== 'store_orders_page') throw new Error(`unexpected rpc: ${fn}`);
      // The store_orders_page SQL predicate, via the keyset module.
      let rows = mockState.supaOrders.filter((r) => keyOfStoreOrder(r) !== null);
      if (args.p_status) rows = rows.filter((r) => r.status === args.p_status);
      if (args.p_cursor_millis != null) {
        const cursorKey = { createdAtMillis: args.p_cursor_millis, id: args.p_cursor_id };
        rows = rows.filter((r) => isAfterStoreOrderKey(keyOfStoreOrder(r)!, cursorKey));
      }
      rows.sort((a, b) => compareStoreOrderKeys(keyOfStoreOrder(a)!, keyOfStoreOrder(b)!));
      return rows.slice(0, args.p_limit).map((r) => {
        const { id, ...data } = r;
        return { id, data };
      });
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
    order('o2', '2026-03-02T00:00:00.000Z', { total: 20, deletedAt: '2026-03-04T00:00:00.000Z', isDeleted: true }),
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

  it('flag ON pagination: limit+1 fetch; soft-delete post-filter can close the window (hasMore=false quirk, unchanged)', async () => {
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


describe('GET /api/store/orders — keyset cutover (S-K3/S-K4)', () => {
  const seedTies = () => {
    // Same-timestamp-heavy fixture: 3 timestamps x 4 orders.
    mockState.supaOrders = [];
    for (let g = 0; g < 3; g++) {
      for (let i = 0; i < 4; i++) {
        mockState.supaOrders.push(
          order(`t${g}-${i}`, `2026-03-0${3 - g}T00:00:00.000Z`, { total: g * 10 + i }),
        );
      }
    }
  };
  const expectedTieOrder = () => {
    // createdAt DESC (Mar3 group first), id ASC inside each tie group.
    const ids: string[] = [];
    for (let g = 0; g < 3; g++) for (let i = 0; i < 4; i++) ids.push(`t${g}-${i}`);
    return ids;
  };

  for (const pageSize of [1, 2, 5]) {
    it(`S-K4: same-timestamp-heavy walk @ pageSize ${pageSize} yields the exact ordered union, cursors are opaque v1`, async () => {
      mockState.flagOn = true;
      seedTies();
      const ids: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 100; guard++) {
        const url = `http://localhost/api/store/orders?limit=${pageSize}&includeDeleted=true`
          + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const res = await GET(authedGet(url));
        expect(res.status).toBe(200);
        const body = await res.json();
        ids.push(...body.orders.map((o: any) => o.id));
        if (!body.hasMore) {
          expect(body.nextCursor).toBeNull();
          break;
        }
        expect(body.nextCursor).toMatch(/^v1\./);
        expect(body.pagination.cursor).toBe(cursor);
        cursor = body.nextCursor;
      }
      expect(ids).toEqual(expectedTieOrder());
      expect(new Set(ids).size).toBe(ids.length);
    });
  }

  it('legacy bare-id cursor translates and returns the unserved tie sibling', async () => {
    mockState.flagOn = true;
    seedTies();
    const body = await (await GET(authedGet(
      'http://localhost/api/store/orders?limit=10&includeDeleted=true&cursor=t0-1',
    ))).json();
    expect(body.orders.map((o: any) => o.id)).toEqual([
      't0-2', 't0-3', 't1-0', 't1-1', 't1-2', 't1-3', 't2-0', 't2-1', 't2-2', 't2-3',
    ]);
    expect(body.pagination.cursor).toBe('t0-1'); // request cursor echoed verbatim
  });

  it('ghost legacy cursor -> 400 invalid_cursor (never a silent page-1 restart)', async () => {
    mockState.flagOn = true;
    seedTies();
    const res = await GET(authedGet('http://localhost/api/store/orders?limit=2&cursor=ghost'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_cursor', code: 'not-found' });
  });

  it('filter-mismatch cursor -> 400 invalid_cursor', async () => {
    mockState.flagOn = true;
    seedTies();
    const page1 = await (await GET(authedGet(
      'http://localhost/api/store/orders?limit=2&includeDeleted=true',
    ))).json();
    expect(page1.nextCursor).toMatch(/^v1\./);
    const res = await GET(authedGet(
      `http://localhost/api/store/orders?limit=2&status=verified&cursor=${encodeURIComponent(page1.nextCursor)}`,
    ));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_cursor', code: 'filter-mismatch' });
  });
});
