/**
 * @jest-environment node
 *
 * Group 1 seam tests: src/lib/supa/store-products.ts against a mocked
 * adapter module — zero live Supabase / Firestore.
 */

const mockState = {
  flagOn: false,
  clientPresent: true,
  adapterFails: false,
  rows: [] as Array<Record<string, any>>,
  listCalls: [] as Array<any>,
};

jest.mock('@/lib/supa', () => ({
  useSupa: jest.fn(() => mockState.flagOn),
  getSupaClient: jest.fn(() => (mockState.clientPresent ? {} : null)),
  getSupaAdapter: jest.fn(() => ({
    listDocs: jest.fn(async (collection: string, options?: any) => {
      mockState.listCalls.push([collection, options]);
      if (mockState.adapterFails) throw new Error('adapter boom');
      return mockState.rows;
    }),
  })),
}));

import { isoOrNull, shapeProductRow, listStoreProductsFromSupa } from '@/lib/supa/store-products';

beforeEach(() => {
  mockState.flagOn = false;
  mockState.clientPresent = true;
  mockState.adapterFails = false;
  mockState.rows = [];
  mockState.listCalls = [];
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('isoOrNull', () => {
  it('passes ISO strings through untouched', () => {
    expect(isoOrNull('2026-01-02T03:04:05.000Z')).toBe('2026-01-02T03:04:05.000Z');
  });
  it('converts Timestamp-like values', () => {
    expect(isoOrNull({ toDate: () => new Date('2026-01-02T03:04:05.000Z') })).toBe('2026-01-02T03:04:05.000Z');
  });
  it('converts dumped {_seconds,_nanoseconds} objects', () => {
    expect(isoOrNull({ _seconds: 1767222245, _nanoseconds: 0 })).toBe(new Date(1767222245000).toISOString());
  });
  it('null / missing / unconvertible -> null', () => {
    expect(isoOrNull(null)).toBeNull();
    expect(isoOrNull(undefined)).toBeNull();
    expect(isoOrNull(42)).toBeNull();
    expect(isoOrNull({})).toBeNull();
  });
});

describe('shapeProductRow', () => {
  it('keeps stored fields verbatim (no category/field normalization — EV-P07)', () => {
    const row = shapeProductRow({ id: 'p1', name: 'Ticket', category: 'event_ticket', eventId: 'ev1', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(row).toEqual({ id: 'p1', name: 'Ticket', category: 'event_ticket', eventId: 'ev1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: null });
  });
});

describe('listStoreProductsFromSupa', () => {
  it('flag OFF -> null, adapter never called', async () => {
    await expect(listStoreProductsFromSupa()).resolves.toBeNull();
    expect(mockState.listCalls).toHaveLength(0);
  });
  it('flag ON but client unconfigured -> null', async () => {
    mockState.flagOn = true; mockState.clientPresent = false;
    await expect(listStoreProductsFromSupa()).resolves.toBeNull();
    expect(mockState.listCalls).toHaveLength(0);
  });
  it('flag ON + adapter error -> null (Firestore fallback)', async () => {
    mockState.flagOn = true; mockState.adapterFails = true;
    await expect(listStoreProductsFromSupa()).resolves.toBeNull();
  });
  it('flag ON -> shaped rows from fs_products', async () => {
    mockState.flagOn = true;
    mockState.rows = [
      { id: 'p1', name: 'Patch', price: 100, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: { toDate: () => new Date('2026-01-03T00:00:00.000Z') } },
      { id: 'p2', name: 'NoDates' },
    ];
    const rows = await listStoreProductsFromSupa();
    expect(mockState.listCalls).toEqual([['products', undefined]]);
    expect(rows).toEqual([
      { id: 'p1', name: 'Patch', price: 100, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z' },
      { id: 'p2', name: 'NoDates', createdAt: null, updatedAt: null },
    ]);
  });
});
