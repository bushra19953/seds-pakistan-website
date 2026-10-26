/**
 * @jest-environment node
 *
 * Group 2 seam tests: src/lib/supa/store-orders.ts against a mocked
 * adapter module — zero live Supabase / Firestore.
 *
 * CUTOVER (S-K1/S-K3): the seam fetches orders through the
 * store_orders_page rpc. The fake adapter's rpc implements the SQL
 * function's predicate over in-memory rows USING THE KEYSET MODULE
 * (total order createdAt DESC, id ASC; strict (millis,id) "after") —
 * the same semantics the SQL expresses — while listDocs now serves
 * only the embedded products list. Legacy bare-id cursors translate
 * via getDoc; a ghost legacy cursor is invalid_cursor (the pre-
 * cutover ghost-ignore pin was retired in the same commit as the
 * wiring, per design §1.5).
 */

import {
  compareStoreOrderKeys,
  isAfterStoreOrderKey,
  keyOfStoreOrder,
  type StoreOrderKeysetRow,
} from '@/lib/supa/store-orders-keyset';

const mockState = {
  flagOn: false,
  clientPresent: true,
  adapterFails: false,
  orders: [] as Array<StoreOrderKeysetRow>,
  products: [] as Array<Record<string, any>>,
  listCalls: [] as Array<[string, any]>,
  getDocCalls: [] as Array<[string, string]>,
  rpcCalls: [] as Array<[string, any]>,
};

jest.mock('@/lib/supa', () => ({
  useSupa: jest.fn(() => mockState.flagOn),
  getSupaClient: jest.fn(() => (mockState.clientPresent ? {} : null)),
  getSupaAdapter: jest.fn(() => ({
    getDoc: jest.fn(async (collection: string, id: string) => {
      mockState.getDocCalls.push([collection, id]);
      const rows = collection === 'orders' ? mockState.orders : mockState.products;
      const found = rows.find((r) => r.id === id);
      return found ? { ...found } : null;
    }),
    listDocs: jest.fn(async (collection: string, options?: any) => {
      mockState.listCalls.push([collection, options]);
      if (mockState.adapterFails) throw new Error('adapter boom');
      return [...(collection === 'orders' ? mockState.orders : mockState.products)];
    }),
    rpc: jest.fn(async (fn: string, args: any) => {
      mockState.rpcCalls.push([fn, args]);
      if (mockState.adapterFails) throw new Error('adapter boom');
      if (fn !== 'store_orders_page') throw new Error(`unexpected rpc: ${fn}`);
      // The SQL predicate, expressed with the keyset module.
      let rows = mockState.orders.filter((r) => keyOfStoreOrder(r) !== null);
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

import { getStoreOrdersPageFromSupa } from '@/lib/supa/store-orders';

const seed = () => {
  mockState.orders = [
    { id: 'o3', status: 'pending_verification', total: 30, createdAt: '2026-03-03T00:00:00.000Z', updatedAt: '2026-03-03T01:00:00.000Z' },
    { id: 'o2', status: 'verified', total: 20, createdAt: '2026-03-02T00:00:00.000Z' },
    { id: 'o1', status: 'verified', total: 10, createdAt: '2026-03-01T00:00:00.000Z' },
  ];
  mockState.products = [{ id: 'p1', name: 'Patch', createdAt: '2026-01-01T00:00:00.000Z' }];
};

beforeEach(() => {
  mockState.flagOn = false;
  mockState.clientPresent = true;
  mockState.adapterFails = false;
  mockState.orders = [];
  mockState.products = [];
  mockState.listCalls = [];
  mockState.getDocCalls = [];
  mockState.rpcCalls = [];
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('getStoreOrdersPageFromSupa', () => {
  it('flag OFF -> null, adapter never called', async () => {
    await expect(getStoreOrdersPageFromSupa({ limit: 20, cursor: null, statusFilter: null })).resolves.toBeNull();
    expect(mockState.rpcCalls).toHaveLength(0);
    expect(mockState.listCalls).toHaveLength(0);
  });

  it('flag ON + unconfigured -> null; flag ON + adapter error -> null', async () => {
    mockState.flagOn = true; mockState.clientPresent = false;
    await expect(getStoreOrdersPageFromSupa({ limit: 20, cursor: null, statusFilter: null })).resolves.toBeNull();
    mockState.clientPresent = true; mockState.adapterFails = true;
    await expect(getStoreOrdersPageFromSupa({ limit: 20, cursor: null, statusFilter: null })).resolves.toBeNull();
  });

  it('fetches limit+1 via the keyset rpc, returns raw page + shaped products', async () => {
    mockState.flagOn = true; seed();
    const page = await getStoreOrdersPageFromSupa({ limit: 2, cursor: null, statusFilter: null }) as any;
    expect(mockState.rpcCalls[0]).toEqual(['store_orders_page', {
      p_status: null, p_cursor_millis: null, p_cursor_id: null, p_limit: 3,
    }]);
    expect(page!.fetched.map((f: any) => f.id)).toEqual(['o3', 'o2', 'o1']);
    expect(page!.fetched[0].raw).toMatchObject({ status: 'pending_verification', total: 30 });
    expect(page!.products).toEqual([{ id: 'p1', name: 'Patch', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: null }]);
  });

  it('status filter becomes p_status; "all" normalizes to null', async () => {
    mockState.flagOn = true; seed();
    const page = await getStoreOrdersPageFromSupa({ limit: 10, cursor: null, statusFilter: 'verified' }) as any;
    expect(mockState.rpcCalls[0][1].p_status).toBe('verified');
    expect(page!.fetched.map((f: any) => f.id)).toEqual(['o2', 'o1']);
    mockState.rpcCalls = [];
    await getStoreOrdersPageFromSupa({ limit: 10, cursor: null, statusFilter: 'all' });
    expect(mockState.rpcCalls[0][1].p_status).toBeNull();
  });

  it('legacy cursor: resolves the doc and bounds by its (createdAt,id) KEY', async () => {
    mockState.flagOn = true; seed();
    const page = await getStoreOrdersPageFromSupa({ limit: 10, cursor: 'o3', statusFilter: null }) as any;
    expect(mockState.getDocCalls).toEqual([['orders', 'o3']]);
    expect(mockState.rpcCalls[0][1]).toMatchObject({
      p_cursor_millis: Date.parse('2026-03-03T00:00:00.000Z'),
      p_cursor_id: 'o3',
    });
    expect(page!.fetched.map((f: any) => f.id)).toEqual(['o2', 'o1']);
  });

  it('legacy cursor on a timestamp tie returns the unserved sibling (the retired value-bound bug)', async () => {
    mockState.flagOn = true;
    mockState.orders = [
      { id: 'a1', status: 'verified', createdAt: '2026-03-03T00:00:00.000Z' },
      { id: 'a2', status: 'verified', createdAt: '2026-03-03T00:00:00.000Z' },
      { id: 'a3', status: 'verified', createdAt: '2026-03-03T00:00:00.000Z' },
    ];
    const page = await getStoreOrdersPageFromSupa({ limit: 10, cursor: 'a2', statusFilter: null }) as any;
    expect(page!.fetched.map((f: any) => f.id)).toEqual(['a3']);
  });

  it('ghost legacy cursor -> invalidCursor not-found (RETIRED: pre-cutover seam silently ignored it and re-served page 1)', async () => {
    mockState.flagOn = true; seed();
    const page = await getStoreOrdersPageFromSupa({ limit: 10, cursor: 'ghost', statusFilter: null });
    expect(page).toEqual({ invalidCursor: true, code: 'not-found' });
    expect(mockState.rpcCalls).toHaveLength(0);
  });

  it('legacy cursor resolving to a row with no usable createdAt -> invalidCursor not-found', async () => {
    mockState.flagOn = true;
    mockState.orders = [{ id: 'noTs', status: 'verified' }];
    const page = await getStoreOrdersPageFromSupa({ limit: 10, cursor: 'noTs', statusFilter: null });
    expect(page).toEqual({ invalidCursor: true, code: 'not-found' });
  });
});
