/**
 * @jest-environment node
 *
 * Group 1: GET /api/store/products Supabase read path.
 * Flag ON serves fs_products via the seam; OFF / unconfigured / adapter
 * error serves the Firestore path byte-identically. POST/PATCH/DELETE
 * are untouched by this slice (manual list) and not exercised here.
 */

import { NextRequest } from 'next/server';

const mockState = {
  flagOn: false,
  clientPresent: true,
  adapterFails: false,
  supaRows: [] as Array<Record<string, any>>,
  fsProducts: new Map<string, Record<string, any>>(),
};

const mockDb = {
  collection: (name: string) => {
    if (name !== 'products') throw new Error(`unexpected collection: ${name}`);
    return {
      get: async () => ({
        docs: [...mockState.fsProducts.entries()].map(([id, data]) => ({ id, data: () => ({ ...data }) })),
      }),
    };
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

jest.mock('@/lib/supa', () => ({
  useSupa: jest.fn(() => mockState.flagOn),
  getSupaClient: jest.fn(() => (mockState.clientPresent ? {} : null)),
  getSupaAdapter: jest.fn(() => ({
    listDocs: jest.fn(async () => {
      if (mockState.adapterFails) throw new Error('adapter boom');
      return mockState.supaRows;
    }),
  })),
}));

import { GET } from '@/app/api/store/products/route';

function authedGet() {
  return new NextRequest('http://localhost/api/store/products', {
    method: 'GET',
    headers: { authorization: 'Bearer test-token' },
  });
}

const fsTs = (iso: string) => ({ toDate: () => new Date(iso) });

beforeEach(() => {
  mockState.flagOn = false;
  mockState.clientPresent = true;
  mockState.adapterFails = false;
  mockState.supaRows = [];
  mockState.fsProducts = new Map([
    ['fs-1', { name: 'Firestore Patch', price: 5, createdAt: fsTs('2026-02-01T00:00:00.000Z'), updatedAt: fsTs('2026-02-02T00:00:00.000Z') }],
  ]);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('GET /api/store/products — supa read path', () => {
  it('flag OFF: Firestore rows, Timestamp objects -> ISO', async () => {
    const res = await GET(authedGet());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      count: 1,
      products: [{ id: 'fs-1', name: 'Firestore Patch', price: 5, createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-02T00:00:00.000Z' }],
    });
  });

  it('flag ON: Supabase rows served, ISO strings pass through, missing -> null', async () => {
    mockState.flagOn = true;
    mockState.supaRows = [
      { id: 'sp-1', name: 'Supa Patch', price: 7, category: 'event_ticket', createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-02T00:00:00.000Z' },
      { id: 'sp-2', name: 'Bare' },
    ];
    const res = await GET(authedGet());
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.products[0]).toEqual({ id: 'sp-1', name: 'Supa Patch', price: 7, category: 'event_ticket', createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-02T00:00:00.000Z' });
    expect(body.products[1]).toEqual({ id: 'sp-2', name: 'Bare', createdAt: null, updatedAt: null });
  });

  it('flag ON + adapter error: falls back to Firestore byte-identically', async () => {
    mockState.flagOn = true; mockState.adapterFails = true;
    const res = await GET(authedGet());
    const body = await res.json();
    expect(body.products).toHaveLength(1);
    expect(body.products[0].id).toBe('fs-1');
  });

  it('flag ON + unconfigured client: falls back to Firestore', async () => {
    mockState.flagOn = true; mockState.clientPresent = false;
    const res = await GET(authedGet());
    const body = await res.json();
    expect(body.products[0].id).toBe('fs-1');
  });
});
