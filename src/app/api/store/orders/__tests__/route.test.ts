/**
 * @jest-environment node
 *
 * Tests for /api/store/orders (Item 7, spec section (f) suite 1):
 * every money action writes exactly ONE audit_logs entry in the same
 * batch as the state change; DELETE is a soft delete; GET hides
 * soft-deleted orders unless includeDeleted=true.
 */

import { NextRequest } from 'next/server';

const state = {
  decoded: { uid: 'admin-1', role: 'store_admin' } as any,
  permissionGranted: true,
  orders: new Map<string, Record<string, any>>(),
  auditEntries: [] as Array<any>,
};

let auditSeq = 0;

function makeOrderRef(id: string) {
  return {
    id,
    path: `orders/${id}`,
    get: async () => {
      const data = state.orders.get(id);
      return {
        exists: !!data,
        id,
        data: () => (data ? { ...data } : undefined),
      };
    },
  };
}

function makeOrdersQuery(filters: Array<[string, unknown]> = [], limitN?: number) {
  const q: any = {
    where: (f: string, _op: string, v: unknown) => makeOrdersQuery([...filters, [f, v]], limitN),
    orderBy: () => q,
    startAfter: () => q,
    limit: (n: number) => makeOrdersQuery(filters, n),
    get: async () => {
      let rows = [...state.orders.entries()].map(([id, data]) => ({ id, data }));
      for (const [f, v] of filters) rows = rows.filter((r) => r.data[f] === v);
      if (limitN) rows = rows.slice(0, limitN);
      const docs = rows.map((r) => ({
        id: r.id,
        data: () => ({ ...r.data }),
      }));
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  };
  return q;
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'orders') {
      return {
        ...makeOrdersQuery(),
        doc: (id: string) => makeOrderRef(id),
        add: async (data: any) => {
          const id = `order-${state.orders.size + 1}`;
          state.orders.set(id, data);
          return { id };
        },
      };
    }
    if (name === 'products') {
      return { get: async () => ({ docs: [], size: 0, empty: true }) };
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
    const ops: Array<{ kind: string; ref: any; data: any }> = [];
    return {
      update: (ref: any, data: any) => ops.push({ kind: 'update', ref, data }),
      set: (ref: any, data: any) => ops.push({ kind: 'set', ref, data }),
      commit: async () => {
        for (const o of ops) {
          if (o.ref.path?.startsWith('audit_logs/')) {
            state.auditEntries.push(o.data);
          } else if (o.ref.path?.startsWith('orders/')) {
            const cur = state.orders.get(o.ref.id) || {};
            state.orders.set(o.ref.id, { ...cur, ...o.data });
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

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: jest.fn(async () => undefined),
    broadcastByRoles: jest.fn(async () => undefined),
  },
}));

import { GET, PATCH, DELETE } from '@/app/api/store/orders/route';

function ts(iso: string) {
  const d = new Date(iso);
  return { toDate: () => d, toMillis: () => d.getTime() };
}

function seedOrder(id: string, data: Record<string, any>) {
  state.orders.set(id, {
    status: 'pending_verification',
    paymentStatus: null,
    amount: 1500,
    items: [],
    buyerUserId: 'buyer-1',
    createdAt: ts('2026-10-01T00:00:00Z'),
    updatedAt: ts('2026-10-01T00:00:00Z'),
    ...data,
  });
}

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
  state.orders = new Map();
  state.auditEntries = [];
  jest.clearAllMocks();
});

describe('PATCH /api/store/orders (Item 7)', () => {
  // INTEGRATION (step 11): the four direct-PATCH money tests that stood
  // here (status verified / combined / paymentStatus completed /
  // paymentStatus refunded, each expecting a 200 + one audit entry) are
  // SUPERSEDED by Finance CH-13: money-field PATCHes are refused 409 and
  // money changes happen only through the maker-checker approvals flow
  // (pinned by orders-route.test.ts). What survives of Item 7 on this
  // route is the audit batch for the updates that remain legal
  // (fulfilment statuses - see 'plain status change' below) and the
  // soft-delete GET filter. The two tests below pin the merged behavior
  // in this suite's harness.
  it('money-field PATCH (status verified) is 409: no state change, zero audit entries', async () => {
    seedOrder('o-1', {});
    const res = await PATCH(
      authedRequest('PATCH', 'http://localhost/api/store/orders', {
        orderId: 'o-1',
        updates: { status: 'verified' },
      })
    );
    expect(res.status).toBe(409);
    expect(state.orders.get('o-1')!.status).toBe('pending_verification');
    expect(state.auditEntries).toHaveLength(0);
  });

  it('money-field PATCH (paymentStatus refunded) is 409: no state change, zero audit entries', async () => {
    seedOrder('o-1', {});
    const res = await PATCH(
      authedRequest('PATCH', 'http://localhost/api/store/orders', {
        orderId: 'o-1',
        updates: { paymentStatus: 'refunded' },
      })
    );
    expect(res.status).toBe(409);
    expect(state.auditEntries).toHaveLength(0);
  });

  it('plain status change: order_status_updated', async () => {
    seedOrder('o-1', { status: 'verified' });
    const res = await PATCH(
      authedRequest('PATCH', 'http://localhost/api/store/orders', {
        orderId: 'o-1',
        updates: { status: 'shipped' },
      })
    );
    expect(res.status).toBe(200);
    expect(state.auditEntries).toHaveLength(1);
    expect(state.auditEntries[0].action).toBe('order_status_updated');
  });

  it('no canManageStore: 403 and zero audit entries', async () => {
    state.permissionGranted = false;
    seedOrder('o-1', {});
    const res = await PATCH(
      authedRequest('PATCH', 'http://localhost/api/store/orders', {
        orderId: 'o-1',
        updates: { status: 'verified' },
      })
    );
    expect(res.status).toBe(403);
    expect(state.auditEntries).toHaveLength(0);
    expect(state.orders.get('o-1')!.status).toBe('pending_verification');
  });

  it('missing order: 404 and zero audit entries', async () => {
    // Fulfilment status (not a money field): the CH-13 guard does not
    // fire, so the missing-order 404 path is what answers.
    const res = await PATCH(
      authedRequest('PATCH', 'http://localhost/api/store/orders', {
        orderId: 'ghost',
        updates: { status: 'processing' },
      })
    );
    expect(res.status).toBe(404);
    expect(state.auditEntries).toHaveLength(0);
  });
});

describe('DELETE /api/store/orders (Item 7)', () => {
  // INTEGRATION (step 11): the two in-route soft-delete tests that stood
  // here are SUPERSEDED by Finance CH-13: this route's DELETE is 410 and
  // removal happens as a soft delete through the approvals flow
  // (targetType order_soft_delete; pinned by orders-route.test.ts). The
  // soft-delete FIELDS and the GET filter below remain Phase 0 behavior.
  it('DELETE is 410: order untouched, zero audit entries', async () => {
    seedOrder('o-1', {});
    const res = await DELETE(
      authedRequest('DELETE', 'http://localhost/api/store/orders?orderId=o-1&reason=duplicate')
    );
    expect(res.status).toBe(410);
    const stored = state.orders.get('o-1');
    expect(stored).toBeDefined();
    expect(stored!.deletedAt).toBeUndefined();
    expect(state.auditEntries).toHaveLength(0);
  });

  it('no canManageStore: 403, order not stamped, zero entries', async () => {
    state.permissionGranted = false;
    seedOrder('o-1', {});
    const res = await DELETE(
      authedRequest('DELETE', 'http://localhost/api/store/orders?orderId=o-1')
    );
    expect(res.status).toBe(403);
    expect(state.orders.get('o-1')!.deletedAt).toBeUndefined();
    expect(state.auditEntries).toHaveLength(0);
  });
});

describe('GET /api/store/orders soft-delete filter (Item 7)', () => {
  it('default excludes soft-deleted; includeDeleted=true returns all three shapes', async () => {
    seedOrder('o-legacy', {}); // no deletedAt field at all
    seedOrder('o-null', { deletedAt: null });
    seedOrder('o-deleted', { deletedAt: ts('2026-10-05T00:00:00Z') });

    const resDefault = await GET(
      authedRequest('GET', 'http://localhost/api/store/orders?limit=50')
    );
    expect(resDefault.status).toBe(200);
    const bodyDefault = await resDefault.json();
    const defaultIds = bodyDefault.orders.map((o: any) => o.id).sort();
    expect(defaultIds).toEqual(['o-legacy', 'o-null']);

    const resAll = await GET(
      authedRequest('GET', 'http://localhost/api/store/orders?limit=50&includeDeleted=true')
    );
    const bodyAll = await resAll.json();
    const allIds = bodyAll.orders.map((o: any) => o.id).sort();
    expect(allIds).toEqual(['o-deleted', 'o-legacy', 'o-null']);
  });
});
