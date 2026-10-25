/**
 * @jest-environment node
 *
 * Group 3: actions/store getProduct + getPublicProducts Supabase reads.
 * Flag ON serves the adapter through the seam with serializeToken /
 * getPublicProducts timestamp parity; OFF / unconfigured / adapter error
 * falls back to Firestore byte-identically. createOrder and
 * syncEventToProduct are manual-list writes and are not exercised here.
 */

const mockState = {
  flagOn: false,
  clientPresent: true,
  adapterFails: false,
  supaProducts: [] as Array<Record<string, any>>,
  fsProducts: new Map<string, Record<string, any>>(),
  listCalls: [] as Array<any>,
};

const mockDb = {
  collection: (name: string) => {
    if (name !== 'products') throw new Error(`unexpected collection: ${name}`);
    return {
      doc: (id: string) => ({
        get: async () => {
          const data = mockState.fsProducts.get(id);
          return { exists: !!data, id, data: () => (data ? { ...data } : undefined) };
        },
      }),
      where: (field: string, _op: string, value: unknown) => ({
        get: async () => ({
          docs: [...mockState.fsProducts.entries()]
            .filter(([, data]) => data[field] === value)
            .map(([id, data]) => ({ id, data: () => ({ ...data }) })),
        }),
      }),
    };
  },
};

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }) },
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(async () => mockDb),
}));

jest.mock('@/lib/supa', () => ({
  useSupa: jest.fn(() => mockState.flagOn),
  getSupaClient: jest.fn(() => (mockState.clientPresent ? {} : null)),
  getSupaAdapter: jest.fn(() => ({
    getDoc: jest.fn(async (_collection: string, id: string) => {
      if (mockState.adapterFails) throw new Error('adapter boom');
      const found = mockState.supaProducts.find((p) => p.id === id);
      return found ? { ...found } : null;
    }),
    listDocs: jest.fn(async (_collection: string, options?: any) => {
      mockState.listCalls.push(options);
      if (mockState.adapterFails) throw new Error('adapter boom');
      let rows = [...mockState.supaProducts];
      for (const [field, _op, value] of options?.where || []) rows = rows.filter((r) => r[field] === value);
      return rows;
    }),
  })),
}));

import { getProduct, getPublicProducts } from '@/app/actions/store';

const fsTs = (iso: string) => ({ toDate: () => new Date(iso) });

beforeEach(() => {
  mockState.flagOn = false;
  mockState.clientPresent = true;
  mockState.adapterFails = false;
  mockState.listCalls = [];
  mockState.supaProducts = [
    { id: 'sp-1', name: 'Supa Ticket', category: 'event_ticket', isActive: true, price: 500, createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-02T00:00:00.000Z' },
    { id: 'sp-2', name: 'Inactive Supa', isActive: false, price: 1 },
  ];
  mockState.fsProducts = new Map([
    ['fs-1', { name: 'Firestore Ticket', category: 'event_ticket', isActive: true, price: 250, createdAt: fsTs('2026-02-01T00:00:00.000Z'), updatedAt: fsTs('2026-02-02T00:00:00.000Z') }],
    ['fs-2', { name: 'Inactive FS', isActive: false, price: 2 }],
  ]);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('getProduct', () => {
  it('flag OFF: Firestore doc, serializeToken converts Timestamps, id after spread', async () => {
    const res = await getProduct('fs-1');
    expect(res).toEqual({
      success: true,
      data: { name: 'Firestore Ticket', category: 'event_ticket', isActive: true, price: 250, createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-02T00:00:00.000Z', id: 'fs-1' },
    });
  });

  it('flag OFF: missing product -> Product not found', async () => {
    await expect(getProduct('nope')).resolves.toEqual({ success: false, error: 'Product not found' });
  });

  it('flag ON: adapter doc served; ISO strings pass through untouched (serializeToken parity)', async () => {
    mockState.flagOn = true;
    const res = await getProduct('sp-1');
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ name: 'Supa Ticket', category: 'event_ticket', isActive: true, price: 500, createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-02T00:00:00.000Z', id: 'sp-1' });
  });

  it('flag ON: adapter says missing -> Product not found (no Firestore read)', async () => {
    mockState.flagOn = true;
    await expect(getProduct('fs-1')).resolves.toEqual({ success: false, error: 'Product not found' });
  });

  it('flag ON + adapter error: Firestore fallback', async () => {
    mockState.flagOn = true; mockState.adapterFails = true;
    const res = await getProduct('fs-1');
    expect(res.success).toBe(true);
    expect(res.data?.name).toBe('Firestore Ticket');
  });
});

describe('getPublicProducts', () => {
  it('flag OFF: only isActive==true Firestore products, raw fallback keeps values', async () => {
    const res = await getPublicProducts();
    expect(res.success).toBe(true);
    expect(res.data).toHaveLength(1);
    expect(res.data![0]).toMatchObject({ id: 'fs-1', createdAt: '2026-02-01T00:00:00.000Z' });
  });

  it('flag ON: adapter listDocs called with isActive equality; only active rows returned', async () => {
    mockState.flagOn = true;
    const res = await getPublicProducts();
    expect(mockState.listCalls).toEqual([{ where: [['isActive', '==', true]] }]);
    expect(res.data).toHaveLength(1);
    expect(res.data![0]).toMatchObject({ id: 'sp-1', createdAt: '2026-03-01T00:00:00.000Z' });
  });

  it('flag ON + unconfigured client: Firestore fallback', async () => {
    mockState.flagOn = true; mockState.clientPresent = false;
    const res = await getPublicProducts();
    expect(res.data).toHaveLength(1);
    expect(res.data![0].id).toBe('fs-1');
  });
});
