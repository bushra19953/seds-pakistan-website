/**
 * @jest-environment node
 *
 * S-W3 / S-W4 CONTRACTS: src/app/actions/store.ts write primacy.
 * ON  (isSupaPrimary('store-actions')): createOrder = ONE
 *     tx_store_create_order (order + registration mirror + audit in
 *     one transaction; the product stub was removed by the audit
 *     item-4 fix — a checkout never creates a product). FAILURE INJECTION: when the
 *     registration write fails inside the tx, NO order persists — the
 *     Firestore chain's orphan class is dead. Idempotency: a repeated
 *     idempotencyKey replays instead of duplicating. Price
 *     verification reads fs_products (flip order: products first).
 *     syncEventToProduct writes via the adapter, payload identical.
 * OFF: the Firestore chain runs byte-identically; no tx, no adapter
 *     writes.
 * The fake tx stages all writes and commits only on completion —
 * a throw anywhere inside discards the whole stage.
 */

const mockState = {
  primary: false,
  readFlagOn: false,
  txCalls: [] as Array<[string, any]>,
  failInsideTx: false,
  supaOrders: new Map<string, Record<string, any>>(),
  supaProducts: new Map<string, Record<string, any>>(),
  supaRegistrations: new Map<string, Record<string, any>>(),
  supaEvents: new Map<string, Record<string, any>>(),
  supaAudit: [] as Array<Record<string, any>>,
  adapterWrites: [] as Array<[string, string, string]>,
  fsOrdersAdded: [] as Array<Record<string, any>>,
  fsRegistrationsSet: 0,
  fsAuditAdds: 0,
  fsChapterUpdates: 0,
  fsProductUpdates: [] as Array<[string, any]>,
  fsProductSets: [] as Array<[string, any]>,
};

function fakeTx(fn: string, args: any) {
  mockState.txCalls.push([fn, args]);
  if (fn !== 'tx_store_create_order') throw new Error(`unexpected tx: ${fn}`);
  const key = args.p_idempotency_key as string | undefined;
  if (key != null) {
    for (const [id, data] of mockState.supaOrders) {
      if (data.buyerUserId === args.p_order_data.buyerUserId && data.idempotencyKey === key) {
        return { ok: true, created: false, orderId: id };
      }
    }
  }
  // Stage everything; a throw discards the stage (tx rollback).
  const stagedOrders = new Map(mockState.supaOrders);
  const stagedRegs = new Map(mockState.supaRegistrations);
  const stagedProducts = new Map(mockState.supaProducts);
  const stagedAudit = [...mockState.supaAudit];
  stagedOrders.set(args.p_order_id, {
    ...args.p_order_data, ...(key != null ? { idempotencyKey: key } : {}),
  });
  if (args.p_event_id) {
    if (mockState.failInsideTx) throw new Error('registration write failed inside tx');
    if (args.p_registration) {
      stagedRegs.set(`events/${args.p_event_id}/registrations|${args.p_registration.uid}`, args.p_registration);
    }
    // Audit item 4: the tx NEVER writes products (the A3 stub is
    // removed) — stagedProducts is carried through untouched.
  }
  stagedAudit.push({
    action: 'ORDER_CREATED', actorUid: args.p_order_data.buyerUserId,
    targetUidOrResource: args.p_order_id, payload: args.p_audit.payload, source: 'server-action',
  });
  mockState.supaOrders = stagedOrders;
  mockState.supaRegistrations = stagedRegs;
  mockState.supaProducts = stagedProducts;
  mockState.supaAudit = stagedAudit;
  return { ok: true, created: true, orderId: args.p_order_id };
}

function fsDocSnap(map: Map<string, any>, id: string) {
  const data = map.get(id);
  return { exists: !!data, id, data: () => (data ? { ...data } : undefined) };
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'users') return { doc: (id: string) => ({ get: async () => fsDocSnap(new Map([['u1', {}]]), id) }) };
    if (name === 'warningConfig') return { doc: () => ({ get: async () => fsDocSnap(new Map([['global', { enforcementEnabled: true }]]), 'global') }) };
    if (name === 'settings') return { doc: () => ({ get: async () => fsDocSnap(new Map(), 'siteWide') }) };
    if (name === 'products') {
      return {
        doc: (id: string) => ({
          get: async () => fsDocSnap(mockState.supaProducts, id),
          set: async (data: any) => { mockState.fsProductSets.push([id, data]); mockState.supaProducts.set(id, data); },
          update: async (data: any) => { mockState.fsProductUpdates.push([id, data]); },
        }),
        where: () => ({
          limit: () => ({
            get: async () => ({
              empty: ![...mockState.supaProducts.values()].some((p) => p.eventId),
              docs: [],
            }),
          }),
        }),
        add: async (data: any) => { mockState.fsProductSets.push(['<add>', data]); return { id: 'fs-prod-add' }; },
      };
    }
    if (name === 'orders') {
      return {
        add: async (data: any) => {
          mockState.fsOrdersAdded.push(data);
          return { id: 'fs-order-1' };
        },
      };
    }
    if (name === 'events') {
      return {
        doc: (id: string) => ({
          get: async () => fsDocSnap(mockState.supaEvents, id),
          collection: () => ({
            doc: () => ({
              set: async () => { mockState.fsRegistrationsSet++; },
            }),
          }),
        }),
      };
    }
    if (name === 'chapter_applications') {
      return { doc: () => ({ update: async () => { mockState.fsChapterUpdates++; } }) };
    }
    if (name === 'audit_logs') {
      return { add: async () => { mockState.fsAuditAdds++; return { id: 'fs-audit' }; } };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
};

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => ({ toMillis: () => Date.parse('2026-03-01T00:00:00.000Z'), __serverTimestamp: true }),
  },
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(async () => mockDb),
}));

jest.mock('@/lib/supa', () => ({
  useSupa: jest.fn(() => mockState.readFlagOn),
  isSupaPrimary: jest.fn(() => mockState.primary),
  getSupaClient: jest.fn(() => ({})),
  getSupaAdapter: jest.fn(() => ({
    getDoc: jest.fn(async (_collection: string, id: string) => {
      const found = mockState.supaProducts.get(id);
      return found ? { id, ...found } : null;
    }),
    listDocs: jest.fn(async () => []),
    updateDoc: jest.fn(async (collection: string, id: string, data: any) => {
      mockState.adapterWrites.push(['updateDoc', collection, id]);
      mockState.supaProducts.set(id, { ...(mockState.supaProducts.get(id) || {}), ...data });
      return { id, ...data };
    }),
    setDoc: jest.fn(async (collection: string, id: string, data: any) => {
      mockState.adapterWrites.push(['setDoc', collection, id]);
      mockState.supaProducts.set(id, { ...data });
      return { id, ...data };
    }),
    tx: jest.fn(async (fn: string, args: any, opts: any) => {
      const finalArgs = opts?.idempotencyKey !== undefined
        ? { ...args, p_idempotency_key: opts.idempotencyKey }
        : args;
      return fakeTx(fn, finalArgs);
    }),
    rpc: jest.fn(async (fn: string, args: any) => fakeTx(fn, args)),
  })),
}));

import { createOrder, syncEventToProduct } from '@/app/actions/store';

const orderData = (extra: Record<string, any> = {}) => ({
  userId: 'u1',
  productId: 'p1',
  total: 500,
  currency: 'PKR',
  originatingModule: 'store',
  eventId: 'ev1',
  buyer: { fullName: 'Buyer One', email: 'b@example.com', phone: '0300' },
  paymentMethod: 'bank_transfer',
  ...extra,
});

beforeEach(() => {
  mockState.primary = false;
  mockState.readFlagOn = false;
  mockState.txCalls = [];
  mockState.failInsideTx = false;
  mockState.supaOrders = new Map();
  mockState.supaProducts = new Map([['p1', { name: 'Ticket', price: 500, eventId: 'ev1' }]]);
  mockState.supaRegistrations = new Map();
  mockState.supaEvents = new Map([['ev1', { title: 'Space Talk', imageUrl: 'img.png' }]]);
  mockState.supaAudit = [];
  mockState.adapterWrites = [];
  mockState.fsOrdersAdded = [];
  mockState.fsRegistrationsSet = 0;
  mockState.fsAuditAdds = 0;
  mockState.fsChapterUpdates = 0;
  mockState.fsProductUpdates = [];
  mockState.fsProductSets = [];
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('createOrder primacy ON (S-W3)', () => {
  beforeEach(() => { mockState.primary = true; });

  it('one tx commits order + registration + audit; Firestore chain never runs', async () => {
    const res = await createOrder(orderData({ idempotencyKey: 'key-1' }));
    expect(res.success).toBe(true);
    expect(res.id).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(mockState.txCalls).toHaveLength(1);
    expect(mockState.txCalls[0][0]).toBe('tx_store_create_order');
    const order = mockState.supaOrders.get(res.id!);
    expect(order).toMatchObject({
      buyerUserId: 'u1', totalPkr: 500, status: 'pending_verification',
      idempotencyKey: 'key-1', createdAt: '2026-03-01T00:00:00.000Z',
    });
    const reg = mockState.supaRegistrations.get('events/ev1/registrations|u1');
    expect(reg).toMatchObject({ uid: 'u1', orderId: res.id, eventId: 'ev1', status: 'pending' });
    expect(mockState.supaAudit).toHaveLength(1);
    expect(mockState.supaAudit[0]).toMatchObject({ action: 'ORDER_CREATED', targetUidOrResource: res.id });
    expect(mockState.fsOrdersAdded).toHaveLength(0);
    expect(mockState.fsRegistrationsSet).toBe(0);
    expect(mockState.fsAuditAdds).toBe(0);
  });

  it('FAILURE INJECTION: registration write fails inside the tx -> success:false and NO order persists (orphan class dead)', async () => {
    mockState.failInsideTx = true;
    const res = await createOrder(orderData({ idempotencyKey: 'key-fail' }));
    expect(res.success).toBe(false);
    expect(mockState.supaOrders.size).toBe(0);
    expect(mockState.supaRegistrations.size).toBe(0);
    expect(mockState.supaAudit).toHaveLength(0);
    expect(mockState.fsOrdersAdded).toHaveLength(0);
  });

  it('idempotent replay: same key twice -> same id, one order, one audit', async () => {
    const a = await createOrder(orderData({ idempotencyKey: 'key-1' }));
    const b = await createOrder(orderData({ idempotencyKey: 'key-1' }));
    expect(b).toEqual(a);
    expect(mockState.supaOrders.size).toBe(1);
    expect(mockState.supaAudit).toHaveLength(1);
  });

  it('price verification reads fs_products under primacy: a tampered total is rejected before any tx', async () => {
    const res = await createOrder(orderData({ total: 400 }));
    expect(res).toEqual({ success: false, error: 'Security Error: Price tampering detected.' });
    expect(mockState.txCalls).toHaveLength(0);
    expect(mockState.supaOrders.size).toBe(0);
  });

  it('A4 stays post-tx best-effort: chapter application link still updates Firestore with the committed id', async () => {
    const res = await createOrder(orderData({ chapterApplicationId: 'app-1' }));
    expect(res.success).toBe(true);
    expect(mockState.fsChapterUpdates).toBe(1);
  });
});

describe('createOrder primacy OFF', () => {
  it('the Firestore chain runs (orders.add + registration set + audit add); no tx', async () => {
    const res = await createOrder(orderData());
    expect(res).toEqual({ success: true, id: 'fs-order-1' });
    expect(mockState.fsOrdersAdded).toHaveLength(1);
    expect(mockState.fsRegistrationsSet).toBe(1);
    expect(mockState.fsAuditAdds).toBe(1);
    expect(mockState.txCalls).toHaveLength(0);
  });
});

describe('createOrder pricing fail-closed (audit item 4)', () => {
  it('OFF: a missing product rejects the order and NO product document is created', async () => {
    const res = await createOrder(orderData({ productId: 'ghost', eventId: undefined, total: 1 }));
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/missing or has no server-side price/);
    expect(mockState.fsOrdersAdded).toHaveLength(0);
    expect(mockState.fsProductSets).toHaveLength(0);
    expect(mockState.supaProducts.has('ghost')).toBe(false);
  });

  it('OFF: an event-ticket product that does not exist yet is priced from the SERVER event record, and no stub is created', async () => {
    mockState.supaEvents.set('ev1', {
      title: 'Space Talk', imageUrl: 'img.png',
      paymentDetails: { isPaid: true, amount: 500, currency: 'PKR' },
    });
    const res = await createOrder(orderData({
      productId: 'synth-ticket',
      items: [{ productId: 'synth-ticket', quantity: 1 }],
      total: 500,
    }));
    expect(res).toEqual({ success: true, id: 'fs-order-1' });
    expect(mockState.fsOrdersAdded).toHaveLength(1);
    expect(mockState.fsOrdersAdded[0].totalPkr).toBe(500);
    // The poison path is dead: checkout created no product anywhere.
    expect(mockState.fsProductSets).toHaveLength(0);
    expect(mockState.supaProducts.has('synth-ticket')).toBe(false);
  });

  it('OFF: a tampered total against the event price is rejected and nothing is written', async () => {
    mockState.supaEvents.set('ev1', {
      title: 'Space Talk', imageUrl: 'img.png',
      paymentDetails: { isPaid: true, amount: 500, currency: 'PKR' },
    });
    const res = await createOrder(orderData({
      productId: 'synth-ticket',
      items: [{ productId: 'synth-ticket', quantity: 1 }],
      total: 5,
    }));
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Price tampering detected/);
    expect(mockState.fsOrdersAdded).toHaveLength(0);
    expect(mockState.fsProductSets).toHaveLength(0);
  });

  it('OFF: a multi-item order prices EVERY item server-side', async () => {
    mockState.supaProducts.set('p2', { name: 'Poster', price: 300 });
    const ok = await createOrder(orderData({
      productId: undefined, eventId: undefined,
      items: [
        { productId: 'p1', quantity: 1 },
        { productId: 'p2', quantity: 2 },
      ],
      total: 1100,
    }));
    expect(ok.success).toBe(true);
    expect(mockState.fsOrdersAdded[0].totalPkr).toBe(1100);

    const tampered = await createOrder(orderData({
      productId: undefined, eventId: undefined,
      items: [
        { productId: 'p1', quantity: 1 },
        { productId: 'p2', quantity: 2 },
      ],
      total: 800,
    }));
    expect(tampered.success).toBe(false);
    expect(mockState.fsOrdersAdded).toHaveLength(1); // only the good one
  });

  it('ON: a missing product with no event price rejects BEFORE any tx, and no product is created', async () => {
    mockState.primary = true;
    mockState.supaEvents.set('ev1', { title: 'Space Talk', imageUrl: 'img.png' });
    const res = await createOrder(orderData({ productId: 'ghost', total: 1 }));
    expect(res.success).toBe(false);
    expect(mockState.txCalls).toHaveLength(0);
    expect(mockState.supaOrders.size).toBe(0);
    expect(mockState.supaProducts.has('ghost')).toBe(false);
  });

  it('ON: an event-ticket order priced from the event record commits WITHOUT creating a product stub', async () => {
    mockState.primary = true;
    mockState.supaEvents.set('ev1', {
      title: 'Space Talk', imageUrl: 'img.png',
      paymentDetails: { isPaid: true, amount: 500, currency: 'PKR' },
    });
    const before = mockState.supaProducts.size;
    const res = await createOrder(orderData({
      productId: 'synth-ticket',
      items: [{ productId: 'synth-ticket', quantity: 1 }],
      total: 500,
    }));
    expect(res.success).toBe(true);
    expect(mockState.supaOrders.get(res.id!)?.totalPkr).toBe(500);
    expect(mockState.supaProducts.size).toBe(before);
    expect(mockState.supaProducts.has('synth-ticket')).toBe(false);
  });
});

describe('syncEventToProduct primacy (S-W4)', () => {
  const eventData = {
    title: 'Space Talk', description: 'd', amountInput: '750', currency: 'PKR',
    id: 'ev1', isPaid: true, imageUrl: 'img.png', capacity: '40',
  };

  it('ON update: adapter updateDoc with a byte-identical payload (event_ticket, EV-P07 fields untouched)', async () => {
    mockState.primary = true;
    const res = await syncEventToProduct(eventData, 'p1');
    expect(res).toEqual({ success: true, id: 'p1' });
    expect(mockState.adapterWrites).toEqual([['updateDoc', 'products', 'p1']]);
    const stored = mockState.supaProducts.get('p1')!;
    expect(stored).toMatchObject({
      name: 'Space Talk', price: 750, category: 'event_ticket', eventId: 'ev1',
      isActive: true, stock: 40, imageUrl: 'img.png',
    });
    expect(typeof stored.updatedAt).toBe('string'); // ISO, not a sentinel
    expect(mockState.fsProductUpdates).toHaveLength(0);
  });

  it('ON create: adapter setDoc with a generated Firestore-shaped id + createdAt', async () => {
    mockState.primary = true;
    const res = await syncEventToProduct(eventData);
    expect(res.success).toBe(true);
    expect(res.id).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(mockState.adapterWrites[0][0]).toBe('setDoc');
    expect(mockState.supaProducts.get(res.id!)).toMatchObject({ category: 'event_ticket', eventId: 'ev1' });
    expect(typeof mockState.supaProducts.get(res.id!)!.createdAt).toBe('string');
  });

  it('OFF: Firestore update runs; adapter untouched', async () => {
    const res = await syncEventToProduct(eventData, 'p1');
    expect(res).toEqual({ success: true, id: 'p1' });
    expect(mockState.fsProductUpdates).toHaveLength(1);
    expect(mockState.adapterWrites).toHaveLength(0);
  });
});
