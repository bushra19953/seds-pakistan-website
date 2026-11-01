/**
 * @jest-environment node
 *
 * GE Writer B (PLAN-ge 11.3): POST /api/store/orders vendor branch on
 * both legs, same matrix as Writer A, asserting the route envelopes
 * (422 for vendor rejections, { ok: true, orderId } on success).
 * Firestore leg runs on the shared fake; the primacy leg runs the real
 * store-orders seam over a mocked Supabase adapter whose tx mirrors
 * the amended tx_store_order_create (goods + p_delivery_pkr).
 */
import { NextRequest } from 'next/server';
import { createFakeDb, type FakeDb } from '@/lib/server/__tests__/fake-firestore';

const mockState = {
  primary: false,
  settings: null as any,
  supaProducts: new Map<string, Record<string, any>>(),
  supaVendors: new Map<string, Record<string, any>>(),
  supaOrders: new Map<string, Record<string, any>>(),
  txCalls: [] as Array<[string, any]>,
  txFails: false,
};

const dbHolder: { db: FakeDb | null } = { db: null };

function patchFake(db: FakeDb): FakeDb {
  const orig = db.collection.bind(db);
  (db as any).collection = (name: string) => {
    const col: any = orig(name);
    if (typeof col.add !== 'function') {
      col.add = async (data: any) => {
        const ref = col.doc();
        await ref.set(data);
        return ref;
      };
    }
    return col;
  };
  const origRun = db.runTransaction.bind(db);
  (db as any).runTransaction = (fn: (t: any) => Promise<any>) =>
    origRun((t: any) => fn({
      ...t,
      delete: (ref: any) => { (db as any).store.get(ref.collectionPath)?.delete(ref.id); },
    }));
  return db;
}

function fakeTx(fn: string, args: any) {
  mockState.txCalls.push([fn, args]);
  if (mockState.txFails) throw new Error('tx boom');
  if (fn !== 'tx_store_order_create') throw new Error(`unexpected tx: ${fn}`);
  const key = args.p_idempotency_key as string | undefined;
  if (key != null) {
    for (const [id, data] of mockState.supaOrders) {
      if (data.buyerUserId === args.p_data.buyerUserId && data.idempotencyKey === key) {
        return { ok: true, created: false, orderId: id };
      }
    }
  }
  if (!args.p_is_donation) {
    const lines = Array.isArray(args.p_items) && args.p_items.length > 0
      ? args.p_items
      : [{ productId: args.p_product_id, quantity: args.p_quantity ?? 1 }];
    let total = 0;
    for (const line of lines) {
      const product = mockState.supaProducts.get(line.productId);
      if (!product || typeof product.price !== 'number') {
        return { ok: false, httpStatus: 422, message: 'Price verification failed: product is missing, inactive, or has no server-side price' };
      }
      total += product.price * (line.quantity ?? 1);
    }
    // GE amendment: delivery joins the verified total before the claim check.
    total += args.p_delivery_pkr ?? 0;
    if (args.p_claimed !== total) {
      return { ok: false, httpStatus: 422, message: 'Price verification failed: claimed amount does not match the server price' };
    }
    const data = {
      ...args.p_data,
      totalPkr: total, total,
      ...(key != null ? { idempotencyKey: key } : {}),
    };
    mockState.supaOrders.set(args.p_id, data);
    return { ok: true, created: true, orderId: args.p_id };
  }
  mockState.supaOrders.set(args.p_id, { ...args.p_data });
  return { ok: true, created: true, orderId: args.p_id };
}

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    auth: () => ({ verifyIdToken: async () => ({ uid: 'u1' }) }),
    firestore: {
      Timestamp: {
        now: () => {
          const d = new Date('2026-03-01T00:00:00.000Z');
          return { toDate: () => d, toMillis: () => d.getTime() };
        },
        fromMillis: (ms: number) => {
          const d = new Date(ms);
          return { toDate: () => d, toMillis: () => ms };
        },
      },
    },
  },
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => dbHolder.db),
  ensureAdminInitialized: jest.fn(() => true),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => true),
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    broadcastByRoles: jest.fn(async () => {}),
    send: jest.fn(async () => {}),
  },
}));

jest.mock('@/app/actions/payment-methods', () => ({
  getPaymentMethodsSettings: jest.fn(async () => mockState.settings),
}));

jest.mock('@/lib/supa', () => ({
  useSupa: jest.fn(() => mockState.primary),
  isSupaPrimary: jest.fn(() => mockState.primary),
  getSupaClient: jest.fn(() => ({})),
  getSupaAdapter: jest.fn(() => ({
    getDoc: jest.fn(async (collection: string, id: string) => {
      if (collection === 'vendors') {
        const vendor = mockState.supaVendors.get(id);
        return vendor ? { id, ...vendor } : null;
      }
      if (collection !== 'products') return null;
      const found = mockState.supaProducts.get(id);
      return found ? { id, ...found } : null;
    }),
    listDocs: jest.fn(async () => []),
    tx: jest.fn(async (fn: string, args: any, opts: any) => {
      const finalArgs = opts?.idempotencyKey !== undefined
        ? { ...args, p_idempotency_key: opts.idempotencyKey }
        : args;
      return fakeTx(fn, finalArgs);
    }),
    rpc: jest.fn(async (fn: string, args: any) => fakeTx(fn, args)),
  })),
}));

/* GH seat contract (PLAN-gh Section 4), emulated over the same fake db. */
jest.mock('@/lib/server/group-buys', () => {
  const err = (code: string) => Object.assign(new Error(code), { code });
  const registerInTx = async (t: any, teamRef: any, input: any) => {
    const snap = await t.get(teamRef);
    if (!snap.exists) throw err('TEAM_NOT_FOUND');
    const team = snap.data();
    if ((team.memberOrderIds || []).includes(input.orderId)) {
      return { outcome: 'already_registered', state: team.state, seatsFilled: team.memberOrderIds.length, teamSizeTarget: team.teamSizeTarget, unitPricePkr: team.unitPricePkr };
    }
    if (team.state !== 'open') throw err('TEAM_NOT_OPEN');
    if (team.productId !== input.productId) throw err('PRODUCT_MISMATCH');
    if ((team.memberUserIds || []).includes(input.userId)) throw err('ALREADY_SEATED');
    if ((team.memberOrderIds || []).length >= team.teamSizeTarget) throw err('TEAM_FULL');
    const memberOrderIds = [...(team.memberOrderIds || []), input.orderId];
    const memberUserIds = [...(team.memberUserIds || []), input.userId];
    t.update(teamRef, {
      memberOrderIds, memberUserIds,
      state: memberOrderIds.length >= team.teamSizeTarget ? 'filled' : team.state,
    });
    return { outcome: 'registered', state: team.state, seatsFilled: memberOrderIds.length, teamSizeTarget: team.teamSizeTarget, unitPricePkr: team.unitPricePkr };
  };
  return {
    assertGroupBuySeatAvailable: jest.fn(async (db: any, input: any) => {
      const snap = await db.collection('group_buys').doc(input.groupBuyId).get();
      if (!snap.exists) throw err('TEAM_NOT_FOUND');
      const team = snap.data();
      if (team.state !== 'open' || (team.expiresAtMs && team.expiresAtMs <= Date.now())) throw err('TEAM_EXPIRED');
      if (team.productId !== input.productId) throw err('PRODUCT_MISMATCH');
      if ((team.memberOrderIds || []).length >= team.teamSizeTarget) throw err('TEAM_FULL');
      return {
        unitPricePkr: team.unitPricePkr, teamSizeTarget: team.teamSizeTarget,
        seatsFilled: (team.memberOrderIds || []).length,
        expiresAt: new Date(team.expiresAtMs || Date.now()).toISOString(),
      };
    }),
    registerGroupBuySeatTx: jest.fn(registerInTx),
    registerGroupBuySeat: jest.fn(async (db: any, input: any) =>
      db.runTransaction((t: any) => registerInTx(t, db.collection('group_buys').doc(input.groupBuyId), input)),
    ),
    releaseGroupBuySeat: jest.fn(async (db: any, input: any) =>
      db.runTransaction(async (t: any) => {
        const ref = db.collection('group_buys').doc(input.groupBuyId);
        const snap = await t.get(ref);
        if (!snap.exists) return { outcome: 'not_seated', state: 'open' };
        const team = snap.data();
        const idx = (team.memberOrderIds || []).indexOf(input.orderId);
        if (idx === -1) return { outcome: 'not_seated', state: team.state };
        const memberOrderIds = [...team.memberOrderIds];
        const memberUserIds = [...team.memberUserIds];
        memberOrderIds.splice(idx, 1);
        memberUserIds.splice(idx, 1);
        t.update(ref, { memberOrderIds, memberUserIds });
        return { outcome: 'released', state: team.state };
      }),
    ),
  };
});

import { POST } from '@/app/api/store/orders/route';

const SHOP_SETTINGS = {
  methods: {
    shop: { enabled: true, name: 'Shop Account', instructions: 'Company account details' },
    raast: { enabled: true, name: 'Raast Transfer', instructions: 'Society account details' },
  },
  order: ['shop', 'raast'],
  testMode: false,
  shopMethodKey: 'shop',
};

const VENDOR_PRODUCT = {
  name: 'Relay Module', price: 1000, currency: 'PKR', isActive: true,
  vendorId: 'v1', deliveryChargePkr: 200, deliveryPromiseDays: 5, stock: 3,
};

function req(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/store/orders', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const vendorBody = (extra: Record<string, any> = {}) => ({
  amount: 1200,
  currency: 'PKR',
  paymentMethod: 'shop',
  productId: 'vp1',
  items: [{ productId: 'vp1', quantity: 1 }],
  buyer: { fullName: 'Buyer One' },
  originatingModule: 'store',
  ...extra,
});

beforeEach(() => {
  mockState.primary = false;
  mockState.settings = SHOP_SETTINGS;
  mockState.supaProducts = new Map([['vp1', { ...VENDOR_PRODUCT }]]);
  mockState.supaVendors = new Map([['v1', { status: 'active', agreementStatus: 'signed' }]]);
  mockState.supaOrders = new Map();
  mockState.txCalls = [];
  mockState.txFails = false;
  dbHolder.db = patchFake(createFakeDb());
  dbHolder.db.seed('products', 'vp1', { ...VENDOR_PRODUCT });
  // Creation-time sellability re-check (audit fix): fixture vendor must
  // be active with a signed agreement on BOTH read paths.
  dbHolder.db.seed('vendors', 'v1', { status: 'active', agreementStatus: 'signed' });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('POST vendor branch, Firestore leg', () => {
  it('O1 happy path: 200 envelope, exact vendor field set, top-level productId stamped', async () => {
    const res = await POST(req(vendorBody(), { 'idempotency-key': 'rk-1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const orders = dbHolder.db!.all('orders');
    expect(orders).toHaveLength(1);
    expect(orders[0].id).toBe(body.orderId);
    const order = orders[0].data;
    expect(order).toMatchObject({
      vendorId: 'v1', subtotalPkr: 1000, deliveryPkr: 200, totalPkr: 1200, total: 1200,
      paymentMethod: 'shop', productId: 'vp1', groupBuyId: null, escrowStatus: 'none',
      creditAppliedPkr: 0, notFoundText: null, status: 'pending_verification',
    });
  });

  it('a body-sent notFoundText and vendorId are NOT stored at creation', async () => {
    const res = await POST(req(vendorBody({ notFoundText: 'forged', vendorId: 'FORGED', escrowStatus: 'released' }), { 'idempotency-key': 'rk-2' }));
    expect(res.status).toBe(200);
    const order = dbHolder.db!.all('orders')[0].data;
    expect(order.notFoundText).toBeNull();
    expect(order.vendorId).toBe('v1');
    expect(order.escrowStatus).toBe('none');
  });

  it('O3: stock 0 is a 422 with the out-of-stock message and no order', async () => {
    dbHolder.db!.seed('products', 'vp1', { ...VENDOR_PRODUCT, stock: 0 });
    const res = await POST(req(vendorBody(), { 'idempotency-key': 'rk-3' }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('This product is out of stock and cannot be ordered right now.');
    expect(dbHolder.db!.all('orders')).toHaveLength(0);
  });

  it('audit fix: a paused vendor is a 422 at creation and writes no order', async () => {
    dbHolder.db!.seed('vendors', 'v1', { status: 'paused', agreementStatus: 'signed' });
    const res = await POST(req(vendorBody(), { 'idempotency-key': 'rk-paused' }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('The seller for this product is not currently selling. Order rejected.');
    expect(dbHolder.db!.all('orders')).toHaveLength(0);
  });

  it('tamper: a goods-only claim is a 422', async () => {
    const res = await POST(req(vendorBody({ amount: 1000 }), { 'idempotency-key': 'rk-4' }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('Price tampering detected.');
    expect(dbHolder.db!.all('orders')).toHaveLength(0);
  });

  it('group: locked price prices the order and the seat registers atomically', async () => {
    dbHolder.db!.seed('group_buys', 'g1', {
      productId: 'vp1', state: 'open', unitPricePkr: 900, teamSizeTarget: 2,
      memberOrderIds: [], memberUserIds: [], expiresAtMs: Date.now() + 3600000,
    });
    const res = await POST(req(vendorBody({ amount: 1100, groupBuyId: 'g1' }), { 'idempotency-key': 'rk-5' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const order = dbHolder.db!.all('orders')[0].data;
    expect(order.subtotalPkr).toBe(900);
    expect(order.totalPkr).toBe(1100);
    expect(order.escrowStatus).toBe('held');
    expect(dbHolder.db!.read('group_buys', 'g1')!.memberOrderIds).toEqual([body.orderId]);
  });
});

describe('POST vendor branch, primacy leg', () => {
  beforeEach(() => { mockState.primary = true; });

  it('delivery reaches the tx as p_delivery_pkr and the pre-minted orderId is passed through', async () => {
    const res = await POST(req(vendorBody(), { 'idempotency-key': 'pk-1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mockState.txCalls).toHaveLength(1);
    const args = mockState.txCalls[0][1];
    expect(args.p_delivery_pkr).toBe(200);
    expect(args.p_id).toBe(body.orderId);
    const order = mockState.supaOrders.get(body.orderId);
    expect(order).toMatchObject({ vendorId: 'v1', deliveryPkr: 200, totalPkr: 1200 });
    expect(dbHolder.db!.all('orders')).toHaveLength(0);
  });

  it('O3 on the primacy leg: stock 0 rejects before any tx call', async () => {
    mockState.supaProducts.set('vp1', { ...VENDOR_PRODUCT, stock: 0 });
    const res = await POST(req(vendorBody(), { 'idempotency-key': 'pk-2' }));
    expect(res.status).toBe(422);
    expect(mockState.txCalls).toHaveLength(0);
  });

  it('compensation: a tx failure restores claimed credits', async () => {
    const future = new Date(Date.now() + 30 * 86400000);
    dbHolder.db!.seed('store_credits', 'c1', {
      userId: 'u1', state: 'available', amountPkr: 300,
      createdAt: new Date(Date.now() - 1000), expiresAt: future, consumedOrderId: null, code: 'LATE-C1',
    });
    mockState.txFails = true;
    const res = await POST(req(vendorBody(), { 'idempotency-key': 'pk-3' }));
    expect(res.status).toBe(500);
    expect(dbHolder.db!.read('store_credits', 'c1')).toMatchObject({ state: 'available', consumedOrderId: null });
    expect(dbHolder.db!.all('store_credit_claims')).toHaveLength(0);
  });
});

describe('POST house regression (O2)', () => {
  it('certificate-style body stores an order deep-equal to the base literal (no vendor keys, no productId key)', async () => {
    dbHolder.db!.seed('products', 'cp1', { name: 'Certificate', price: 500, currency: 'PKR', isActive: true });
    const res = await POST(req({
      amount: 500, currency: 'PKR', paymentMethod: 'manual',
      items: [{ productId: 'cp1', quantity: 1 }],
      buyer: { fullName: 'Buyer One' }, certificateCode: 'CERT-1', holderUserId: 'u1',
      originatingModule: 'Certificates',
    }, { 'idempotency-key': 'hk-1' }));
    expect(res.status).toBe(200);
    const order = dbHolder.db!.all('orders')[0].data;
    expect(Object.keys(order).sort()).toEqual([
      'amount', 'buyer', 'buyerUserId', 'certificateCode', 'createdAt', 'currency',
      'declaredAmountPkr', 'holderUserId', 'isDeleted', 'items', 'originatingModule',
      'paymentMethod', 'paymentStatus', 'receiptDriveId', 'receiptUrl', 'status',
      'testMode', 'total', 'totalPkr', 'updatedAt', 'userId',
    ]);
    expect(order.totalPkr).toBe(500);
    expect(order.certificateCode).toBe('CERT-1');
  });
});
