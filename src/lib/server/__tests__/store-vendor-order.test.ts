/**
 * @jest-environment node
 *
 * GE helper units (PLAN-ge 11.1): the pure money-adjacent functions of
 * src/lib/server/store-vendor-order.ts, plus the Firestore transaction
 * credit arms against a minimal in-memory fake. Fixtures only.
 */
import {
  VendorOrderError,
  applyCreditConsumptionInTransaction,
  asVendorOrderError,
  buildVendorOrderFields,
  classifyVendorOrder,
  coercePkrInt,
  computePromisedDeliveryDate,
  consumeStoreCreditsInTransaction,
  planStoreCreditConsumption,
  planStoreCreditsInTransaction,
  promisedDeliveryDateString,
  requireDeliveryPkr,
  resolveShopMethodKey,
  restoreStoreCreditConsumption,
  selectStoreCredits,
  stripVendorSpecFields,
  type VendorProductFacts,
} from '../store-vendor-order';

/* Minimal fake Firestore covering exactly the helper's surface:
   collection().where().orderBy().limit() queries, doc refs, and
   runTransaction with get/set/update/delete. */
function makeFakeDb(seed: Record<string, Record<string, any>> = {}) {
  const store = new Map<string, Map<string, any>>();
  for (const [coll, docs] of Object.entries(seed)) {
    store.set(coll, new Map(Object.entries(docs)));
  }
  const collOf = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  };
  const docRef = (coll: string, id: string): any => ({
    id,
    coll,
    get: async () => {
      const data = collOf(coll).get(id);
      return { exists: data !== undefined, id, data: () => (data ? { ...data } : undefined) };
    },
    set: async (data: any) => { collOf(coll).set(id, { ...data }); },
    update: async (data: any) => { collOf(coll).set(id, { ...collOf(coll).get(id), ...data }); },
    delete: async () => { collOf(coll).delete(id); },
  });
  const query = (coll: string, filters: Array<[string, any]> = [], limitN = 0): any => ({
    coll,
    where: (field: string, _op: string, value: any) => query(coll, [...filters, [field, value]], limitN),
    orderBy: () => query(coll, filters, limitN),
    limit: (n: number) => query(coll, filters, n),
    get: async () => {
      let rows = [...collOf(coll).entries()].map(([id, data]) => ({ id, data }));
      for (const [f, v] of filters) rows = rows.filter((r) => r.data[f] === v);
      rows.sort((a, b) => (a.data.createdAt ?? 0) - (b.data.createdAt ?? 0));
      if (limitN) rows = rows.slice(0, limitN);
      const docs = rows.map((r) => ({ id: r.id, data: () => ({ ...r.data }), ref: docRef(coll, r.id) }));
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  });
  const db: any = {
    collection: (name: string) => ({
      ...query(name),
      doc: (id: string) => docRef(name, id),
    }),
    runTransaction: async (fn: (t: any) => Promise<any>) => {
      const t = {
        get: (x: any) => x.get(),
        set: (ref: any, data: any) => ref.set(data),
        update: (ref: any, data: any) => ref.update(data),
        delete: (ref: any) => ref.delete(),
      };
      return fn(t);
    },
    _read: (coll: string, id: string) => collOf(coll).get(id),
    _all: (coll: string) => [...collOf(coll).entries()].map(([id, data]) => ({ id, data })),
  };
  return db;
}

const credit = (id: string, amountPkr: number, createdAtMs: number) => ({ id, amountPkr, createdAtMs });

describe('selectStoreCredits (CHOICE-2: whole, oldest first, skip-and-continue)', () => {
  it('takes oldest first and never exceeds the cap', () => {
    const result = selectStoreCredits([credit('a', 300, 1), credit('b', 200, 2), credit('c', 500, 3)], 450);
    expect(result).toEqual({ consumedIds: ['a'], appliedPkr: 300 });
  });

  it('skips a credit that does not fit whole and takes a later smaller one', () => {
    const result = selectStoreCredits([credit('a', 300, 1), credit('b', 100, 2)], 350);
    expect(result).toEqual({ consumedIds: ['a'], appliedPkr: 300 });
    const result2 = selectStoreCredits([credit('a', 100, 1), credit('b', 100, 2), credit('c', 100, 3)], 250);
    expect(result2).toEqual({ consumedIds: ['a', 'b'], appliedPkr: 200 });
  });

  it('a single credit larger than the cap consumes nothing', () => {
    expect(selectStoreCredits([credit('a', 500, 1)], 300)).toEqual({ consumedIds: [], appliedPkr: 0 });
  });

  it('breaks createdAt ties by document id', () => {
    const result = selectStoreCredits([credit('b', 100, 5), credit('a', 100, 5)], 100);
    expect(result.consumedIds).toEqual(['a']);
  });
});

describe('coercePkrInt', () => {
  it('accepts integers and integer strings', () => {
    expect(coercePkrInt(250)).toBe(250);
    expect(coercePkrInt('250')).toBe(250);
    expect(coercePkrInt(0)).toBe(0);
  });
  it('rejects negatives, fractions, and junk', () => {
    expect(coercePkrInt(-1)).toBeNull();
    expect(coercePkrInt(10.5)).toBeNull();
    expect(coercePkrInt('abc')).toBeNull();
    expect(coercePkrInt(null)).toBeNull();
    expect(coercePkrInt(undefined)).toBeNull();
  });
});

describe('computePromisedDeliveryDate / promisedDeliveryDateString', () => {
  it('adds whole days and returns null for missing or invalid days', () => {
    const now = Date.parse('2026-03-01T00:00:00.000Z');
    expect(computePromisedDeliveryDate(now, 5)).toBe(now + 5 * 86400000);
    expect(computePromisedDeliveryDate(now, undefined)).toBeNull();
    expect(computePromisedDeliveryDate(now, 0)).toBeNull();
    expect(promisedDeliveryDateString(now, 5)).toBe('2026-03-06');
    expect(promisedDeliveryDateString(now, null)).toBeNull();
  });
});

describe('resolveShopMethodKey', () => {
  const settings = {
    shopMethodKey: 'shop',
    methods: { shop: { enabled: true }, raast: { enabled: true } },
    order: ['shop', 'raast'],
  };
  it('returns the pointed enabled method', () => {
    expect(resolveShopMethodKey(settings)).toBe('shop');
  });
  it('returns null when unpointed, disabled, or settings are null', () => {
    expect(resolveShopMethodKey({ ...settings, shopMethodKey: null })).toBeNull();
    expect(resolveShopMethodKey({ shopMethodKey: 'shop', methods: { shop: { enabled: false } } })).toBeNull();
    expect(resolveShopMethodKey(null)).toBeNull();
    expect(resolveShopMethodKey({})).toBeNull();
  });
});

describe('requireDeliveryPkr', () => {
  const facts = (deliveryChargePkr: unknown): VendorProductFacts => ({
    exists: true, vendorId: 'v1', deliveryChargePkr, deliveryPromiseDays: 3, stock: 2,
  });
  it('returns the charge and fails closed when missing', () => {
    expect(requireDeliveryPkr(facts(200))).toBe(200);
    expect(() => requireDeliveryPkr(facts(undefined))).toThrow(VendorOrderError);
    expect(() => requireDeliveryPkr(facts(undefined))).toThrow('Product is missing its delivery charge. Order rejected.');
  });
});

describe('classifyVendorOrder', () => {
  const vendorFacts: VendorProductFacts = { exists: true, vendorId: 'v1', deliveryChargePkr: 200, deliveryPromiseDays: 3, stock: 2 };
  const houseFacts: VendorProductFacts = { exists: true, vendorId: null, deliveryChargePkr: undefined, deliveryPromiseDays: undefined, stock: undefined };
  it('classifies a single vendor line at quantity 1 as vendor', () => {
    const facts = new Map([['p1', vendorFacts]]);
    expect(classifyVendorOrder([{ productId: 'p1', quantity: 1 }], facts).kind).toBe('vendor');
  });
  it('classifies house-only lines as house', () => {
    const facts = new Map([['p1', houseFacts]]);
    expect(classifyVendorOrder([{ productId: 'p1', quantity: 2 }], facts).kind).toBe('house');
  });
  it('rejects mixed and multi-quantity vendor orders', () => {
    const facts = new Map([['p1', vendorFacts], ['p2', houseFacts]]);
    expect(() => classifyVendorOrder([{ productId: 'p1', quantity: 1 }, { productId: 'p2', quantity: 1 }], facts)).toThrow(VendorOrderError);
    const single = new Map([['p1', vendorFacts]]);
    expect(() => classifyVendorOrder([{ productId: 'p1', quantity: 2 }], single)).toThrow(VendorOrderError);
  });
});

describe('stripVendorSpecFields + buildVendorOrderFields', () => {
  it('strips all 15 spec fields and keeps the sanctioned groupBuyId aside', () => {
    const { clean, groupBuyId } = stripVendorSpecFields({
      userId: 'u1', total: 1200, vendorId: 'FORGED', deliveryPkr: 1, creditAppliedPkr: 999,
      escrowStatus: 'released', groupBuyId: 'g1', notFoundText: 'x', payoutId: 'p9',
    });
    expect(clean).toEqual({ userId: 'u1', total: 1200 });
    expect(groupBuyId).toBe('g1');
  });
  it('builds the exact vendor field set with total = goods + delivery', () => {
    const fields = buildVendorOrderFields({
      vendorId: 'v1', subtotalPkr: 1000, deliveryPkr: 200,
      promisedDeliveryDate: '2026-03-06', groupBuyId: null, creditAppliedPkr: 0,
    });
    expect(fields).toEqual({
      vendorId: 'v1', subtotalPkr: 1000, deliveryPkr: 200, totalPkr: 1200, total: 1200,
      promisedDeliveryDate: '2026-03-06', groupBuyId: null, escrowStatus: 'none',
      creditAppliedPkr: 0, notFoundText: null, courierName: null, trackingNumber: null,
      dispatchedAt: null, deliveredAt: null, fulfilmentNote: null,
      commissionLedgerId: null, payoutId: null,
    });
    const grouped = buildVendorOrderFields({
      vendorId: 'v1', subtotalPkr: 900, deliveryPkr: 200,
      promisedDeliveryDate: null, groupBuyId: 'g1', creditAppliedPkr: 100,
    });
    expect(grouped.escrowStatus).toBe('held');
  });
});

describe('credit consumption in a transaction', () => {
  const seedCredits = () => makeFakeDb({
    store_credits: {
      c1: { userId: 'u1', state: 'available', amountPkr: 300, createdAt: 1000, expiresAt: Date.now() + 86400000, consumedOrderId: null },
      c2: { userId: 'u1', state: 'available', amountPkr: 200, createdAt: 2000, expiresAt: Date.now() + 86400000, consumedOrderId: null },
      c3: { userId: 'u1', state: 'available', amountPkr: 100, createdAt: 3000, expiresAt: Date.now() - 1000, consumedOrderId: null },
      c4: { userId: 'u2', state: 'available', amountPkr: 400, createdAt: 500, expiresAt: Date.now() + 86400000, consumedOrderId: null },
    },
  });

  it('consumeStoreCreditsInTransaction consumes exactly the selected docs and stamps consumedOrderId', async () => {
    const db = seedCredits();
    const result = await db.runTransaction((t: any) =>
      consumeStoreCreditsInTransaction(t, db, { buyerUid: 'u1', capPkr: 1200, orderId: 'o1', nowMs: Date.now() }),
    );
    // c3 is expired; c4 belongs to another buyer.
    expect(result).toEqual({ creditAppliedPkr: 500, consumedIds: ['c1', 'c2'] });
    expect(db._read('store_credits', 'c1')).toMatchObject({ state: 'consumed', consumedOrderId: 'o1' });
    expect(db._read('store_credits', 'c2')).toMatchObject({ state: 'consumed', consumedOrderId: 'o1' });
    expect(db._read('store_credits', 'c4').state).toBe('available');
  });

  it('plan + apply split keeps the same result (the seat-registration seam)', async () => {
    const db = seedCredits();
    const result = await db.runTransaction(async (t: any) => {
      const plan = await planStoreCreditsInTransaction(t, db, { buyerUid: 'u1', capPkr: 350, nowMs: Date.now() });
      applyCreditConsumptionInTransaction(t, plan, 'o2');
      return plan;
    });
    expect(result.creditAppliedPkr).toBe(300);
    expect(db._read('store_credits', 'c1')).toMatchObject({ state: 'consumed', consumedOrderId: 'o2' });
    expect(db._read('store_credits', 'c2').state).toBe('available');
  });
});

describe('primacy claim-first consumption and restore', () => {
  it('claims once, replays without consuming, and restores on compensation', async () => {
    const db = makeFakeDb({
      store_credits: {
        c1: { userId: 'u1', state: 'available', amountPkr: 300, createdAt: 1000, expiresAt: Date.now() + 86400000, consumedOrderId: null },
      },
    });
    const args = { buyerUid: 'u1', idempotencyKey: 'k1', orderId: 'o1', capPkr: 1200, nowMs: Date.now(), claimTimestamp: 'ts' };
    const first = await planStoreCreditConsumption(db, args);
    expect(first).toMatchObject({ creditAppliedPkr: 300, consumedIds: ['c1'], alreadyClaimed: false });
    expect(db._read('store_credits', 'c1').state).toBe('consumed');
    expect(db._all('store_credit_claims')).toHaveLength(1);

    const replay = await planStoreCreditConsumption(db, args);
    expect(replay).toMatchObject({ creditAppliedPkr: 300, consumedIds: ['c1'], alreadyClaimed: true });

    await restoreStoreCreditConsumption(db, { buyerUid: 'u1', idempotencyKey: 'k1', consumedIds: ['c1'] });
    expect(db._read('store_credits', 'c1')).toMatchObject({ state: 'available', consumedOrderId: null });
    expect(db._all('store_credit_claims')).toHaveLength(0);
  });
});

describe('asVendorOrderError', () => {
  it('maps GH seat codes to the buyer messages and passes other errors through', () => {
    const mapped = asVendorOrderError(Object.assign(new Error('x'), { code: 'TEAM_FULL' })) as Error;
    expect(mapped).toBeInstanceOf(VendorOrderError);
    expect(mapped.message).toBe('That team is already full.');
    const other = new Error('boom');
    expect(asVendorOrderError(other)).toBe(other);
  });
});
