/**
 * @jest-environment node
 *
 * STORE CLUSTER — SUPABASE MIGRATION CONTRACT BASELINE (test-author branch
 * feat/supa-store-5). NO production code is touched by this suite.
 *
 * Purpose: pin the CURRENT (base @ 4d5a1e1, feat/integration-wave3) public
 * behavior of the store surfaces so a Supabase-backed implementation can be
 * checked for byte-identical shapes. Everything here runs against MOCKED
 * clients only — zero live Firestore / Supabase reads.
 *
 * Sources read verbatim before writing these contracts:
 *  - src/app/api/store/products/route.ts (258 lines)
 *  - src/app/api/store/orders/route.ts   (457 lines)
 *  - src/app/actions/store.ts            (getProduct / getPublicProducts /
 *                                         syncEventToProduct; createOrder is
 *                                         MANUAL-LIST, see below)
 *  - src/lib/finance/order-canonical.ts  (three legacy order shapes A/B/C)
 *  - src/lib/server/money-audit.ts       (buildMoneyAuditDoc / isSoftDeleted)
 *  - src/app/checkout/page.tsx           (settings/payment_methods reader,
 *                                         PaymentMethodsSettings at ~L482)
 *  - src/app/admin/store/components/certificate-settings.tsx
 *                                         (settings/payment_methods reader +
 *                                         destination_change request writer)
 *  - src/app/api/admin/finance/destinations/route.ts
 *                                         (settings/payment_methods view,
 *                                         destinationMeta split)
 *  - src/components/admin/events/event-form.tsx
 *                                         (Linked Store Product dropdown:
 *                                         client query isActive==true, then
 *                                         in-memory category filter)
 *
 * ADAPTER PARENT CONTRACT (from the migration brief + verified against
 * feat/supa-adapter via `git show`, NOT merged here):
 *  - src/lib/supa/: getDoc / listDocs / countDocs / setDoc / updateDoc /
 *    deleteDoc over fs_<collection> tables, rows { id, data } (jsonb),
 *    adapter returns { id, ...data }.
 *  - useSupa(surface) reads SUPA_SURFACES, default OFF, '*' = all,
 *    case-insensitive (adapter flags.ts: parseSupaSurfaces / useSupa).
 *  - Flag ON + null/unconfigured client, or adapter error => Firestore
 *    fallback, byte-identical shapes.
 *  - Tables for this cluster (create_tables.sql): fs_products, fs_orders,
 *    fs_settings, fs_audit_logs.
 *
 * RE-POINTING: sections marked SPEC-REPLICA contain small test-local
 * replicas of the adapter seam / flag / serializers. When the implementer
 * branches (feat/supa-store-1..4) land their seams, replace the replicas
 * with imports of the real seam and keep every expectation unchanged —
 * the expectations are the contract, the replica is only scaffolding.
 *
 * MONEY SAFETY — MANUAL LIST (must NOT be silently routed through the
 * generic adapter; each needs its own reviewed migration):
 *  1. POST /api/store/orders — server price verification precedes the
 *     write; the write itself is a single orders.add plus best-effort
 *     notifications (no batch, no audit entry on this route today).
 *  2. src/app/actions/store.ts createOrder — multi-write, NON-atomic:
 *     orders.add, events/{id}/registrations set(merge), products
 *     auto-create set/add, chapter_applications update, audit_logs.add.
 *     Price verification (product + per-item sums) precedes all writes.
 *  3. PATCH /api/store/products and PATCH /api/store/orders — state
 *     change + money-audit entry in ONE Firestore batch (fail closed).
 *  4. POST /api/store/products audit entry — direct audit_logs.add AFTER
 *     the product add; NOT atomic (see characterization test).
 *  5. settings/payment_methods writes — no direct writer exists anymore:
 *     changes go through POST /api/admin/finance/approvals with
 *     targetType 'destination_change' (maker-checker). The destinations
 *     GET route is read-only on purpose (CH-10).
 *  6. syncEventToProduct — contract only in this suite (payload shape);
 *     do not migrate it as part of the store read migration.
 */

import { NextRequest } from 'next/server';
import { normalizeOrder } from '@/lib/finance/order-canonical';

// firebase-admin/firestore is imported by money-audit.ts (FieldValue) and
// actions/store.ts (FieldValue). Mock it before either is imported.
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => ({ __serverTimestamp: true }),
    arrayUnion: (v: unknown) => ({ __arrayUnion: v }),
  },
}));

/* ------------------------------------------------------------------ */
/* Shared in-memory Firestore harness (mock-prefixed for jest hoisting) */
/* ------------------------------------------------------------------ */

function mockTs(iso: string) {
  const d = new Date(iso);
  return { toDate: () => d, toMillis: () => d.getTime() };
}

const mockState = {
  decoded: { uid: 'admin-1' } as any,
  permissionGranted: true,
  dbNull: false,
  products: new Map<string, Record<string, any>>(),
  orders: new Map<string, Record<string, any>>(),
  settings: new Map<string, Record<string, any>>(),
  auditEntries: [] as Array<any>,
  auditAddFails: false,
  batchCommitFails: false,
  productSeq: 0,
  orderSeq: 0,
  auditSeq: 0,
};

function mockProductRef(id: string) {
  return {
    id,
    path: `products/${id}`,
    get: async () => {
      const data = mockState.products.get(id);
      return { exists: !!data, id, data: () => (data ? { ...data } : undefined) };
    },
    set: async (data: any) => { mockState.products.set(id, { ...data }); },
    update: async (data: any) => {
      mockState.products.set(id, { ...(mockState.products.get(id) || {}), ...data });
    },
  };
}

function mockOrderRef(id: string) {
  return {
    id,
    path: `orders/${id}`,
    get: async () => {
      const data = mockState.orders.get(id);
      return { exists: !!data, id, data: () => (data ? { ...data } : undefined) };
    },
  };
}

function mockOrdersQuery(
  filters: Array<[string, unknown]> = [],
  cursorId: string | null = null,
  limitN: number | null = null,
): any {
  const q: any = {
    orderBy: () => q,
    where: (f: string, _op: string, v: unknown) => mockOrdersQuery([...filters, [f, v]], cursorId, limitN),
    startAfter: (snap: any) => mockOrdersQuery(filters, snap?.id ?? null, limitN),
    limit: (n: number) => mockOrdersQuery(filters, cursorId, n),
    get: async () => {
      // Harness invariant: mockState.orders insertion order IS createdAt desc
      // order (tests seed newest-first), matching orderBy('createdAt','desc').
      let rows = [...mockState.orders.entries()].map(([id, data]) => ({ id, data }));
      for (const [f, v] of filters) rows = rows.filter((r) => r.data[f] === v);
      if (cursorId) {
        const idx = rows.findIndex((r) => r.id === cursorId);
        if (idx >= 0) rows = rows.slice(idx + 1);
      }
      if (limitN != null) rows = rows.slice(0, limitN);
      const docs = rows.map((r) => ({ id: r.id, data: () => ({ ...r.data }) }));
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  };
  return q;
}

const mockDb: any = {
  collection: (name: string) => {
    if (name === 'products') {
      return {
        doc: (id: string) => mockProductRef(id),
        add: async (data: any) => {
          const id = `prod-new-${++mockState.productSeq}`;
          mockState.products.set(id, { ...data });
          return { id };
        },
        get: async () => ({
          docs: [...mockState.products.entries()].map(([id, data]) => ({
            id,
            data: () => ({ ...data }),
          })),
        }),
        where: (f: string, _op: string, v: unknown) => ({
          get: async () => ({
            docs: [...mockState.products.entries()]
              .filter(([, data]) => data[f] === v)
              .map(([id, data]) => ({ id, data: () => ({ ...data }) })),
          }),
        }),
      };
    }
    if (name === 'orders') {
      return {
        ...mockOrdersQuery(),
        doc: (id: string) => mockOrderRef(id),
        add: async (data: any) => {
          const id = `order-new-${++mockState.orderSeq}`;
          mockState.orders.set(id, { ...data });
          return { id };
        },
      };
    }
    if (name === 'audit_logs') {
      return {
        doc: () => {
          const id = `audit-${++mockState.auditSeq}`;
          return { id, path: `audit_logs/${id}` };
        },
        add: async (data: any) => {
          if (mockState.auditAddFails) throw new Error('audit write failed (mock)');
          mockState.auditEntries.push(data);
          return { id: 'audit-add' };
        },
      };
    }
    if (name === 'settings') {
      return {
        doc: (id: string) => ({
          id,
          path: `settings/${id}`,
          get: async () => {
            const data = mockState.settings.get(id);
            return { exists: !!data, id, data: () => (data ? { ...data } : undefined) };
          },
        }),
      };
    }
    if (name === 'events') {
      return {
        doc: (id: string) => ({
          id,
          path: `events/${id}`,
          get: async () => ({ exists: false, id, data: () => undefined }),
        }),
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
        if (mockState.batchCommitFails) throw new Error('batch commit failed (mock)');
        for (const o of ops) {
          if (o.ref.path?.startsWith('audit_logs/')) {
            mockState.auditEntries.push(o.data);
          } else if (o.ref.path?.startsWith('products/')) {
            if (o.kind === 'delete') mockState.products.delete(o.ref.id);
            else if (o.kind === 'update') {
              mockState.products.set(o.ref.id, { ...(mockState.products.get(o.ref.id) || {}), ...o.data });
            } else if (o.kind === 'set') mockState.products.set(o.ref.id, { ...o.data });
          } else if (o.ref.path?.startsWith('orders/')) {
            if (o.kind === 'update') {
              mockState.orders.set(o.ref.id, { ...(mockState.orders.get(o.ref.id) || {}), ...o.data });
            }
          }
        }
      },
    };
  },
};

const mockAdminStub = {
  auth: () => ({
    verifyIdToken: async (token: string) => {
      if (token === 'bad') throw new Error('invalid token (mock)');
      return mockState.decoded;
    },
  }),
  firestore: {
    Timestamp: { now: () => mockTs('2026-10-25T05:00:00.000Z') },
    FieldValue: {
      serverTimestamp: () => ({ __serverTimestamp: true }),
      arrayUnion: (v: unknown) => ({ __arrayUnion: v }),
    },
  },
};

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: mockAdminStub,
  ...mockAdminStub,
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => (mockState.dbNull ? null : mockDb)),
  ensureAdminInitialized: jest.fn(() => true),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => mockState.permissionGranted),
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: jest.fn(async () => undefined),
    broadcastByRoles: jest.fn(async () => undefined),
  },
}));

import { isSoftDeleted, buildMoneyAuditDoc } from '@/lib/server/money-audit';
import {
  GET as productsGET,
  POST as productsPOST,
  PATCH as productsPATCH,
  DELETE as productsDELETE,
} from '@/app/api/store/products/route';
import {
  GET as ordersGET,
  POST as ordersPOST,
  PATCH as ordersPATCH,
  DELETE as ordersDELETE,
} from '@/app/api/store/orders/route';
import { getProduct, getPublicProducts, syncEventToProduct } from '@/app/actions/store';

function authedReq(method: string, url: string, body?: unknown, token = 'test-token') {
  return new NextRequest(url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function resetMockState() {
  mockState.decoded = { uid: 'admin-1' };
  mockState.permissionGranted = true;
  mockState.dbNull = false;
  mockState.products = new Map();
  mockState.orders = new Map();
  mockState.settings = new Map();
  mockState.auditEntries = [];
  mockState.auditAddFails = false;
  mockState.batchCommitFails = false;
  mockState.productSeq = 0;
  mockState.orderSeq = 0;
  mockState.auditSeq = 0;
}

beforeEach(() => {
  resetMockState();
  jest.clearAllMocks();
});

/* ------------------------------------------------------------------ */
/* Order canonicalization — the three legacy shapes (order-canonical)  */
/* ------------------------------------------------------------------ */

describe('contract: normalizeOrder across the three legacy order shapes', () => {
  it('shape A (types/checkout): total + status pending + userId + proofOfPaymentUrl', () => {
    const c = normalizeOrder(
      {
        total: 700,
        status: 'pending',
        userId: 'u-a',
        proofOfPaymentUrl: 'https://drive.example/a',
        proofOfPaymentDriveFileId: 'drive-a',
        items: [{ productId: 'p1', subtotal: 700 }],
      },
      'ord-a',
    );
    expect(c.id).toBe('ord-a');
    expect(c.totalPkr).toBe(700);
    expect(c.status).toBe('pending_verification'); // pending -> canonical
    expect(c.paymentStatus).toBe('pending'); // absent + not verified
    expect(c.buyerUserId).toBe('u-a'); // userId fallback
    expect(c.receiptUrl).toBe('https://drive.example/a');
    expect(c.receiptDriveId).toBe('drive-a');
    expect(c.currency).toBe('PKR'); // default when absent
    expect(c.dataQuality).toEqual({ missingAmount: false, unknownStatus: false });
  });

  it('shape B (orders API POST): amount + pending_verification + buyerUserId + receiptUrl', () => {
    const c = normalizeOrder(
      {
        amount: 500,
        status: 'pending_verification',
        paymentStatus: 'pending',
        buyerUserId: 'u-b',
        receiptUrl: 'https://drive.example/b',
        totalPkr: 500,
        total: 500,
      },
      'ord-b',
    );
    expect(c.totalPkr).toBe(500); // totalPkr wins over total/amount
    expect(c.status).toBe('pending_verification');
    expect(c.paymentStatus).toBe('pending');
    expect(c.buyerUserId).toBe('u-b');
    expect(c.receiptUrl).toBe('https://drive.example/b');
  });

  it('shape C (legacy admin): amount + paid + buyerUserId -> verified/completed', () => {
    const c = normalizeOrder(
      { amount: 900, status: 'paid', buyerUserId: 'u-c', receiptUrl: 'r-c' },
      'ord-c',
    );
    expect(c.totalPkr).toBe(900); // falls back totalPkr > total > amount
    expect(c.status).toBe('verified'); // paid -> verified
    expect(c.paymentStatus).toBe('completed'); // absent + paid => completed
    expect(c.buyerUserId).toBe('u-c');
  });

  it('money precedence and fallbacks: total > amount > item subtotal sum > 0+missingAmount', () => {
    expect(normalizeOrder({ total: 3, amount: 9 }, 'x').totalPkr).toBe(3);
    expect(normalizeOrder({ amount: 9 }, 'x').totalPkr).toBe(9);
    expect(
      normalizeOrder({ items: [{ subtotal: 4 }, { subtotal: 5 }] }, 'x').totalPkr,
    ).toBe(9);
    const empty = normalizeOrder({}, 'x');
    expect(empty.totalPkr).toBe(0);
    expect(empty.dataQuality.missingAmount).toBe(true);
    expect(empty.buyer).toBeNull();
    expect(empty.items).toEqual([]);
    expect(empty.isDeleted).toBe(false);
    expect(empty.declaredAmountPkr).toBeNull();
  });

  it('status map: pending_payment -> pending_verification, printed -> processing, unknown passes through flagged', () => {
    expect(normalizeOrder({ status: 'pending_payment' }, 'x').status).toBe('pending_verification');
    expect(normalizeOrder({ status: 'printed' }, 'x').status).toBe('processing');
    const unknown = normalizeOrder({ status: 'weird_legacy' }, 'x');
    expect(unknown.status).toBe('weird_legacy');
    expect(unknown.dataQuality.unknownStatus).toBe(true);
  });

  it('isDeleted derives from isDeleted===true OR canonical status soft_deleted', () => {
    expect(normalizeOrder({ isDeleted: true }, 'x').isDeleted).toBe(true);
    expect(normalizeOrder({ status: 'soft_deleted' }, 'x').isDeleted).toBe(true);
    expect(normalizeOrder({ isDeleted: false, status: 'processing' }, 'x').isDeleted).toBe(false);
  });
});

describe('contract: isSoftDeleted (money-audit) — GET orders filter predicate', () => {
  it('deleted iff deletedAt is present and non-null (absent/null are NOT deleted)', () => {
    expect(isSoftDeleted({})).toBe(false);
    expect(isSoftDeleted({ deletedAt: null })).toBe(false);
    expect(isSoftDeleted({ deletedAt: new Date() })).toBe(true);
    expect(isSoftDeleted(null)).toBe(false);
    expect(isSoftDeleted(undefined)).toBe(false);
  });
});

describe('contract: buildMoneyAuditDoc shape (audit_logs writer for store money actions)', () => {
  it('flattens target fields, nests before/after in payload, defaults orderId by targetType', () => {
    const doc = buildMoneyAuditDoc({
      action: 'product_created',
      actorUid: 'admin-1',
      targetType: 'product',
      targetId: 'prod-1',
      before: null,
      after: { price: 2500, dropped: undefined },
      changedFields: ['price'],
      source: 'store_products_api',
    });
    expect(doc.action).toBe('product_created');
    expect(doc.actorUid).toBe('admin-1');
    expect(doc.actorRole).toBe(''); // default when omitted
    expect(doc.targetUidOrResource).toBe('prod-1');
    expect(doc.targetType).toBe('product');
    expect(doc.orderId).toBeNull(); // non-order target => null
    expect(doc.payload).toEqual({
      before: null,
      after: { price: 2500 }, // undefined values stripped, nulls kept
      changedFields: ['price'],
      reason: null,
      source: 'store_products_api',
    });
    expect(doc.timestamp).toEqual({ __serverTimestamp: true });
    expect(doc.createdAt).toEqual({ __serverTimestamp: true });
  });

  it('order targets default orderId to the targetId', () => {
    const doc = buildMoneyAuditDoc({
      action: 'order_status_updated',
      actorUid: 'admin-1',
      targetType: 'order',
      targetId: 'ord-1',
      before: { status: 'verified' },
      after: { status: 'shipped' },
      source: 'store_orders_api',
    });
    expect(doc.orderId).toBe('ord-1');
  });
});


/* ------------------------------------------------------------------ */
/* /api/store/products — current behavior contracts                    */
/* ------------------------------------------------------------------ */

describe('contract: GET /api/store/products', () => {
  it('401 without a Bearer header; 403 without canManageStore; 500 when db is null', async () => {
    const noAuth = new NextRequest('http://localhost/api/store/products', { method: 'GET' });
    expect((await productsGET(noAuth)).status).toBe(401);

    mockState.permissionGranted = false;
    const forbidden = await productsGET(authedReq('GET', 'http://localhost/api/store/products'));
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error).toBe('Forbidden');

    mockState.permissionGranted = true;
    mockState.dbNull = true;
    const noDb = await productsGET(authedReq('GET', 'http://localhost/api/store/products'));
    expect(noDb.status).toBe(500);
    expect((await noDb.json()).error).toBe('Firestore not initialized');
  });

  it('200 shape: { ok:true, products:[{id, ...data, createdAt ISO, updatedAt ISO}], count } — ALL products, no isActive/category filter', async () => {
    mockState.products.set('p-active', {
      name: 'Patch', price: 100, isActive: true, category: 'merch',
      createdAt: mockTs('2026-10-01T10:00:00.000Z'), updatedAt: mockTs('2026-10-02T10:00:00.000Z'),
    });
    mockState.products.set('p-inactive', {
      name: 'Old', price: 50, isActive: false, category: 'event_ticket',
      createdAt: mockTs('2026-09-01T10:00:00.000Z'), updatedAt: mockTs('2026-09-01T10:00:00.000Z'),
    });
    const res = await productsGET(authedReq('GET', 'http://localhost/api/store/products'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.count).toBe(2); // inactive included: this route does not filter
    expect(body.products[0]).toEqual({
      id: 'p-active', name: 'Patch', price: 100, isActive: true, category: 'merch',
      createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z',
    });
    expect(body.products[1].id).toBe('p-inactive');
  });

  it('CHARACTERIZATION (Timestamp assumption): an ISO-string createdAt (the Supabase jsonb shape) serializes to null, as does a missing one', async () => {
    // Route code: data.createdAt?.toDate?.()?.toISOString() || null.
    // A faithful migration must convert ISO strings BEFORE this expression
    // (or change the expression); feeding fs_products jsonb rows straight
    // through it would null every timestamp. This pins the Firestore-side
    // behavior the implementer must reproduce the OUTPUT of, not the code.
    mockState.products.set('p-iso', {
      name: 'ISO', price: 1, isActive: true,
      createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z',
    });
    mockState.products.set('p-none', { name: 'None', price: 1, isActive: true });
    const body = await (await productsGET(authedReq('GET', 'http://localhost/api/store/products'))).json();
    expect(body.products[0].createdAt).toBeNull();
    expect(body.products[0].updatedAt).toBeNull();
    expect(body.products[1].createdAt).toBeNull();
    expect(body.products[1].updatedAt).toBeNull();
  });
});

describe('contract: POST /api/store/products', () => {
  it('400 when name is missing; nothing written, no audit', async () => {
    const res = await productsPOST(authedReq('POST', 'http://localhost/api/store/products', { price: 5 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Product name is required');
    expect(mockState.products.size).toBe(0);
    expect(mockState.auditEntries).toHaveLength(0);
  });

  it('defaults: price 0, currency PKR, stock 999, category other, isActive true, linked ids null; timestamps are Timestamp.now()', async () => {
    const res = await productsPOST(authedReq('POST', 'http://localhost/api/store/products', { name: 'Bare' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, productId: 'prod-new-1', message: 'Product created successfully' });
    const stored = mockState.products.get('prod-new-1')!;
    expect(stored.name).toBe('Bare');
    expect(stored.description).toBe('');
    expect(stored.price).toBe(0);
    expect(stored.currency).toBe('PKR');
    expect(stored.stock).toBe(999);
    expect(stored.category).toBe('other');
    expect(stored.isActive).toBe(true);
    expect(stored.imageUrl).toBe('');
    expect(stored.linkedEventId).toBeNull();
    expect(stored.linkedFormId).toBeNull();
    expect(typeof stored.createdAt.toDate).toBe('function');
    expect(stored.createdAt.toDate().toISOString()).toBe('2026-10-25T05:00:00.000Z');
    // Direct (non-batch) audit entry, action product_created, source pinned.
    expect(mockState.auditEntries).toHaveLength(1);
    expect(mockState.auditEntries[0].action).toBe('product_created');
    expect(mockState.auditEntries[0].payload.source).toBe('store_products_api');
    expect(mockState.auditEntries[0].payload.after).toEqual(stored);
  });

  it('coercions: numeric strings become numbers, explicit isActive=false survives, linked ids pass through', async () => {
    await productsPOST(authedReq('POST', 'http://localhost/api/store/products', {
      name: 'Ticket', price: '750', stock: '12', currency: 'USD', category: 'event_ticket',
      isActive: false, linkedEventId: 'ev-1', linkedFormId: 'form-1',
    }));
    const stored = mockState.products.get('prod-new-1')!;
    expect(stored.price).toBe(750);
    expect(stored.stock).toBe(12);
    expect(stored.isActive).toBe(false);
    expect(stored.linkedEventId).toBe('ev-1');
    expect(stored.linkedFormId).toBe('form-1');
  });

  it('MANUAL-LIST / non-atomic audit: audit add failure => 500 "Product created but audit logging failed", product EXISTS, zero audit entries', async () => {
    mockState.auditAddFails = true;
    const res = await productsPOST(authedReq('POST', 'http://localhost/api/store/products', { name: 'X', price: 1 }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Product created but audit logging failed');
    expect(mockState.products.size).toBe(1); // creation is NOT rolled back
    expect(mockState.auditEntries).toHaveLength(0);
  });
});

describe('contract: PATCH + DELETE /api/store/products', () => {
  it('PATCH 400 without productId; 404 for a missing product', async () => {
    const bad = await productsPATCH(authedReq('PATCH', 'http://localhost/api/store/products', { updates: {} }));
    expect(bad.status).toBe(400);
    const ghost = await productsPATCH(authedReq('PATCH', 'http://localhost/api/store/products', {
      productId: 'ghost', updates: { price: 1 },
    }));
    expect(ghost.status).toBe(404);
  });

  it('PATCH applies updates verbatim (no field whitelist) plus updatedAt, in one batch with the audit entry', async () => {
    mockState.products.set('p-1', { name: 'A', price: 100, customField: 'keep' });
    const res = await productsPATCH(authedReq('PATCH', 'http://localhost/api/store/products', {
      productId: 'p-1', updates: { price: 200, anythingGoes: true },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, productId: 'p-1' });
    const stored = mockState.products.get('p-1')!;
    expect(stored.price).toBe(200);
    expect(stored.anythingGoes).toBe(true);
    expect(stored.customField).toBe('keep');
    expect(stored.updatedAt.toDate().toISOString()).toBe('2026-10-25T05:00:00.000Z');
    expect(mockState.auditEntries[0].action).toBe('product_updated');
    expect(mockState.auditEntries[0].payload.changedFields).toEqual(['price', 'anythingGoes']);
  });

  it('MONEY SAFETY: PATCH batch commit failure => 500, product unchanged, zero audit entries (atomic)', async () => {
    mockState.products.set('p-1', { name: 'A', price: 100 });
    mockState.batchCommitFails = true;
    const res = await productsPATCH(authedReq('PATCH', 'http://localhost/api/store/products', {
      productId: 'p-1', updates: { price: 999 },
    }));
    expect(res.status).toBe(500);
    expect(mockState.products.get('p-1')!.price).toBe(100);
    expect(mockState.auditEntries).toHaveLength(0);
  });

  it('DELETE 400 without ?productId; 404 for missing; 200 { ok:true, deleted } with product_deleted audit in the same batch', async () => {
    const bad = await productsDELETE(authedReq('DELETE', 'http://localhost/api/store/products'));
    expect(bad.status).toBe(400);
    const ghost = await productsDELETE(authedReq('DELETE', 'http://localhost/api/store/products?productId=ghost'));
    expect(ghost.status).toBe(404);

    mockState.products.set('p-1', { name: 'A', price: 100 });
    const res = await productsDELETE(authedReq('DELETE', 'http://localhost/api/store/products?productId=p-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: 'p-1' });
    expect(mockState.products.has('p-1')).toBe(false); // products DELETE is a HARD delete today
    expect(mockState.auditEntries[0].action).toBe('product_deleted');
  });
});

/* ------------------------------------------------------------------ */
/* /api/store/orders — current behavior contracts                      */
/* ------------------------------------------------------------------ */

function seedOrder(id: string, data: Record<string, any> = {}) {
  mockState.orders.set(id, {
    status: 'pending_verification',
    paymentStatus: 'pending',
    totalPkr: 100,
    total: 100,
    amount: 100,
    buyerUserId: 'buyer-1',
    items: [],
    createdAt: mockTs('2026-10-01T00:00:00.000Z'),
    updatedAt: mockTs('2026-10-01T00:00:00.000Z'),
    ...data,
  });
}

describe('contract: GET /api/store/orders pagination + shape', () => {
  beforeEach(() => {
    for (const id of ['o-1', 'o-2', 'o-3', 'o-4', 'o-5']) seedOrder(id);
    mockState.products.set('p-1', {
      name: 'Ticket', price: 500, isActive: true,
      createdAt: mockTs('2026-09-01T00:00:00.000Z'), updatedAt: mockTs('2026-09-01T00:00:00.000Z'),
    });
  });

  it('default limit 20; envelope { ok, orders, products, count, hasMore, nextCursor, pagination{limit,cursor,hasMore,nextCursor} }', async () => {
    const body = await (await ordersGET(authedReq('GET', 'http://localhost/api/store/orders'))).json();
    expect(body.ok).toBe(true);
    expect(body.count).toBe(5);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
    expect(body.pagination).toEqual({ limit: 20, cursor: null, hasMore: false, nextCursor: null });
    // Embedded products: the WHOLE products collection, same serializer as
    // the products route (id spread + ISO timestamps).
    expect(body.products).toEqual([{
      id: 'p-1', name: 'Ticket', price: 500, isActive: true,
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    }]);
  });

  it('limit+cursor walk: limit=2 pages o-1..o-5 with hasMore/nextCursor on each full page', async () => {
    const page1 = await (await ordersGET(authedReq('GET', 'http://localhost/api/store/orders?limit=2'))).json();
    expect(page1.orders.map((o: any) => o.id)).toEqual(['o-1', 'o-2']);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBe('o-2');
    expect(page1.pagination).toEqual({ limit: 2, cursor: null, hasMore: true, nextCursor: 'o-2' });

    const page2 = await (await ordersGET(authedReq('GET', 'http://localhost/api/store/orders?limit=2&cursor=o-2'))).json();
    expect(page2.orders.map((o: any) => o.id)).toEqual(['o-3', 'o-4']);
    expect(page2.nextCursor).toBe('o-4');
    expect(page2.pagination.cursor).toBe('o-2');

    const page3 = await (await ordersGET(authedReq('GET', 'http://localhost/api/store/orders?limit=2&cursor=o-4'))).json();
    expect(page3.orders.map((o: any) => o.id)).toEqual(['o-5']);
    expect(page3.hasMore).toBe(false);
    expect(page3.nextCursor).toBeNull();
  });

  it('limit is clamped to [1, 50]: limit=0 -> 1, limit=999 -> 50', async () => {
    const low = await (await ordersGET(authedReq('GET', 'http://localhost/api/store/orders?limit=0'))).json();
    expect(low.pagination.limit).toBe(1);
    expect(low.count).toBe(1);
    const high = await (await ordersGET(authedReq('GET', 'http://localhost/api/store/orders?limit=999'))).json();
    expect(high.pagination.limit).toBe(50);
  });

  it('unknown cursor id is ignored (no startAfter applied) rather than erroring', async () => {
    const body = await (await ordersGET(authedReq('GET', 'http://localhost/api/store/orders?limit=2&cursor=ghost'))).json();
    expect(body.orders.map((o: any) => o.id)).toEqual(['o-1', 'o-2']);
    expect(body.pagination.cursor).toBe('ghost'); // echoed verbatim
  });

  it('status filter: ?status=X filters on the STORED status; ?status=all disables the filter', async () => {
    mockState.orders.set('o-3', { ...mockState.orders.get('o-3'), status: 'shipped' });
    const filtered = await (await ordersGET(authedReq('GET', 'http://localhost/api/store/orders?status=shipped'))).json();
    expect(filtered.orders.map((o: any) => o.id)).toEqual(['o-3']);
    const all = await (await ordersGET(authedReq('GET', 'http://localhost/api/store/orders?status=all'))).json();
    expect(all.count).toBe(5);
  });

  it('CHARACTERIZATION: hasMore is computed AFTER soft-delete filtering of the limit+1 window — a deleted doc inside the window can hide a further page', async () => {
    // Seed order (createdAt desc): a, DELETED, b, c. limit=2 fetches
    // [a, deleted, b] (limit+1), filters to [a, b], hasMore = 2 > 2 = false
    // even though c exists beyond the window. Faithful-migration quirk;
    // an implementer "fixing" it changes observable pagination.
    mockState.orders = new Map();
    seedOrder('a');
    seedOrder('gone', { deletedAt: mockTs('2026-10-05T00:00:00.000Z') });
    seedOrder('b');
    seedOrder('c');
    const body = await (await ordersGET(authedReq('GET', 'http://localhost/api/store/orders?limit=2'))).json();
    expect(body.orders.map((o: any) => o.id)).toEqual(['a', 'b']);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it('canonical overlay: raw fields are preserved AND canonical fields override (legacy shapes A and C in one response)', async () => {
    mockState.orders = new Map();
    seedOrder('shape-a', {
      total: 700, totalPkr: undefined, amount: undefined,
      status: 'pending', paymentStatus: undefined,
      userId: 'u-a', buyerUserId: undefined,
      proofOfPaymentUrl: 'https://drive.example/a', receiptUrl: undefined,
    });
    seedOrder('shape-c', {
      amount: 900, total: undefined, totalPkr: undefined,
      status: 'paid', paymentStatus: undefined, buyerUserId: 'u-c', receiptUrl: 'r-c',
    });
    const body = await (await ordersGET(authedReq('GET', 'http://localhost/api/store/orders'))).json();
    const a = body.orders.find((o: any) => o.id === 'shape-a');
    expect(a.status).toBe('pending_verification');
    expect(a.totalPkr).toBe(700);
    expect(a.buyerUserId).toBe('u-a');
    expect(a.receiptUrl).toBe('https://drive.example/a');
    expect(a.proofOfPaymentUrl).toBe('https://drive.example/a'); // raw preserved
    expect(a.userId).toBe('u-a'); // raw preserved
    expect(a.isDeleted).toBe(false);
    expect(a.createdAt).toBe('2026-10-01T00:00:00.000Z');
    const c = body.orders.find((o: any) => o.id === 'shape-c');
    expect(c.status).toBe('verified');
    expect(c.paymentStatus).toBe('completed');
    expect(c.totalPkr).toBe(900);
  });
});


describe('contract: POST /api/store/orders — MANUAL-LIST (price verification precedes the write)', () => {
  beforeEach(() => {
    mockState.decoded = { uid: 'buyer-9' };
    mockState.products.set('prod-1', { name: 'Ticket', price: 500, isActive: true });
  });

  it('401 for a missing token and for a token that fails verification (no canManageStore gate on POST)', async () => {
    const noTok = new NextRequest('http://localhost/api/store/orders', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: 500 }),
    });
    expect((await ordersPOST(noTok)).status).toBe(401);
    const bad = await ordersPOST(authedReq('POST', 'http://localhost/api/store/orders', { amount: 500 }, 'bad'));
    expect(bad.status).toBe(401);
    expect(mockState.orders.size).toBe(0);
  });

  it('happy path writes the canonical dual-write shape and returns { ok:true, orderId, message }', async () => {
    const res = await ordersPOST(authedReq('POST', 'http://localhost/api/store/orders', {
      amount: 1000,
      productId: 'prod-1',
      items: [{ productId: 'prod-1', quantity: 2, title: 'Ticket' }],
      buyer: { fullName: 'B' },
      receiptUrl: 'https://drive.example/r',
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, orderId: 'order-new-1', message: 'Order created successfully' });
    const stored = mockState.orders.get('order-new-1')!;
    expect(stored.status).toBe('pending_verification');
    expect(stored.paymentStatus).toBe('pending');
    expect(stored.totalPkr).toBe(1000); // server price 500 x qty 2
    expect(stored.total).toBe(1000);
    expect(stored.amount).toBe(1000);
    expect(stored.declaredAmountPkr).toBeNull();
    expect(stored.buyerUserId).toBe('buyer-9');
    expect(stored.userId).toBe('buyer-9'); // compat dual-write
    expect(stored.currency).toBe('PKR');
    expect(stored.paymentMethod).toBe('manual');
    expect(stored.isDeleted).toBe(false);
    expect(stored.originatingModule).toBe('store');
    expect(stored.testMode).toBe(false);
    expect(stored.certificateCode).toBeNull();
    expect(stored.holderUserId).toBeNull();
    expect(typeof stored.createdAt.toDate).toBe('function');
    expect(mockState.auditEntries).toHaveLength(0); // this route writes NO audit entry today
  });

  it('price mismatch => 422 and NOTHING is written (verification precedes orders.add)', async () => {
    const res = await ordersPOST(authedReq('POST', 'http://localhost/api/store/orders', {
      amount: 999, productId: 'prod-1', items: [{ productId: 'prod-1', quantity: 1 }],
    }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/Price verification failed/);
    expect(mockState.orders.size).toBe(0);
  });

  it('claimed amount may arrive as `total` instead of `amount`; quantity defaults to 1', async () => {
    const res = await ordersPOST(authedReq('POST', 'http://localhost/api/store/orders', {
      total: 500, productId: 'prod-1',
    }));
    expect(res.status).toBe(200);
    const stored = mockState.orders.get('order-new-1')!;
    expect(stored.totalPkr).toBe(500);
    expect(stored.amount).toBe(500); // amount field stores the CLAIMED value (here = total)
  });

  it('verification is SKIPPED when the product doc is missing or its price is not a number — claimed amount is trusted', async () => {
    const missing = await ordersPOST(authedReq('POST', 'http://localhost/api/store/orders', {
      amount: 4242, productId: 'ghost',
    }));
    expect(missing.status).toBe(200);
    expect(mockState.orders.get('order-new-1')!.totalPkr).toBe(4242);

    mockState.products.set('prod-str', { name: 'S', price: '500' });
    const strPrice = await ordersPOST(authedReq('POST', 'http://localhost/api/store/orders', {
      amount: 4242, productId: 'prod-str',
    }));
    expect(strPrice.status).toBe(200);
    expect(mockState.orders.get('order-new-2')!.totalPkr).toBe(4242);
  });

  it('donation module bypasses price verification entirely: totalPkr null, declaredAmountPkr = claimed, total = claimed', async () => {
    const res = await ordersPOST(authedReq('POST', 'http://localhost/api/store/orders', {
      amount: 1234, productId: 'prod-1', originatingModule: 'donation',
    }));
    expect(res.status).toBe(200); // 1234 != 500 yet accepted: donations are declared, not priced
    const stored = mockState.orders.get('order-new-1')!;
    expect(stored.totalPkr).toBeNull();
    expect(stored.declaredAmountPkr).toBe(1234);
    expect(stored.total).toBe(1234);
  });

  it('USD certificate exception: totalPkr null, total = claimed/verified in USD, excluded from PKR totals by construction', async () => {
    const res = await ordersPOST(authedReq('POST', 'http://localhost/api/store/orders', {
      amount: 500, currency: 'USD', productId: 'prod-1', items: [{ productId: 'prod-1', quantity: 1 }],
    }));
    expect(res.status).toBe(200);
    const stored = mockState.orders.get('order-new-1')!;
    expect(stored.totalPkr).toBeNull();
    expect(stored.total).toBe(500);
    expect(stored.currency).toBe('USD');
  });
});

describe('contract: PATCH + DELETE /api/store/orders', () => {
  beforeEach(() => {
    seedOrder('o-1', {});
  });

  it('PATCH 400 without orderId or without updates; 400 for a non-whitelisted status; 404 for a missing order', async () => {
    expect((await ordersPATCH(authedReq('PATCH', 'http://localhost/api/store/orders', { updates: { status: 'shipped' } }))).status).toBe(400);
    expect((await ordersPATCH(authedReq('PATCH', 'http://localhost/api/store/orders', { orderId: 'o-1' }))).status).toBe(400);
    const bogus = await ordersPATCH(authedReq('PATCH', 'http://localhost/api/store/orders', {
      orderId: 'o-1', updates: { status: 'bogus' },
    }));
    expect(bogus.status).toBe(400);
    expect((await bogus.json()).error).toBe('Invalid status');
    const ghost = await ordersPATCH(authedReq('PATCH', 'http://localhost/api/store/orders', {
      orderId: 'ghost', updates: { status: 'shipped' },
    }));
    expect(ghost.status).toBe(404);
    expect(mockState.auditEntries).toHaveLength(0);
  });

  it('PATCH money guard: EVERY money field and money status is 409 with useInstead pointing at the approvals flow, no write, no audit', async () => {
    for (const updates of [
      { total: 1 }, { totalPkr: 1 }, { amount: 1 }, { amountPkr: 1 }, { declaredAmountPkr: 1 },
      { paymentStatus: 'completed' }, { paymentMethod: 'x' }, { receiptUrl: 'x' },
      { receiptDriveId: 'x' }, { isDeleted: true },
      { status: 'verified' }, { status: 'refunded' }, { status: 'soft_deleted' },
    ]) {
      const res = await ordersPATCH(authedReq('PATCH', 'http://localhost/api/store/orders', { orderId: 'o-1', updates }));
      expect(res.status).toBe(409);
      expect((await res.json()).useInstead).toBe('POST /api/admin/finance/approvals');
    }
    expect(mockState.orders.get('o-1')!.status).toBe('pending_verification');
    expect(mockState.auditEntries).toHaveLength(0);
  });

  it('PATCH non-money fulfilment: only status + fulfilmentNote are applied (other fields silently dropped), one batch audit entry', async () => {
    const res = await ordersPATCH(authedReq('PATCH', 'http://localhost/api/store/orders', {
      orderId: 'o-1',
      updates: { status: 'shipped', fulfilmentNote: 'TCS 123', hackerField: 'drop-me', buyer: { fullName: 'Nope' } },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, orderId: 'o-1' });
    const stored = mockState.orders.get('o-1')!;
    expect(stored.status).toBe('shipped');
    expect(stored.fulfilmentNote).toBe('TCS 123');
    expect(stored.hackerField).toBeUndefined();
    expect(stored.buyer).toBeUndefined();
    expect(mockState.auditEntries).toHaveLength(1);
    expect(mockState.auditEntries[0].action).toBe('order_status_updated');
    expect(mockState.auditEntries[0].payload.changedFields).toEqual(['status', 'fulfilmentNote', 'hackerField', 'buyer']); // audit records the REQUESTED keys, not the sanitized ones
    expect(mockState.auditEntries[0].payload.source).toBe('store_orders_api');
  });

  it('PATCH fulfilmentNote alone derives audit action order_updated', async () => {
    const res = await ordersPATCH(authedReq('PATCH', 'http://localhost/api/store/orders', {
      orderId: 'o-1', updates: { fulfilmentNote: 'note' },
    }));
    expect(res.status).toBe(200);
    expect(mockState.auditEntries[0].action).toBe('order_updated');
    expect(mockState.orders.get('o-1')!.status).toBe('pending_verification');
  });

  it('MONEY SAFETY: PATCH batch commit failure => 500, order unchanged, zero audit entries (atomic)', async () => {
    mockState.batchCommitFails = true;
    const res = await ordersPATCH(authedReq('PATCH', 'http://localhost/api/store/orders', {
      orderId: 'o-1', updates: { status: 'shipped' },
    }));
    expect(res.status).toBe(500);
    expect(mockState.orders.get('o-1')!.status).toBe('pending_verification');
    expect(mockState.auditEntries).toHaveLength(0);
  });

  it('DELETE: 401 without a token (status carried from verifyAdmin), 403 without permission, 410 with useInstead for an admin — order untouched in all cases', async () => {
    const noTok = new NextRequest('http://localhost/api/store/orders?orderId=o-1', { method: 'DELETE' });
    expect((await ordersDELETE(noTok)).status).toBe(401);

    mockState.permissionGranted = false;
    expect((await ordersDELETE(authedReq('DELETE', 'http://localhost/api/store/orders?orderId=o-1'))).status).toBe(403);

    mockState.permissionGranted = true;
    const gone = await ordersDELETE(authedReq('DELETE', 'http://localhost/api/store/orders?orderId=o-1'));
    expect(gone.status).toBe(410);
    expect((await gone.json()).useInstead).toMatch(/order_soft_delete/);
    expect(mockState.orders.has('o-1')).toBe(true);
    expect(mockState.auditEntries).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* src/app/actions/store.ts — read + sync contracts (contract only)    */
/* ------------------------------------------------------------------ */

describe('contract: actions/store getProduct + getPublicProducts', () => {
  it('getProduct: not found => { success:false, error:"Product not found" }', async () => {
    await expect(getProduct('ghost')).resolves.toEqual({ success: false, error: 'Product not found' });
  });

  it('getProduct: { success:true, data:{ ...data, id } } — Timestamp converts to ISO, an ISO string passes through UNCHANGED (diverges from the products route!)', async () => {
    mockState.products.set('p-ts', {
      name: 'TS', price: 1,
      createdAt: mockTs('2026-10-01T00:00:00.000Z'), updatedAt: mockTs('2026-10-02T00:00:00.000Z'),
    });
    const tsRes = await getProduct('p-ts');
    expect(tsRes.success).toBe(true);
    expect(tsRes.data!.createdAt).toBe('2026-10-01T00:00:00.000Z' as never);

    mockState.products.set('p-iso', {
      name: 'ISO', price: 1,
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
    });
    const isoRes = await getProduct('p-iso');
    // getProduct only converts when typeof toDate === 'function'; jsonb ISO
    // strings survive byte-identically. The ROUTES null them (pinned
    // above). A migration must normalize ONE way for both surfaces.
    expect(isoRes.data!.createdAt).toBe('2026-10-01T00:00:00.000Z' as never);
    expect(isoRes.data!.id).toBe('p-iso');
  });

  it('getPublicProducts: filters isActive==true ONLY (no category filter), missing timestamps stay undefined', async () => {
    mockState.products.set('pub-1', {
      name: 'A', price: 1, isActive: true, category: 'merch',
      createdAt: mockTs('2026-10-01T00:00:00.000Z'), updatedAt: mockTs('2026-10-01T00:00:00.000Z'),
    });
    mockState.products.set('pub-2', { name: 'B', price: 2, isActive: false, category: 'merch' });
    mockState.products.set('pub-3', { name: 'C', price: 3, isActive: true, category: 'event_ticket' });
    const res = await getPublicProducts();
    expect(res.success).toBe(true);
    expect(res.data!.map((p) => p.id)).toEqual(['pub-1', 'pub-3']);
    expect(res.data![0].createdAt).toBe('2026-10-01T00:00:00.000Z' as never);
    expect(res.data![1].createdAt).toBeUndefined();
  });
});

describe('contract ONLY (do not migrate): actions/store syncEventToProduct payload', () => {
  const eventData = {
    id: 'ev-1', title: 'Space Talk', description: 'Desc', amountInput: '1500',
    currency: 'PKR', isPaid: true, imageUrl: 'https://img.example/x.png', capacity: '40',
  };

  it('create path: add() with the exact payload + createdAt serverTimestamp; category is "event_ticket" (UNDERSCORE)', async () => {
    const res = await syncEventToProduct(eventData);
    expect(res).toEqual({ success: true, id: 'prod-new-1' });
    const stored = mockState.products.get('prod-new-1')!;
    expect(stored).toEqual({
      name: 'Space Talk',
      description: 'Desc',
      price: 1500, // parseFloat(amountInput)
      currency: 'PKR',
      category: 'event_ticket',
      eventId: 'ev-1',
      isActive: true, // !!isPaid
      imageUrl: 'https://img.example/x.png',
      updatedAt: { __serverTimestamp: true },
      stock: 40, // parseInt(capacity)
      createdAt: { __serverTimestamp: true },
    });
  });

  it('update path: existingProductId updates WITHOUT createdAt; "none" means create; slug is the eventId fallback; unpaid => isActive false; bad price => 0; no capacity => stock 999', async () => {
    mockState.products.set('p-existing', { name: 'Old' });
    const upd = await syncEventToProduct(eventData, 'p-existing');
    expect(upd).toEqual({ success: true, id: 'p-existing' });
    expect(mockState.products.get('p-existing')!.name).toBe('Space Talk');
    expect(mockState.products.get('p-existing')!.createdAt).toBeUndefined();

    const created = await syncEventToProduct(
      { slug: 'ev-slug', title: 'Free', amountInput: 'abc', isPaid: false, image: 'https://img.example/y.png' },
      'none',
    );
    expect(created.success).toBe(true);
    const stored = mockState.products.get('prod-new-1')!;
    expect(stored.eventId).toBe('ev-slug');
    expect(stored.price).toBe(0);
    expect(stored.isActive).toBe(false);
    expect(stored.stock).toBe(999);
    expect(stored.imageUrl).toBe('https://img.example/y.png'); // image fallback when imageUrl absent
    expect(stored.description).toBe('');
    expect(stored.currency).toBe('PKR');
  });
});


/* ------------------------------------------------------------------ */
/* settings/payment_methods — read shape shared by three consumers     */
/* Source shapes:                                                      */
/*  checkout/page.tsx ~L482: PaymentMethod {enabled,name,instructions, */
/*    iconUrl?}; PaymentMethodsSettings {methods: Record<string,       */
/*    PaymentMethod>, order: string[], testMode: boolean}              */
/*  certificate-settings.tsx: same shape + DEFAULTS (raast/easypaisa/  */
/*    sadapay, all enabled, testMode:true) merged over the doc         */
/*  destinations/route.ts storeView: strips destinationMeta out of    */
/*    `active`, returns it separately                                  */
/* ------------------------------------------------------------------ */

const PAYMENT_METHODS_DOC = {
  methods: {
    raast: { enabled: false, name: 'Raast Transfer', instructions: 'IBAN …', iconUrl: '/assets/payments/raast.png' },
    easypaisa: { enabled: true, name: 'Easypaisa QR', instructions: 'Wallet …' },
  },
  order: ['raast', 'easypaisa'],
  testMode: false,
  destinationMeta: { updatedBy: 'maker-1', approvalId: 'appr-1' },
};

describe('contract: settings/payment_methods read shape', () => {
  it('checkout selection replica: auto-selects the FIRST ENABLED method in `order`; doc fields consumed are exactly methods/order/testMode', () => {
    const data = PAYMENT_METHODS_DOC;
    const methods = data.methods as Record<string, { enabled: boolean; name: string; instructions: string; iconUrl?: string }>;
    const firstEnabledKey = (data.order || []).find((k) => methods?.[k]?.enabled);
    expect(firstEnabledKey).toBe('easypaisa'); // raast is first but disabled
    const enabled = data.order.map((k) => ({ key: k, ...methods[k] })).filter((m) => m.enabled);
    expect(enabled).toHaveLength(1);
    expect(enabled[0].name).toBe('Easypaisa QR');
    expect(enabled[0].iconUrl).toBeUndefined(); // iconUrl is optional
  });

  it('destinations view replica: destinationMeta is SPLIT OUT of active, never inside it', () => {
    const { destinationMeta, ...active } = PAYMENT_METHODS_DOC as Record<string, unknown>;
    expect(active).toEqual({
      methods: PAYMENT_METHODS_DOC.methods,
      order: PAYMENT_METHODS_DOC.order,
      testMode: false,
    });
    expect(destinationMeta).toEqual({ updatedBy: 'maker-1', approvalId: 'appr-1' });
    // A missing document yields active:null + destinationMeta:null in the
    // destinations view (storeView: data ?? null) — pinned here as shape.
    const missing: Record<string, unknown> | null = null;
    expect(missing ?? null).toBeNull();
  });

  it('missing-doc divergence: checkout keeps methodSettings=null ("No Payment Methods") while certificate settings fall back to its DEFAULTS', () => {
    // Replica of certificate-settings merge (loadMethods): defaults first,
    // doc wins per-method, order/testMode fall back when absent.
    const CERT_DEFAULTS = {
      methods: {
        raast: { enabled: true, name: 'Raast Transfer', instructions: 'd-raast', iconUrl: '/assets/payments/raast.png' },
        easypaisa: { enabled: true, name: 'Easypaisa QR', instructions: 'd-easy', iconUrl: '/assets/payments/easypaisa.png' },
        sadapay: { enabled: true, name: 'SadaPay Transfer', instructions: 'd-sada', iconUrl: '/assets/payments/sadapay.png' },
      },
      order: ['raast', 'easypaisa', 'sadapay'],
      testMode: true,
    };
    const mergeCert = (data: any) => ({
      ...CERT_DEFAULTS,
      ...data,
      methods: { ...CERT_DEFAULTS.methods, ...(data.methods || {}) },
      order: data.order || CERT_DEFAULTS.order,
      testMode: data.testMode ?? CERT_DEFAULTS.testMode,
    });
    // Partial doc: one method overridden, the rest default; testMode false wins over default true.
    const merged = mergeCert({ methods: { easypaisa: { enabled: false, name: 'E2', instructions: 'x' } }, testMode: false });
    expect(merged.methods.raast.enabled).toBe(true);
    expect(merged.methods.easypaisa.enabled).toBe(false);
    expect(merged.methods.sadapay.name).toBe('SadaPay Transfer');
    expect(merged.order).toEqual(['raast', 'easypaisa', 'sadapay']);
    expect(merged.testMode).toBe(false);
    // Checkout has NO such defaults: a missing doc leaves state null.
    const checkoutState: unknown = null; // setMethodSettings is only called when snap.exists()
    expect(checkoutState).toBeNull();
  });

  it('MANUAL-LIST: the destinations route exports GET only — there is deliberately no write route for payment_methods (CH-10)', async () => {
    const route = await import('@/app/api/admin/finance/destinations/route');
    expect(typeof route.GET).toBe('function');
    expect((route as any).POST).toBeUndefined();
    expect((route as any).PUT).toBeUndefined();
    expect((route as any).DELETE).toBeUndefined();
    expect((route as any).PATCH).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* SPEC-REPLICA: adapter seam + flag (re-point at src/lib/supa when    */
/* the implementer seams land; seam names verified via git show on    */
/* feat/supa-adapter: createSupaAdapter(client) -> { getDoc, listDocs, */
/* countDocs, setDoc, updateDoc, deleteDoc }, useSupa(surface),        */
/* rows { id, data } in fs_<collection> tables)                        */
/* ------------------------------------------------------------------ */

type SupaRow = { id: string; data: Record<string, any> };

function makeFakeAdapter(tables: Record<string, SupaRow[]> | null, opts: { fail?: boolean } = {}) {
  // Mirrors the adapter contract: null client => every op throws
  // (SupaUnavailableError on the real branch); error => throws
  // (SupaAdapterError). Callers must catch and fall back to Firestore.
  const requireRows = (collection: string): SupaRow[] => {
    if (tables === null) throw new Error('SupaUnavailableError (replica)');
    if (opts.fail) throw new Error('SupaAdapterError: query-failed (replica)');
    return tables[`fs_${collection}`] ?? [];
  };
  return {
    async getDoc(collection: string, id: string) {
      const row = requireRows(collection).find((r) => r.id === id);
      return row ? { id: row.id, ...row.data } : null;
    },
    async listDocs(collection: string, options: { where?: Array<[string, string, unknown]>; limit?: number } = {}) {
      let rows = requireRows(collection);
      for (const [f, , v] of options.where ?? []) rows = rows.filter((r) => r.data[f] === v);
      if (options.limit != null) rows = rows.slice(0, options.limit);
      return rows.map((r) => ({ id: r.id, ...r.data }));
    },
    async countDocs(collection: string) {
      return requireRows(collection).length;
    },
  };
}

function useSupaReplica(surface: string, rawEnv: string | undefined): boolean {
  // Verbatim semantics of adapter flags.ts (feat/supa-adapter).
  if (!rawEnv) return false;
  const surfaces = new Set(rawEnv.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (surfaces.size === 0) return false;
  if (surfaces.has('*')) return true;
  return surfaces.has(surface.trim().toLowerCase());
}

// Verbatim serializer from the products/orders routes.
const routeProductSerializer = (id: string, data: any) => ({
  id,
  ...data,
  createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
  updatedAt: data.updatedAt?.toDate?.()?.toISOString() || null,
});
// Verbatim serializer from getPublicProducts (actions/store.ts).
const publicProductSerializer = (id: string, data: any) => ({
  ...data,
  id,
  createdAt: data.createdAt?.toDate?.()?.toISOString() || data.createdAt,
  updatedAt: data.updatedAt?.toDate?.()?.toISOString() || data.updatedAt,
});

describe('contract (SPEC-REPLICA): useSupa flag semantics for store surfaces', () => {
  it('default OFF: unset, empty, and unrelated surfaces are all OFF', () => {
    expect(useSupaReplica('store', undefined)).toBe(false);
    expect(useSupaReplica('store', '')).toBe(false);
    expect(useSupaReplica('store', 'announcements,directory')).toBe(false);
  });

  it('ON only for a listed surface (case-insensitive, whitespace-tolerant) or "*"', () => {
    expect(useSupaReplica('store', 'store')).toBe(true);
    expect(useSupaReplica('store', ' announcements , STORE ')).toBe(true);
    expect(useSupaReplica('anything', '*')).toBe(true);
  });
});

describe('contract (SPEC-REPLICA): adapter rows map to byte-identical public shapes', () => {
  const fsTables: Record<string, SupaRow[]> = {
    fs_products: [
      {
        id: 'p-1',
        data: {
          name: 'Ticket', price: 500, isActive: true, category: 'event-ticket',
          createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
        },
      },
      { id: 'p-2', data: { name: 'Off', price: 1, isActive: false, category: 'merch', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' } },
    ],
    fs_settings: [{ id: 'payment_methods', data: PAYMENT_METHODS_DOC }],
    fs_orders: [{ id: 'o-1', data: { total: 5 } }],
  };

  it('flag ON: listDocs over fs_products rows {id,data} + the public serializer equals the Firestore public shape byte-for-byte', async () => {
    const adapter = makeFakeAdapter(fsTables);
    const supaDocs = await adapter.listDocs('products', { where: [['isActive', '==', true]] });
    const supaPublic = supaDocs.map((d: any) => publicProductSerializer(d.id, d));
    // Firestore equivalent (getPublicProducts over a Timestamp doc):
    const fsPublic = [publicProductSerializer('p-1', {
      name: 'Ticket', price: 500, isActive: true, category: 'event-ticket',
      createdAt: mockTs('2026-09-01T00:00:00.000Z'), updatedAt: mockTs('2026-09-01T00:00:00.000Z'),
    })];
    expect(supaPublic).toEqual(fsPublic);
    // Shape-identical, NOT raw-string-identical: the adapter returns
    // { id, ...data } (id first) while getPublicProducts builds
    // { ...data, id, createdAt, updatedAt } (id after data). JSON object
    // key order is not semantic, but anyone diffing raw response bytes
    // will see it — recorded here so it is a known cosmetic delta, not
    // a surprise.
    expect(Object.keys(supaPublic[0]).sort()).toEqual(Object.keys(fsPublic[0]).sort());
  });

  it('TIMESTAMP GAP (documented): the ROUTE serializer nulls jsonb ISO strings — the implementer must normalize ISO strings at the seam, or routes lose every timestamp', async () => {
    const adapter = makeFakeAdapter(fsTables);
    const doc = (await adapter.getDoc('products', 'p-1')) as any;
    const viaRoute = routeProductSerializer(doc!.id, doc);
    expect(viaRoute.createdAt).toBeNull(); // NOT byte-identical — the gap
    // The required seam behavior that WOULD be byte-identical: present the
    // route with a Date-like value (or ISO passthrough serializer):
    const normalized = routeProductSerializer(doc!.id, {
      ...doc, createdAt: mockTs(doc!.createdAt), updatedAt: mockTs(doc!.updatedAt),
    });
    expect(normalized.createdAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('flag ON + getDoc(settings, payment_methods) returns { id, ...data } with the exact checkout shape', async () => {
    const adapter = makeFakeAdapter(fsTables);
    const doc = await adapter.getDoc('settings', 'payment_methods');
    expect(doc).toEqual({ id: 'payment_methods', ...PAYMENT_METHODS_DOC });
    expect(await adapter.countDocs('orders')).toBe(1);
    expect(await adapter.getDoc('products', 'ghost')).toBeNull();
  });

  it('flag OFF, null client, and adapter error ALL fall back to the Firestore shape (caller-side replica of the gated read)', async () => {
    const firestorePublic = [publicProductSerializer('p-fs', {
      name: 'FS', price: 1, isActive: true,
      createdAt: mockTs('2026-09-01T00:00:00.000Z'), updatedAt: mockTs('2026-09-01T00:00:00.000Z'),
    })];
    async function gatedRead(env: string | undefined, adapter: ReturnType<typeof makeFakeAdapter>) {
      if (useSupaReplica('store', env)) {
        try {
          const docs = await adapter.listDocs('products', { where: [['isActive', '==', true]] });
          return docs.map((d: any) => publicProductSerializer(d.id, d));
        } catch {
          return firestorePublic; // adapter error => fallback
        }
      }
      return firestorePublic; // flag OFF / null client => Firestore
    }
    await expect(gatedRead(undefined, makeFakeAdapter(fsTables))).resolves.toEqual(firestorePublic);
    await expect(gatedRead('store', makeFakeAdapter(null))).resolves.toEqual(firestorePublic);
    await expect(gatedRead('store', makeFakeAdapter(fsTables, { fail: true }))).resolves.toEqual(firestorePublic);
    // …and the ON happy path returns the Supabase rows, not the fallback:
    const on = await gatedRead('store', makeFakeAdapter(fsTables));
    expect(on.map((p: any) => p.id)).toEqual(['p-1']);
  });
});

/* ------------------------------------------------------------------ */
/* KNOWN DEFECT — Linked Store Product dropdown (faithful migration)   */
/*                                                                     */
/* event-form.tsx (verbatim logic):                                    */
/*   query(products, where('isActive','==',true))                      */
/*   .filter(p => p.category === 'event-ticket' || p.category ===     */
/*             'event')                                                */
/* Producers write a DIFFERENT spelling:                               */
/*   syncEventToProduct: category 'event_ticket' (underscore)          */
/*   createOrder auto-create stub: category 'event_ticket'             */
/*   products POST: free-form, default 'other'                         */
/* Result (matches the live EV-P07 finding): event-ticket products     */
/* created by the sync/auto-create paths NEVER appear in the dropdown; */
/* only the literal "None (Free Event)" option shows. A faithful       */
/* migration reproduces this exactly; fixing the spelling is a        */
/* separate, decided change — NOT part of the data migration.          */
/* ------------------------------------------------------------------ */

// Replica of the event-form dropdown filter (the query + in-memory filter).
function eventDropdownProducts(allProducts: Array<Record<string, any>>) {
  return allProducts
    .filter((p) => p.isActive === true)
    .filter((p) => p.category === 'event-ticket' || p.category === 'event');
}

describe('KNOWN DEFECT (faithful migration, do not fix here): Linked Store Product dropdown filter', () => {
  it('a product with category "event-ticket" (hyphen) IS offered; "event" IS offered; merch is not', () => {
    const offered = eventDropdownProducts([
      { id: 'a', isActive: true, category: 'event-ticket', name: 'A', price: 1, currency: 'PKR' },
      { id: 'b', isActive: true, category: 'event', name: 'B', price: 1, currency: 'PKR' },
      { id: 'c', isActive: true, category: 'merch', name: 'C', price: 1, currency: 'PKR' },
    ]);
    expect(offered.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('KNOWN DEFECT: a product written by syncEventToProduct (category "event_ticket", underscore) is NOT offered — dropdown shows only None', async () => {
    const res = await syncEventToProduct({
      id: 'ev-9', title: 'Paid Talk', amountInput: '2000', currency: 'PKR', isPaid: true,
    });
    expect(res.success).toBe(true);
    const synced = mockState.products.get(res.id!)!;
    expect(synced.category).toBe('event_ticket');
    expect(synced.isActive).toBe(true);
    const offered = eventDropdownProducts(
      [...mockState.products.entries()].map(([id, data]) => ({ id, ...data })),
    );
    expect(offered).toEqual([]); // the defect, characterized
  });

  it('inactive products are excluded even with the hyphenated category (isActive query runs first)', () => {
    expect(eventDropdownProducts([{ id: 'x', isActive: false, category: 'event-ticket' }])).toEqual([]);
  });

  it.skip('FUTURE FIX (not this migration): "event_ticket" products should be offered by the dropdown — skipped until a decided fix unifies the category spelling', () => {
    const offered = eventDropdownProducts([{ id: 'x', isActive: true, category: 'event_ticket' }]);
    expect(offered).toHaveLength(1);
  });
});
