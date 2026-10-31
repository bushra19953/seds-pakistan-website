/**
 * @jest-environment node
 *
 * GE Writer A (PLAN-ge 11.2): createOrder vendor branch on both legs,
 * mapped to O1 (happy path), O3 (stock 0), A2 (not-found answer), and
 * the house regressions of O2. The Firestore leg runs against the
 * shared fake; GH's seat lib and GA's credit list are mocked at the
 * module boundary with the exact contract signatures (PLAN-gh
 * Section 4, GA vendor-shop.ts), and the primacy seam is mocked with
 * an insert-verbatim tx, matching tx_store_create_order's real shape.
 */
import { createFakeDb, type FakeDb } from '@/lib/server/__tests__/fake-firestore';

const mockState = {
  primary: false,
  settings: null as any,
  supaProducts: new Map<string, Record<string, any>>(),
  supaOrders: new Map<string, Record<string, any>>(),
  txFails: false,
};

const dbHolder: { db: FakeDb | null } = { db: null };

/** FakeDb lacks collection.add and transaction delete at base (GA's
 *  harness amendment lands with GA); patch both per instance the way
 *  other suites patch the fake. */
function patchAdd(db: FakeDb): FakeDb {
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

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => ({ __serverTimestamp: true, toMillis: () => Date.now() }),
  },
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(async () => dbHolder.db),
}));

jest.mock('@/lib/supa/store-actions', () => ({
  storeActionsPrimaryEnabled: jest.fn(() => mockState.primary),
  getProductFromSupa: jest.fn(async () => null),
  listPublicProductsFromSupa: jest.fn(async () => null),
  syncEventProductViaPrimary: jest.fn(async () => null),
  getStoreOrderFromSupa: jest.fn(async () => null),
  updateOrderNotFoundViaPrimary: jest.fn(async () => null),
  getStoreProductForVerification: jest.fn(async (pid: string) => {
    if (!mockState.primary) return null;
    const found = mockState.supaProducts.get(pid);
    if (!found) return { found: false };
    return { found: true, ...found };
  }),
  createOrderViaStorePrimary: jest.fn(async (args: any) => {
    if (mockState.txFails) throw new Error('tx failed');
    const key = args.idempotencyKey as string | null;
    if (key != null) {
      for (const [id, data] of mockState.supaOrders) {
        if (data.buyerUserId === args.orderData.buyerUserId && data.idempotencyKey === key) {
          return { ok: true, created: false, orderId: id };
        }
      }
    }
    // tx_store_create_order inserts p_order_data verbatim (no reprice).
    mockState.supaOrders.set(args.orderId, {
      ...args.orderData,
      ...(key != null ? { idempotencyKey: key } : {}),
    });
    return { ok: true, created: true, orderId: args.orderId };
  }),
}));

jest.mock('@/app/actions/payment-methods', () => ({
  getPaymentMethodsSettings: jest.fn(async () => mockState.settings),
}));

jest.mock('@/lib/supa/store-primary', () => ({
  makeStoreDocId: jest.fn(() => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 20; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
    return id;
  }),
  toSupaStorePayload: jest.fn((value: any) => value),
}));

jest.mock('@/lib/applications-supa', () => ({
  mirrorChapterApplicationUpdate: jest.fn(async () => {}),
  updateChapterApplicationPrimaryFirst: jest.fn(async () => false),
}));

jest.mock('@/lib/server/vendor-shop', () => ({
  listAvailableCreditsForUser: jest.fn(async (db: any, userId: string) => {
    const snap = await db
      .collection('store_credits')
      .where('userId', '==', userId)
      .where('state', '==', 'available')
      .orderBy('createdAt', 'asc')
      .get();
    return snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  }),
}));

/* GH seat contract (PLAN-gh Section 4), emulated over the same fake db. */
jest.mock('@/lib/server/group-buys', () => {
  const err = (code: string) => Object.assign(new Error(code), { code });
  const readTeam = async (db: any, groupBuyId: string) => {
    const snap = await db.collection('group_buys').doc(groupBuyId).get();
    return snap.exists ? snap.data() : null;
  };
  const checkSeat = (team: any, userId: string, productId: string) => {
    if (!team) throw err('TEAM_NOT_FOUND');
    if (team.state !== 'open') throw err('TEAM_NOT_OPEN');
    if (team.expiresAtMs && team.expiresAtMs <= Date.now()) throw err('TEAM_EXPIRED');
    if (team.productId !== productId) throw err('PRODUCT_MISMATCH');
    if ((team.memberUserIds || []).includes(userId)) throw err('ALREADY_SEATED');
    if ((team.memberOrderIds || []).length >= team.teamSizeTarget) throw err('TEAM_FULL');
  };
  const registerInTx = async (t: any, teamRef: any, input: any) => {
    const snap = await t.get(teamRef);
    if (!snap.exists) throw err('TEAM_NOT_FOUND');
    const team = snap.data();
    if ((team.memberOrderIds || []).includes(input.orderId)) {
      return { outcome: 'already_registered', state: team.state, seatsFilled: team.memberOrderIds.length, teamSizeTarget: team.teamSizeTarget, unitPricePkr: team.unitPricePkr };
    }
    checkSeat(team, input.userId, input.productId);
    const memberOrderIds = [...(team.memberOrderIds || []), input.orderId];
    const memberUserIds = [...(team.memberUserIds || []), input.userId];
    t.update(teamRef, {
      memberOrderIds,
      memberUserIds,
      state: memberOrderIds.length >= team.teamSizeTarget ? 'filled' : team.state,
    });
    return { outcome: 'registered', state: team.state, seatsFilled: memberOrderIds.length, teamSizeTarget: team.teamSizeTarget, unitPricePkr: team.unitPricePkr };
  };
  return {
    assertGroupBuySeatAvailable: jest.fn(async (db: any, input: any) => {
      const team = await readTeam(db, input.groupBuyId);
      if (!team) throw err('TEAM_NOT_FOUND');
      if (team.state !== 'open' || (team.expiresAtMs && team.expiresAtMs <= Date.now())) throw err('TEAM_EXPIRED');
      if (team.productId !== input.productId) throw err('PRODUCT_MISMATCH');
      if ((team.memberOrderIds || []).length >= team.teamSizeTarget) throw err('TEAM_FULL');
      return {
        unitPricePkr: team.unitPricePkr,
        teamSizeTarget: team.teamSizeTarget,
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

import { createOrder, submitNotFoundText } from '@/app/actions/store';

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

const vendorInput = (extra: Record<string, any> = {}) => ({
  userId: 'u1',
  productId: 'vp1',
  items: [{ productId: 'vp1', productName: 'Relay Module', quantity: 1, price: 1000, subtotal: 1000 }],
  total: 1200,
  currency: 'PKR',
  paymentMethod: 'shop',
  originatingModule: 'store',
  proofOfPaymentUrl: 'https://example.test/receipt',
  buyer: { fullName: 'Buyer One', email: 'b@example.com', phone: '0300' },
  ...extra,
});

function seedBase(db: FakeDb) {
  db.seed('users', 'u1', {});
  db.seed('warningConfig', 'global', { enforcementEnabled: true });
  db.seed('settings', 'siteWide', { enableDonations: true });
  db.seed('products', 'vp1', { ...VENDOR_PRODUCT });
}

beforeEach(() => {
  mockState.primary = false;
  mockState.settings = SHOP_SETTINGS;
  mockState.supaProducts = new Map([['vp1', { ...VENDOR_PRODUCT }]]);
  mockState.supaOrders = new Map();
  mockState.txFails = false;
  dbHolder.db = patchAdd(createFakeDb());
  seedBase(dbHolder.db);
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const storedOrders = () => dbHolder.db!.all('orders');

describe('createOrder vendor branch, Firestore leg', () => {
  it('O1 happy path: exact vendor field set, shop payment method, pending_verification', async () => {
    const res = await createOrder(vendorInput({ idempotencyKey: 'k-happy' }));
    expect(res.success).toBe(true);
    const orders = storedOrders();
    expect(orders).toHaveLength(1);
    const order = orders[0].data;
    expect(order.status).toBe('pending_verification');
    expect(order.paymentMethod).toBe('shop');
    expect(order.vendorId).toBe('v1');
    expect(order.subtotalPkr).toBe(1000);
    expect(order.deliveryPkr).toBe(200);
    expect(order.totalPkr).toBe(1200);
    expect(order.total).toBe(1200);
    expect(order.promisedDeliveryDate).toBe(new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10));
    expect(order.groupBuyId).toBeNull();
    expect(order.escrowStatus).toBe('none');
    expect(order.creditAppliedPkr).toBe(0);
    expect(order.notFoundText).toBeNull();
    expect(order.courierName).toBeNull();
    expect(order.trackingNumber).toBeNull();
    expect(order.dispatchedAt).toBeNull();
    expect(order.deliveredAt).toBeNull();
    expect(order.fulfilmentNote).toBeNull();
    expect(order.commissionLedgerId).toBeNull();
    expect(order.payoutId).toBeNull();
  });

  it('forgery: client-sent spec fields never reach the stored order', async () => {
    const res = await createOrder(vendorInput({
      idempotencyKey: 'k-forge',
      vendorId: 'FORGED', creditAppliedPkr: 999, escrowStatus: 'released', deliveryPkr: 1,
    }));
    expect(res.success).toBe(true);
    const order = storedOrders()[0].data;
    expect(order.vendorId).toBe('v1');
    expect(order.creditAppliedPkr).toBe(0);
    expect(order.escrowStatus).toBe('none');
    expect(order.deliveryPkr).toBe(200);
  });

  it('tamper: a goods-only claim is rejected with the tampering message', async () => {
    const res = await createOrder(vendorInput({ total: 1000, idempotencyKey: 'k-tamper' }));
    expect(res).toEqual({ success: false, error: 'Security Error: Price tampering detected.' });
    expect(storedOrders()).toHaveLength(0);
  });

  it('O3: stock 0 rejects with the out-of-stock message and writes no order', async () => {
    dbHolder.db!.seed('products', 'vp1', { ...VENDOR_PRODUCT, stock: 0 });
    const res = await createOrder(vendorInput({ idempotencyKey: 'k-oos' }));
    expect(res).toEqual({ success: false, error: 'This product is out of stock and cannot be ordered right now.' });
    expect(storedOrders()).toHaveLength(0);
  });

  it('no shop method configured rejects loud; a society method is rejected', async () => {
    mockState.settings = { ...SHOP_SETTINGS, shopMethodKey: null };
    const unset = await createOrder(vendorInput({ idempotencyKey: 'k-unset' }));
    expect(unset.success).toBe(false);
    expect(unset.error).toContain('Vendor checkout blocked: no shop payment method is configured.');
    mockState.settings = SHOP_SETTINGS;
    const society = await createOrder(vendorInput({ idempotencyKey: 'k-soc', paymentMethod: 'raast' }));
    expect(society).toEqual({ success: false, error: 'This order must use the shop payment method shown at checkout.' });
    expect(storedOrders()).toHaveLength(0);
  });

  it('credits: two available credits are consumed whole; a replay consumes nothing further', async () => {
    const future = Date.now() + 30 * 86400000;
    dbHolder.db!.seed('store_credits', 'c1', { userId: 'u1', state: 'available', amountPkr: 300, createdAt: new Date(Date.now() - 2000), expiresAt: new Date(future), consumedOrderId: null, code: 'LATE-C1' });
    dbHolder.db!.seed('store_credits', 'c2', { userId: 'u1', state: 'available', amountPkr: 200, createdAt: new Date(Date.now() - 1000), expiresAt: new Date(future), consumedOrderId: null, code: 'LATE-C2' });
    const input = vendorInput({ idempotencyKey: 'k-credits' });
    const first = await createOrder(input);
    expect(first.success).toBe(true);
    const order = storedOrders()[0].data;
    expect(order.creditAppliedPkr).toBe(500);
    expect(order.totalPkr).toBe(1200);
    expect(dbHolder.db!.read('store_credits', 'c1')).toMatchObject({ state: 'consumed', consumedOrderId: first.id });
    expect(dbHolder.db!.read('store_credits', 'c2')).toMatchObject({ state: 'consumed', consumedOrderId: first.id });

    const replay = await createOrder(input);
    expect(replay).toEqual(first);
    expect(storedOrders()).toHaveLength(1);
  });

  it('group: locked team price wins over the moved product price; seat registers in the same transaction', async () => {
    dbHolder.db!.seed('group_buys', 'g1', {
      productId: 'vp1', state: 'open', unitPricePkr: 900, teamSizeTarget: 2,
      memberOrderIds: [], memberUserIds: [], expiresAtMs: Date.now() + 3600000,
    });
    const res = await createOrder(vendorInput({ idempotencyKey: 'k-group', total: 1100, groupBuyId: 'g1' }));
    expect(res.success).toBe(true);
    const order = storedOrders()[0].data;
    expect(order.subtotalPkr).toBe(900);
    expect(order.totalPkr).toBe(1100);
    expect(order.groupBuyId).toBe('g1');
    expect(order.escrowStatus).toBe('held');
    const team = dbHolder.db!.read('group_buys', 'g1');
    expect(team.memberOrderIds).toEqual([res.id]);
    expect(team.memberUserIds).toEqual(['u1']);
  });

  it('group: an expired team is rejected and no order is written', async () => {
    dbHolder.db!.seed('group_buys', 'g1', {
      productId: 'vp1', state: 'open', unitPricePkr: 900, teamSizeTarget: 2,
      memberOrderIds: [], memberUserIds: [], expiresAtMs: Date.now() - 1000,
    });
    const res = await createOrder(vendorInput({ idempotencyKey: 'k-exp', total: 1100, groupBuyId: 'g1' }));
    expect(res).toEqual({ success: false, error: 'That team is no longer open, so this order cannot join it.' });
    expect(storedOrders()).toHaveLength(0);
  });
});

describe('createOrder vendor branch, primacy leg', () => {
  beforeEach(() => { mockState.primary = true; });

  it('O1 happy path: vendor fields flow verbatim through the tx; credits claimed first', async () => {
    const future = Date.now() + 30 * 86400000;
    dbHolder.db!.seed('store_credits', 'c1', { userId: 'u1', state: 'available', amountPkr: 300, createdAt: new Date(Date.now() - 1000), expiresAt: new Date(future), consumedOrderId: null, code: 'LATE-C1' });
    const res = await createOrder(vendorInput({ idempotencyKey: 'k-prim' }));
    expect(res.success).toBe(true);
    const order = mockState.supaOrders.get(res.id!);
    expect(order).toMatchObject({
      vendorId: 'v1', subtotalPkr: 1000, deliveryPkr: 200, totalPkr: 1200,
      creditAppliedPkr: 300, escrowStatus: 'none', paymentMethod: 'shop',
    });
    expect(dbHolder.db!.read('store_credits', 'c1')).toMatchObject({ state: 'consumed', consumedOrderId: res.id });
    expect(storedOrders()).toHaveLength(0);
  });

  it('O3 on the primacy leg: stock 0 rejects before any tx', async () => {
    mockState.supaProducts.set('vp1', { ...VENDOR_PRODUCT, stock: 0 });
    const res = await createOrder(vendorInput({ idempotencyKey: 'k-prim-oos' }));
    expect(res.success).toBe(false);
    expect(mockState.supaOrders.size).toBe(0);
  });

  it('compensation: when the tx throws after consumption, credits are restored and the claim is gone', async () => {
    const future = Date.now() + 30 * 86400000;
    dbHolder.db!.seed('store_credits', 'c1', { userId: 'u1', state: 'available', amountPkr: 300, createdAt: new Date(Date.now() - 1000), expiresAt: new Date(future), consumedOrderId: null, code: 'LATE-C1' });
    mockState.txFails = true;
    const res = await createOrder(vendorInput({ idempotencyKey: 'k-prim-fail' }));
    expect(res.success).toBe(false);
    expect(dbHolder.db!.read('store_credits', 'c1')).toMatchObject({ state: 'available', consumedOrderId: null });
    expect(dbHolder.db!.all('store_credit_claims')).toHaveLength(0);
  });
});

describe('house regressions (O2)', () => {
  it('donation order: no vendor keys, totalPkr null, declared amount kept', async () => {
    const res = await createOrder({
      userId: 'u1', total: 500, currency: 'PKR', originatingModule: 'donation',
      paymentMethod: 'raast', idempotencyKey: 'k-don',
      buyer: { fullName: 'Donor', email: 'd@example.com', phone: '0300' },
    });
    expect(res.success).toBe(true);
    const order = storedOrders()[0].data;
    expect(order.totalPkr).toBeNull();
    expect(order.declaredAmountPkr).toBe(500);
    for (const key of ['vendorId', 'subtotalPkr', 'deliveryPkr', 'creditAppliedPkr', 'escrowStatus', 'groupBuyId', 'notFoundText']) {
      expect(key in order).toBe(false);
    }
  });

  it('event-ticket house order: no vendor keys, goods total only', async () => {
    dbHolder.db!.seed('products', 'tp1', { name: 'Ticket', price: 500, currency: 'PKR', isActive: true, eventId: 'ev1' });
    dbHolder.db!.seed('events', 'ev1', { title: 'Space Talk', paymentDetails: { amount: 500 } });
    const res = await createOrder({
      userId: 'u1', productId: 'tp1', eventId: 'ev1', total: 500, currency: 'PKR',
      originatingModule: 'Events', paymentMethod: 'raast', idempotencyKey: 'k-ev',
      items: [{ productId: 'tp1', quantity: 1 }],
      buyer: { fullName: 'Buyer One', email: 'b@example.com', phone: '0300' },
    });
    expect(res.success).toBe(true);
    const order = storedOrders()[0].data;
    expect(order.totalPkr).toBe(500);
    for (const key of ['vendorId', 'subtotalPkr', 'deliveryPkr', 'creditAppliedPkr', 'escrowStatus']) {
      expect(key in order).toBe(false);
    }
  });
});

describe('submitNotFoundText (A2)', () => {
  beforeEach(() => {
    dbHolder.db!.seed('orders', 'o1', { vendorId: 'v1', buyerUserId: 'u1', notFoundText: null });
    dbHolder.db!.seed('orders', 'o2', { buyerUserId: 'u1', notFoundText: null });
  });

  it('the owner can set the answer once', async () => {
    const res = await submitNotFoundText({ orderId: 'o1', userId: 'u1', text: 'A 3D printer nozzle' });
    expect(res).toEqual({ success: true });
    expect(dbHolder.db!.read('orders', 'o1').notFoundText).toBe('A 3D printer nozzle');
    const again = await submitNotFoundText({ orderId: 'o1', userId: 'u1', text: 'Something else' });
    expect(again).toEqual({ success: false, error: 'Thanks, that was already recorded.' });
  });

  it('a different user and a house order both get the same not-found error', async () => {
    expect(await submitNotFoundText({ orderId: 'o1', userId: 'u2', text: 'x' }))
      .toEqual({ success: false, error: 'Order not found.' });
    expect(await submitNotFoundText({ orderId: 'o2', userId: 'u1', text: 'x' }))
      .toEqual({ success: false, error: 'Order not found.' });
    expect(await submitNotFoundText({ orderId: 'missing', userId: 'u1', text: 'x' }))
      .toEqual({ success: false, error: 'Order not found.' });
  });

  it('text over 500 characters is refused', async () => {
    const res = await submitNotFoundText({ orderId: 'o1', userId: 'u1', text: 'x'.repeat(501) });
    expect(res).toEqual({ success: false, error: 'Please write a short answer, up to 500 characters.' });
  });
});
