/**
 * @jest-environment node
 *
 * S-W1 CONTRACTS: /api/store/products write primacy.
 * ON  (isSupaPrimary('store-products-api')): POST/PATCH/DELETE are ONE
 *     tx_store_product_* call each — product + money-audit atomically;
 *     the P1 delta is pinned (audit failure inside the tx rolls the
 *     product back; the response stays 500); 404s return as values.
 * OFF: the Firestore path runs and the tx is never called.
 * The fake adapter's tx models a real Postgres transaction: writes are
 * staged and only committed when the function body completes.
 */

import { NextRequest } from 'next/server';

const mockState = {
  primary: false,
  txCalls: [] as Array<[string, any, any]>,
  txFails: false,
  auditFailsInsideTx: false,
  supaProducts: new Map<string, Record<string, any>>(),
  supaAudit: [] as Array<Record<string, any>>,
  fsAdds: 0,
  fsBatchCommits: 0,
  fsAuditAdds: 0,
};

function fakeTx(fn: string, args: any) {
  mockState.txCalls.push([fn, args, undefined]);
  if (mockState.txFails) throw new Error('tx boom');
  // Stage on copies; commit only at the end (transaction atomicity).
  const stagedProducts = new Map(mockState.supaProducts);
  const stagedAudit = [...mockState.supaAudit];
  const auditRow = (action: string, targetId: string, payload: any) => ({
    action, actorUid: args.p_audit.actorUid, targetUidOrResource: targetId,
    targetType: 'product', orderId: null, payload,
  });
  let result: any;
  if (fn === 'tx_store_product_create') {
    const product = { ...args.p_data, createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' };
    stagedProducts.set(args.p_id, product);
    if (mockState.auditFailsInsideTx) throw new Error('audit insert failed inside tx');
    stagedAudit.push(auditRow('product_created', args.p_id, {
      before: null, after: product, changedFields: args.p_audit.changedFields, reason: null, source: 'store_products_api',
    }));
    result = { ok: true, productId: args.p_id };
  } else if (fn === 'tx_store_product_update') {
    const before = stagedProducts.get(args.p_id);
    if (!before) return { ok: false, httpStatus: 404, message: 'Product not found' };
    stagedProducts.set(args.p_id, { ...before, ...args.p_updates, updatedAt: '2026-03-02T00:00:00.000Z' });
    stagedAudit.push(auditRow('product_updated', args.p_id, {
      before, after: { ...before, ...args.p_updates }, changedFields: args.p_audit.changedFields, reason: null, source: 'store_products_api',
    }));
    result = { ok: true, productId: args.p_id };
  } else if (fn === 'tx_store_product_delete') {
    const before = stagedProducts.get(args.p_id);
    if (!before) return { ok: false, httpStatus: 404, message: 'Product not found' };
    stagedProducts.delete(args.p_id);
    stagedAudit.push(auditRow('product_deleted', args.p_id, {
      before, after: null, changedFields: Object.keys(before), reason: null, source: 'store_products_api',
    }));
    result = { ok: true, deleted: args.p_id };
  } else {
    throw new Error(`unexpected tx: ${fn}`);
  }
  mockState.supaProducts = stagedProducts;
  mockState.supaAudit = stagedAudit;
  return result;
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'products') {
      return {
        add: async () => { mockState.fsAdds++; return { id: 'fs-product-1' }; },
        doc: (id: string) => ({
          get: async () => ({ exists: false, id, data: () => undefined }),
        }),
      };
    }
    if (name === 'audit_logs') {
      return { add: async () => { mockState.fsAuditAdds++; return { id: 'fs-audit-1' }; } };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
  batch: () => ({
    update: () => {}, delete: () => {}, set: () => {},
    commit: async () => { mockState.fsBatchCommits++; },
  }),
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
  useSupa: jest.fn(() => false),
  isSupaPrimary: jest.fn(() => mockState.primary),
  getSupaClient: jest.fn(() => ({})),
  getSupaAdapter: jest.fn(() => ({
    listDocs: jest.fn(async () => []),
    tx: jest.fn(async (fn: string, args: any, opts: any) => {
      // tx() injects the idempotency key argument when one is given.
      const finalArgs = opts?.idempotencyKey !== undefined
        ? { ...args, p_idempotency_key: opts.idempotencyKey }
        : args;
      return fakeTx(fn, finalArgs);
    }),
    rpc: jest.fn(async (fn: string, args: any) => fakeTx(fn, args)),
  })),
}));

import { POST, PATCH, DELETE } from '@/app/api/store/products/route';

function req(method: string, url: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: { authorization: 'Bearer <redacted>', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  mockState.primary = false;
  mockState.txCalls = [];
  mockState.txFails = false;
  mockState.auditFailsInsideTx = false;
  mockState.supaProducts = new Map();
  mockState.supaAudit = [];
  mockState.fsAdds = 0;
  mockState.fsBatchCommits = 0;
  mockState.fsAuditAdds = 0;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('products primacy ON', () => {
  beforeEach(() => { mockState.primary = true; });

  it('POST: one tx_store_product_create; id is Firestore-shaped; product + audit committed together; Firestore untouched', async () => {
    const res = await POST(req('POST', 'http://localhost/api/store/products', {
      name: 'Patch', price: 250, category: 'merch',
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.productId).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(mockState.txCalls).toHaveLength(1);
    expect(mockState.txCalls[0][0]).toBe('tx_store_product_create');
    // Timestamps are stamped by the tx, not carried in p_data.
    expect(mockState.txCalls[0][1].p_data).not.toHaveProperty('createdAt');
    expect(mockState.supaProducts.get(body.productId)).toMatchObject({ name: 'Patch', price: 250 });
    expect(mockState.supaAudit).toHaveLength(1);
    expect(mockState.supaAudit[0]).toMatchObject({ action: 'product_created', actorUid: 'admin-1' });
    expect(mockState.fsAdds).toBe(0);
  });

  it('POST P1 delta: audit failure inside the tx rolls the product back (response still 500, nothing persisted)', async () => {
    mockState.auditFailsInsideTx = true;
    const res = await POST(req('POST', 'http://localhost/api/store/products', { name: 'Patch' }));
    expect(res.status).toBe(500);
    expect(mockState.supaProducts.size).toBe(0);
    expect(mockState.supaAudit).toHaveLength(0);
    expect(mockState.fsAdds).toBe(0); // no Firestore fallback on a primary write error
  });

  it('PATCH: one tx with the raw updates + derived audit; missing product -> 404 value', async () => {
    mockState.supaProducts.set('sp-1', { name: 'Old', price: 1 });
    const ok = await PATCH(req('PATCH', 'http://localhost/api/store/products', {
      productId: 'sp-1', updates: { price: 999 },
    }));
    expect(ok.status).toBe(200);
    expect(mockState.txCalls[0][0]).toBe('tx_store_product_update');
    expect(mockState.txCalls[0][1].p_updates).toEqual({ price: 999 });
    expect(mockState.supaProducts.get('sp-1')).toMatchObject({ name: 'Old', price: 999 });
    expect(mockState.supaAudit[0]).toMatchObject({ action: 'product_updated' });
    expect(mockState.supaAudit[0].payload.after).toEqual({ name: 'Old', price: 999 });

    const missing = await PATCH(req('PATCH', 'http://localhost/api/store/products', {
      productId: 'nope', updates: { price: 1 },
    }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Product not found' });
  });

  it('DELETE: one tx; row deleted + audit written; missing product -> 404 value', async () => {
    mockState.supaProducts.set('sp-1', { name: 'Old', price: 1 });
    const ok = await DELETE(req('DELETE', 'http://localhost/api/store/products?productId=sp-1'));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, deleted: 'sp-1' });
    expect(mockState.supaProducts.has('sp-1')).toBe(false);
    expect(mockState.supaAudit[0]).toMatchObject({ action: 'product_deleted' });
    expect(mockState.supaAudit[0].payload.changedFields).toEqual(['name', 'price']);

    const missing = await DELETE(req('DELETE', 'http://localhost/api/store/products?productId=nope'));
    expect(missing.status).toBe(404);
  });
});

describe('products primacy OFF', () => {
  it('POST runs the Firestore path (add + direct audit) and never calls a tx', async () => {
    const res = await POST(req('POST', 'http://localhost/api/store/products', { name: 'Patch', price: 5 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, productId: 'fs-product-1' });
    expect(mockState.fsAdds).toBe(1);
    expect(mockState.fsAuditAdds).toBe(1);
    expect(mockState.txCalls).toHaveLength(0);
  });
});
