/**
 * @jest-environment node
 *
 * Group 2 seam tests: src/lib/supa/store-orders.ts against a mocked
 * adapter module — zero live Supabase / Firestore. The fake adapter
 * honors orderBy/where/startAfter(value)/limit over in-memory rows so
 * the seam's cursor translation is exercised end to end.
 */

const mockState = {
  flagOn: false,
  clientPresent: true,
  adapterFails: false,
  orders: [] as Array<Record<string, any>>,
  products: [] as Array<Record<string, any>>,
  listCalls: [] as Array<[string, any]>,
  getDocCalls: [] as Array<[string, string]>,
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
      let rows = [...(collection === 'orders' ? mockState.orders : mockState.products)];
      for (const [field, _op, value] of options?.where || []) {
        rows = rows.filter((r) => r[field] === value);
      }
      if (options?.orderBy?.field === 'createdAt') {
        rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      }
      if (options?.startAfter !== undefined) {
        // Adapter semantics: value bound on the order field (desc => keep rows below the bound).
        rows = rows.filter((r) => String(r.createdAt) < String(options.startAfter));
      }
      if (options?.limit) rows = rows.slice(0, options.limit);
      return rows;
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
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('getStoreOrdersPageFromSupa', () => {
  it('flag OFF -> null, adapter never called', async () => {
    await expect(getStoreOrdersPageFromSupa({ limit: 20, cursor: null, statusFilter: null })).resolves.toBeNull();
    expect(mockState.listCalls).toHaveLength(0);
  });

  it('flag ON + unconfigured -> null; flag ON + adapter error -> null', async () => {
    mockState.flagOn = true; mockState.clientPresent = false;
    await expect(getStoreOrdersPageFromSupa({ limit: 20, cursor: null, statusFilter: null })).resolves.toBeNull();
    mockState.clientPresent = true; mockState.adapterFails = true;
    await expect(getStoreOrdersPageFromSupa({ limit: 20, cursor: null, statusFilter: null })).resolves.toBeNull();
  });

  it('fetches limit+1 desc, returns raw page + shaped products', async () => {
    mockState.flagOn = true; seed();
    const page = await getStoreOrdersPageFromSupa({ limit: 2, cursor: null, statusFilter: null });
    expect(mockState.listCalls[0][1]).toMatchObject({ orderBy: { field: 'createdAt', direction: 'desc' }, limit: 3 });
    expect(page!.fetched.map((f) => f.id)).toEqual(['o3', 'o2', 'o1']);
    expect(page!.fetched[0].raw).toMatchObject({ status: 'pending_verification', total: 30 });
    expect(page!.products).toEqual([{ id: 'p1', name: 'Patch', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: null }]);
  });

  it('status filter becomes an equality where clause; "all" adds none', async () => {
    mockState.flagOn = true; seed();
    const page = await getStoreOrdersPageFromSupa({ limit: 10, cursor: null, statusFilter: 'verified' });
    expect(mockState.listCalls[0][1].where).toEqual([['status', '==', 'verified']]);
    expect(page!.fetched.map((f) => f.id)).toEqual(['o2', 'o1']);
    mockState.listCalls = [];
    await getStoreOrdersPageFromSupa({ limit: 10, cursor: null, statusFilter: 'all' });
    expect(mockState.listCalls[0][1].where).toBeUndefined();
  });

  it('cursor: resolves the doc and bounds by its createdAt VALUE', async () => {
    mockState.flagOn = true; seed();
    const page = await getStoreOrdersPageFromSupa({ limit: 10, cursor: 'o3', statusFilter: null });
    expect(mockState.getDocCalls).toEqual([['orders', 'o3']]);
    expect(mockState.listCalls[0][1].startAfter).toBe('2026-03-03T00:00:00.000Z');
    expect(page!.fetched.map((f) => f.id)).toEqual(['o2', 'o1']);
  });

  it('cursor not found: no bound applied (current code ignores the cursor)', async () => {
    mockState.flagOn = true; seed();
    const page = await getStoreOrdersPageFromSupa({ limit: 10, cursor: 'ghost', statusFilter: null });
    expect(mockState.listCalls[0][1].startAfter).toBeUndefined();
    expect(page!.fetched).toHaveLength(3);
  });
});
