/**
 * @jest-environment node
 *
 * DEFECT 4 (a)+(b) regression tests: store product DELETE / PATCH must
 * operate on the same store the admin list reads from.
 *
 * Proven live facts (2026-10-26 retest):
 *  (a) Deleting "EV2 PAID TEST TICKET" toasted "Product deleted" but the
 *      product persisted after reload. Mechanism: GET /api/store/products
 *      serves the Supabase read mirror (flag 'store-products-api') while
 *      DELETE only removed the Firestore doc — the mirror row survived
 *      and the next list read resurrected the product.
 *  (b) Deleting "EV2 PAID TEST TICKET 2" returned "Delete failed" and
 *      its update/deactivate returned "Update failed". Mechanism: that
 *      product exists in the Supabase read mirror but NOT in Firestore,
 *      and both DELETE and PATCH only consult Firestore, so both hit
 *      the "Product not found" 404 — even though the admin list (Supa)
 *      displays the product.
 *
 * Contract pinned here:
 *  - DELETE removes the product from BOTH stores (when the Supa surface
 *    is active) and a later GET no longer lists it.
 *  - DELETE / PATCH succeed for a mirror-only product, with the money
 *    audit entry still written.
 *  - PATCH updates BOTH stores so the list cannot resurrect old values.
 *  - A mirror write failure is a loud non-200 carrying the real error,
 *    never a success response.
 *  - With the surface OFF, behaviour is the old Firestore-only path.
 */

import { NextRequest } from 'next/server';

const state = {
  permissionGranted: true,
  fsProducts: new Map<string, Record<string, any>>(),
  supaProducts: new Map<string, Record<string, any>>(),
  auditEntries: [] as Array<any>,
  supaFlagOn: true,
  supaClientPresent: true,
  supaDeleteFails: false,
  supaUpdateFails: false,
};

let auditSeq = 0;

function makeProductRef(id: string) {
  return {
    id,
    path: `products/${id}`,
    get: async () => {
      const data = state.fsProducts.get(id);
      return { exists: !!data, id, data: () => (data ? { ...data } : undefined) };
    },
  };
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'products') {
      return {
        doc: (id: string) => makeProductRef(id),
        get: async () => ({
          docs: [...state.fsProducts.entries()].map(([id, data]) => ({
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
            if (o.kind === 'delete') state.fsProducts.delete(o.ref.id);
            else if (o.kind === 'update') {
              const cur = state.fsProducts.get(o.ref.id) || {};
              state.fsProducts.set(o.ref.id, { ...cur, ...o.data });
            }
          }
        }
      },
    };
  },
};

const adminStub = {
  auth: () => ({
    verifyIdToken: async (_token: string) => ({ uid: 'admin-1' }),
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
  hasServerPermissionForUser: jest.fn(async () => state.permissionGranted),
}));

// The real seam (src/lib/supa/store-products.ts) resolves its adapter
// through '@/lib/supa'; mocking that module exercises the real seam
// code against an in-memory Supabase mirror.
jest.mock('@/lib/supa', () => ({
  useSupa: jest.fn(() => state.supaFlagOn),
  getSupaClient: jest.fn(() => (state.supaClientPresent ? {} : null)),
  getSupaAdapter: jest.fn(() => ({
    listDocs: jest.fn(async () =>
      [...state.supaProducts.entries()].map(([id, data]) => ({ id, ...data }))
    ),
    getDoc: jest.fn(async (_collection: string, id: string) => {
      const data = state.supaProducts.get(id);
      return data ? { id, ...data } : null;
    }),
    deleteDoc: jest.fn(async (_collection: string, id: string) => {
      if (state.supaDeleteFails) throw new Error('supa delete boom');
      state.supaProducts.delete(id);
    }),
    updateDoc: jest.fn(async (_collection: string, id: string, updates: Record<string, any>) => {
      if (state.supaUpdateFails) throw new Error('supa update boom');
      const cur = state.supaProducts.get(id);
      if (!cur) throw new Error(`updateDoc on missing document products/${id}`);
      const next = { ...cur, ...updates };
      state.supaProducts.set(id, next);
      return { id, ...next };
    }),
  })),
}));

import { GET, PATCH, DELETE } from '@/app/api/store/products/route';

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

const TICKET = {
  name: 'EV2 PAID TEST TICKET',
  price: 500,
  currency: 'PKR',
  category: 'event_ticket',
  isActive: true,
  stock: 999,
};

beforeEach(() => {
  state.permissionGranted = true;
  state.fsProducts = new Map();
  state.supaProducts = new Map();
  state.auditEntries = [];
  state.supaFlagOn = true;
  state.supaClientPresent = true;
  state.supaDeleteFails = false;
  state.supaUpdateFails = false;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('DEFECT 4(a): delete must remove the product the list reads', () => {
  it('DELETE a product present in both stores removes it from both, and GET no longer lists it', async () => {
    state.fsProducts.set('ticket-1', { ...TICKET });
    state.supaProducts.set('ticket-1', { ...TICKET });

    const res = await DELETE(
      authedRequest('DELETE', 'http://localhost/api/store/products?productId=ticket-1')
    );
    expect(res.status).toBe(200);
    expect(state.fsProducts.has('ticket-1')).toBe(false);
    expect(state.supaProducts.has('ticket-1')).toBe(false);

    const listRes = await GET(authedRequest('GET', 'http://localhost/api/store/products'));
    const listBody = await listRes.json();
    expect(listBody.products.map((p: any) => p.id)).not.toContain('ticket-1');
  });

  it('DELETE fails loudly (non-200, real reason, no ok:true) when the mirror delete fails', async () => {
    state.fsProducts.set('ticket-1', { ...TICKET });
    state.supaProducts.set('ticket-1', { ...TICKET });
    state.supaDeleteFails = true;

    const res = await DELETE(
      authedRequest('DELETE', 'http://localhost/api/store/products?productId=ticket-1')
    );
    expect(res.status).not.toBe(200);
    const body = await res.json();
    expect(body.ok).not.toBe(true);
    expect(String(body.error)).toContain('supa delete boom');
  });
});

describe('DEFECT 4(b): mirror-only products must be deletable and updatable', () => {
  it('DELETE a mirror-only product succeeds, removes it, and writes the product_deleted audit entry', async () => {
    state.supaProducts.set('ticket-2', { ...TICKET, name: 'EV2 PAID TEST TICKET 2' });

    const res = await DELETE(
      authedRequest('DELETE', 'http://localhost/api/store/products?productId=ticket-2')
    );
    expect(res.status).toBe(200);
    expect(state.supaProducts.has('ticket-2')).toBe(false);

    expect(state.auditEntries).toHaveLength(1);
    expect(state.auditEntries[0].action).toBe('product_deleted');
    expect(state.auditEntries[0].payload.before.name).toBe('EV2 PAID TEST TICKET 2');
    expect(state.auditEntries[0].payload.after).toBeNull();
  });

  it('PATCH (deactivate) a mirror-only product succeeds and updates the mirror row', async () => {
    state.supaProducts.set('ticket-2', { ...TICKET, name: 'EV2 PAID TEST TICKET 2' });

    const res = await PATCH(
      authedRequest('PATCH', 'http://localhost/api/store/products', {
        productId: 'ticket-2',
        updates: { isActive: false },
      })
    );
    expect(res.status).toBe(200);
    expect(state.supaProducts.get('ticket-2')!.isActive).toBe(false);

    expect(state.auditEntries).toHaveLength(1);
    expect(state.auditEntries[0].action).toBe('product_updated');
    expect(state.auditEntries[0].payload.before.isActive).toBe(true);
    expect(state.auditEntries[0].payload.after.isActive).toBe(false);
  });

  it('PATCH a product present in both stores updates the mirror too (no stale resurrection)', async () => {
    state.fsProducts.set('ticket-1', { ...TICKET });
    state.supaProducts.set('ticket-1', { ...TICKET });

    const res = await PATCH(
      authedRequest('PATCH', 'http://localhost/api/store/products', {
        productId: 'ticket-1',
        updates: { isActive: false },
      })
    );
    expect(res.status).toBe(200);
    expect(state.fsProducts.get('ticket-1')!.isActive).toBe(false);
    expect(state.supaProducts.get('ticket-1')!.isActive).toBe(false);
  });

  it('PATCH fails loudly (non-200, real reason) when the mirror update fails', async () => {
    state.supaProducts.set('ticket-2', { ...TICKET, name: 'EV2 PAID TEST TICKET 2' });
    state.supaUpdateFails = true;

    const res = await PATCH(
      authedRequest('PATCH', 'http://localhost/api/store/products', {
        productId: 'ticket-2',
        updates: { isActive: false },
      })
    );
    expect(res.status).not.toBe(200);
    const body = await res.json();
    expect(body.ok).not.toBe(true);
    expect(String(body.error)).toContain('supa update boom');
  });
});

describe('DEFECT 4 guards: unchanged semantics', () => {
  it('DELETE a product in neither store is still 404', async () => {
    const res = await DELETE(
      authedRequest('DELETE', 'http://localhost/api/store/products?productId=ghost')
    );
    expect(res.status).toBe(404);
  });

  it('PATCH a product in neither store is still 404', async () => {
    const res = await PATCH(
      authedRequest('PATCH', 'http://localhost/api/store/products', {
        productId: 'ghost',
        updates: { isActive: false },
      })
    );
    expect(res.status).toBe(404);
  });

  it('surface OFF: DELETE stays the Firestore-only path and still succeeds', async () => {
    state.supaFlagOn = false;
    state.fsProducts.set('ticket-1', { ...TICKET });
    state.supaProducts.set('ticket-1', { ...TICKET });

    const res = await DELETE(
      authedRequest('DELETE', 'http://localhost/api/store/products?productId=ticket-1')
    );
    expect(res.status).toBe(200);
    expect(state.fsProducts.has('ticket-1')).toBe(false);
  });
});
