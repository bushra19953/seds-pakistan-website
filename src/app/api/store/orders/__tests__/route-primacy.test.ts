/**
 * @jest-environment node
 *
 * S-W2 CONTRACTS: /api/store/orders write primacy.
 * ON  (isSupaPrimary('store-orders-api')): POST = ONE tx_store_order_
 *     create (price re-read inside the tx; §3.5 idempotency — same
 *     Idempotency-Key twice yields ONE order, a created:false replay,
 *     and NO second notification; no key = today's duplicate-prone
 *     behaviour, byte-identical); PATCH = ONE tx_store_order_patch
 *     with scalar fields only, the route's 409 money guard running
 *     verbatim BEFORE the tx.
 * OFF: Firestore path, tx never called.
 */

import { NextRequest } from 'next/server';

const mockState = {
  primary: false,
  txCalls: [] as Array<[string, any]>,
  txFails: false,
  supaOrders: new Map<string, Record<string, any>>(),
  supaProducts: new Map<string, Record<string, any>>(),
  supaAudit: [] as Array<Record<string, any>>,
  fsAdds: 0,
  fsBatchCommits: 0,
  notifBroadcasts: 0,
  notifSends: [] as Array<[string, any]>,
};

function fakeTx(fn: string, args: any) {
  mockState.txCalls.push([fn, args]);
  if (mockState.txFails) throw new Error('tx boom');
  if (fn === 'tx_store_order_create') {
    const key = args.p_idempotency_key as string | undefined;
    const buyer = args.p_data.buyerUserId;
    if (key != null) {
      for (const [id, data] of mockState.supaOrders) {
        if (data.buyerUserId === buyer && data.idempotencyKey === key) {
          return { ok: true, created: false, orderId: id };
        }
      }
    }
    // Price re-read inside the tx (fs_products snapshot).
    if (!args.p_is_donation && args.p_product_id) {
      const product = mockState.supaProducts.get(args.p_product_id);
      if (product && typeof product.price === 'number') {
        if (args.p_claimed !== product.price * (args.p_quantity ?? 1)) {
          return {
            ok: false, httpStatus: 422,
            message: 'Price verification failed: claimed amount does not match the server price',
          };
        }
      }
    }
    const data = { ...args.p_data, ...(key != null ? { idempotencyKey: key } : {}) };
    mockState.supaOrders.set(args.p_id, data);
    return { ok: true, created: true, orderId: args.p_id };
  }
  if (fn === 'tx_store_order_patch') {
    const before = mockState.supaOrders.get(args.p_id);
    if (!before) return { ok: false, httpStatus: 404, message: 'Order not found' };
    const updated = { ...before };
    if (args.p_has_status) updated.status = args.p_status;
    if (args.p_has_fulfilment_note) updated.fulfilmentNote = args.p_fulfilment_note;
    mockState.supaOrders.set(args.p_id, updated);
    mockState.supaAudit.push({
      action: args.p_audit.action, actorUid: args.p_audit.actorUid,
      targetType: 'order', targetUidOrResource: args.p_id,
    });
    return { ok: true, orderId: args.p_id, order_data: updated };
  }
  throw new Error(`unexpected tx: ${fn}`);
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'orders') {
      return {
        add: async () => { mockState.fsAdds++; return { id: `fs-order-${mockState.fsAdds}` }; },
        doc: (id: string) => ({
          get: async () => ({ exists: false, id, data: () => undefined }),
        }),
      };
    }
    if (name === 'products') {
      return {
        doc: (id: string) => ({
          get: async () => {
            const data = mockState.supaProducts.get(id);
            return { exists: !!data, id, data: () => data };
          },
        }),
      };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
  batch: () => ({
    update: () => {}, set: () => {},
    commit: async () => { mockState.fsBatchCommits++; },
  }),
};

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    auth: () => ({ verifyIdToken: async () => ({ uid: 'buyer-1' }) }),
    firestore: {
      Timestamp: {
        now: () => {
          const d = new Date('2026-03-01T00:00:00.000Z');
          return { toDate: () => d, toMillis: () => d.getTime() };
        },
      },
    },
  },
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
  ensureAdminInitialized: jest.fn(() => true),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => true),
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    broadcastByRoles: jest.fn(async () => { mockState.notifBroadcasts++; }),
    send: jest.fn(async (uid: string, payload: any) => { mockState.notifSends.push([uid, payload]); }),
  },
}));

jest.mock('@/lib/supa', () => ({
  useSupa: jest.fn(() => false),
  isSupaPrimary: jest.fn(() => mockState.primary),
  getSupaClient: jest.fn(() => ({})),
  getSupaAdapter: jest.fn(() => ({
    getDoc: jest.fn(async () => null),
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

import { POST, PATCH } from '@/app/api/store/orders/route';

function req(method: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/store/orders', {
    method,
    headers: {
      authorization: 'Bearer <redacted>', 'content-type': 'application/json', ...headers,
    },
    body: JSON.stringify(body),
  });
}

const orderBody = (extra: Record<string, any> = {}) => ({
  amount: 500,
  currency: 'PKR',
  paymentMethod: 'manual',
  productId: 'p1',
  items: [{ productId: 'p1', title: 'Ticket', quantity: 1 }],
  buyer: { fullName: 'Buyer One' },
  certificateCode: 'CERT-1',
  ...extra,
});

beforeEach(() => {
  mockState.primary = false;
  mockState.txCalls = [];
  mockState.txFails = false;
  mockState.supaOrders = new Map();
  mockState.supaProducts = new Map([['p1', { price: 500 }]]);
  mockState.supaAudit = [];
  mockState.fsAdds = 0;
  mockState.fsBatchCommits = 0;
  mockState.notifBroadcasts = 0;
  mockState.notifSends = [];
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('orders POST primacy ON', () => {
  beforeEach(() => { mockState.primary = true; });

  it('one tx; price verified inside the tx; notifications fire on created:true; Firestore untouched', async () => {
    const res = await POST(req('POST', orderBody(), { 'idempotency-key': 'attempt-1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, message: 'Order created successfully' });
    expect(body.orderId).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(mockState.txCalls).toHaveLength(1);
    expect(mockState.txCalls[0][0]).toBe('tx_store_order_create');
    expect(mockState.txCalls[0][1].p_idempotency_key).toBe('attempt-1');
    expect(mockState.supaOrders.get(body.orderId)).toMatchObject({
      buyerUserId: 'buyer-1', idempotencyKey: 'attempt-1',
    });
    expect(mockState.notifBroadcasts).toBe(1);
    expect(mockState.notifSends).toHaveLength(1);
    expect(mockState.fsAdds).toBe(0);
  });

  it('DUPLICATE-SUBMIT CONTRACT: same key twice -> ONE order, created:false replay, no second notification', async () => {
    const first = await (await POST(req('POST', orderBody(), { 'idempotency-key': 'attempt-1' }))).json();
    const secondRes = await POST(req('POST', orderBody(), { 'idempotency-key': 'attempt-1' }));
    expect(secondRes.status).toBe(200);
    const second = await secondRes.json();
    expect(second.orderId).toBe(first.orderId);
    expect(mockState.supaOrders.size).toBe(1);
    expect(mockState.txCalls).toHaveLength(2);
    expect(mockState.notifBroadcasts).toBe(1); // not re-fired for the replay
    expect(mockState.notifSends).toHaveLength(1);
  });

  it('no key (current clients): two submits mint two orders — legacy behaviour byte-identical', async () => {
    const a = await (await POST(req('POST', orderBody()))).json();
    const b = await (await POST(req('POST', orderBody()))).json();
    expect(a.orderId).not.toBe(b.orderId);
    expect(mockState.supaOrders.size).toBe(2);
  });

  it('price mismatch is re-checked inside the tx -> 422 shape, no order written', async () => {
    const res = await POST(req('POST', orderBody({ amount: 400 })));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'Price verification failed: claimed amount does not match the server price',
    });
    expect(mockState.supaOrders.size).toBe(0);
    expect(mockState.notifBroadcasts).toBe(0);
  });

  it('tx failure -> 500 and NO Firestore fallback write', async () => {
    mockState.txFails = true;
    const res = await POST(req('POST', orderBody()));
    expect(res.status).toBe(500);
    expect(mockState.fsAdds).toBe(0);
  });
});

describe('orders PATCH primacy ON', () => {
  beforeEach(() => {
    mockState.primary = true;
    mockState.supaOrders.set('o1', {
      status: 'pending_verification', paymentStatus: 'pending',
      buyerUserId: 'buyer-9', certificateCode: 'CERT-9', items: [],
    });
  });

  it('money guard runs verbatim BEFORE the tx: money field / money status -> 409, tx never called', async () => {
    const money = await PATCH(req('PATCH', { orderId: 'o1', updates: { paymentStatus: 'completed' } }));
    expect(money.status).toBe(409);
    const moneyStatus = await PATCH(req('PATCH', { orderId: 'o1', updates: { status: 'verified' } }));
    expect(moneyStatus.status).toBe(409);
    expect(mockState.txCalls).toHaveLength(0);
  });

  it('fulfilment patch: one tx with scalar params only + derived audit; buyer notified off the committed row', async () => {
    const res = await PATCH(req('PATCH', { orderId: 'o1', updates: { status: 'shipped', fulfilmentNote: 'TCS' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, orderId: 'o1' });
    expect(mockState.txCalls).toHaveLength(1);
    const [, args] = mockState.txCalls[0];
    expect(args).toMatchObject({
      p_id: 'o1', p_status: 'shipped', p_has_status: true,
      p_fulfilment_note: 'TCS', p_has_fulfilment_note: true,
    });
    // No arbitrary patch object crosses the boundary.
    expect(args.p_updates).toBeUndefined();
    expect(args.p_audit).toMatchObject({ action: 'order_status_updated', source: 'store_orders_api' });
    expect(mockState.supaAudit).toHaveLength(1);
    expect(mockState.notifSends).toHaveLength(1);
    expect(mockState.notifSends[0][0]).toBe('buyer-9');
    expect(mockState.fsBatchCommits).toBe(0);
  });

  it('missing order -> 404 from the tx value', async () => {
    const res = await PATCH(req('PATCH', { orderId: 'nope', updates: { status: 'shipped' } }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Order not found' });
  });
});

describe('orders primacy OFF', () => {
  it('POST runs the Firestore .add path and never calls a tx', async () => {
    const res = await POST(req('POST', orderBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, orderId: 'fs-order-1' });
    expect(mockState.fsAdds).toBe(1);
    expect(mockState.txCalls).toHaveLength(0);
  });
});
