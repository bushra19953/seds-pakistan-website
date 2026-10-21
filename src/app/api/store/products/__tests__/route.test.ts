/**
 * @jest-environment node
 *
 * Tests for /api/store/products (Item 7, spec section (f) suite 2):
 * create / update / delete each write exactly one money-audit entry
 * with before/after snapshots; unauthorized calls write nothing.
 */

import { NextRequest } from 'next/server';

const state = {
  decoded: { uid: 'admin-1', role: 'store_admin' } as any,
  permissionGranted: true,
  products: new Map<string, Record<string, any>>(),
  auditEntries: [] as Array<any>,
};

let auditSeq = 0;
let productSeq = 0;

function makeProductRef(id: string) {
  return {
    id,
    path: `products/${id}`,
    get: async () => {
      const data = state.products.get(id);
      return { exists: !!data, id, data: () => (data ? { ...data } : undefined) };
    },
  };
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'products') {
      return {
        doc: (id: string) => makeProductRef(id),
        add: async (data: any) => {
          const id = `prod-${++productSeq}`;
          state.products.set(id, data);
          return { id };
        },
        get: async () => ({
          docs: [...state.products.entries()].map(([id, data]) => ({
            id,
            data: () => ({ ...data }),
          })),
        }),
      };
    }
    if (name === 'audit_logs') {
      return {
        doc: () => {
          const id = `audit-${++auditSeq}`;
          return { id, path: `audit_logs/${id}` };
        },
        add: async (data: any) => {
          state.auditEntries.push(data);
          return { id: 'audit-add' };
        },
      };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
  batch: () => {
    const ops: Array<{ kind: string; ref: any; data?: any }> = [];
    return {
      update: (ref: any, data: any) => ops.push({ kind: 'update', ref, data }),
      set: (ref: any, data: any) => ops.push({ kind: 'set', ref, data }),
      delete: (ref: any) => ops.push({ kind: 'delete', ref }),
      commit: async () => {
        for (const o of ops) {
          if (o.ref.path?.startsWith('audit_logs/')) {
            state.auditEntries.push(o.data);
          } else if (o.ref.path?.startsWith('products/')) {
            if (o.kind === 'delete') state.products.delete(o.ref.id);
            else if (o.kind === 'update') {
              const cur = state.products.get(o.ref.id) || {};
              state.products.set(o.ref.id, { ...cur, ...o.data });
            }
          }
        }
      },
    };
  },
};

const adminStub = {
  auth: () => ({
    verifyIdToken: async (_token: string) => state.decoded,
  }),
  firestore: {
    Timestamp: {
      now: () => ({ toMillis: () => Date.now(), toDate: () => new Date() }),
    },
    FieldValue: {
      serverTimestamp: () => ({ _serverTimestamp: true }),
      arrayUnion: (v: unknown) => ({ _arrayUnion: v }),
    },
  },
};

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: adminStub,
  ...adminStub,
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
  ensureAdminInitialized: jest.fn(() => true),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async () => state.permissionGranted),
}));

import { POST, PATCH, DELETE } from '@/app/api/store/products/route';

function authedRequest(method: string, url: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  state.decoded = { uid: 'admin-1', role: 'store_admin' };
  state.permissionGranted = true;
  state.products = new Map();
  state.auditEntries = [];
  jest.clearAllMocks();
});

describe('/api/store/products money audit (Item 7)', () => {
  it('POST: product_created entry with before null and after.price', async () => {
    const res = await POST(
      authedRequest('POST', 'http://localhost/api/store/products', {
        name: 'Mission Patch',
        price: 2500,
        category: 'merch',
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.productId).toBeTruthy();

    expect(state.auditEntries).toHaveLength(1);
    const entry = state.auditEntries[0];
    expect(entry.action).toBe('product_created');
    expect(entry.targetType).toBe('product');
    expect(entry.targetUidOrResource).toBe(body.productId);
    expect(entry.payload.before).toBeNull();
    expect(entry.payload.after.price).toBe(2500);
    expect(entry.payload.after.name).toBe('Mission Patch');
  });

  it('PATCH price/isActive: product_updated with before/after prices', async () => {
    state.products.set('prod-x', { name: 'Patch', price: 100, isActive: true });

    const res = await PATCH(
      authedRequest('PATCH', 'http://localhost/api/store/products', {
        productId: 'prod-x',
        updates: { price: 150, isActive: false },
      })
    );
    expect(res.status).toBe(200);
    expect(state.products.get('prod-x')!.price).toBe(150);
    expect(state.products.get('prod-x')!.isActive).toBe(false);

    expect(state.auditEntries).toHaveLength(1);
    const entry = state.auditEntries[0];
    expect(entry.action).toBe('product_updated');
    expect(entry.payload.before.price).toBe(100);
    expect(entry.payload.after.price).toBe(150);
    expect(entry.payload.after.isActive).toBe(false);
    expect(entry.payload.changedFields).toEqual(
      expect.arrayContaining(['price', 'isActive'])
    );
  });

  it('DELETE: product_deleted with the full before snapshot, product gone', async () => {
    state.products.set('prod-x', { name: 'Patch', price: 100, isActive: true, stock: 9 });

    const res = await DELETE(
      authedRequest('DELETE', 'http://localhost/api/store/products?productId=prod-x')
    );
    expect(res.status).toBe(200);
    expect(state.products.has('prod-x')).toBe(false);

    expect(state.auditEntries).toHaveLength(1);
    const entry = state.auditEntries[0];
    expect(entry.action).toBe('product_deleted');
    expect(entry.payload.before).toEqual({
      name: 'Patch',
      price: 100,
      isActive: true,
      stock: 9,
    });
    expect(entry.payload.after).toBeNull();
  });

  it('no canManageStore: POST/PATCH/DELETE all 403 with zero audit entries', async () => {
    state.permissionGranted = false;
    state.products.set('prod-x', { name: 'Patch', price: 100 });

    const post = await POST(
      authedRequest('POST', 'http://localhost/api/store/products', { name: 'X', price: 1 })
    );
    expect(post.status).toBe(403);

    const patch = await PATCH(
      authedRequest('PATCH', 'http://localhost/api/store/products', {
        productId: 'prod-x',
        updates: { price: 2 },
      })
    );
    expect(patch.status).toBe(403);

    const del = await DELETE(
      authedRequest('DELETE', 'http://localhost/api/store/products?productId=prod-x')
    );
    expect(del.status).toBe(403);

    expect(state.auditEntries).toHaveLength(0);
    expect(state.products.get('prod-x')!.price).toBe(100);
  });
});
