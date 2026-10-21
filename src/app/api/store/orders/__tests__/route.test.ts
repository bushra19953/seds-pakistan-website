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
  it('status verified: exactly one order_payment_verified entry, state change applied', async () => {
    seedOrder('o-1', {});
    const res = await PATCH(
      authedRequest('PATCH', 'http://localhost/api/store/orders', {
        orderId: 'o-1',
        updates: { status: 'verified' },
      })
    );
    expect(res.status).toBe(200);
    expect(state.orders.get('o-1')!.status).toBe('verified');
    expect(state.auditEntries).toHaveLength(1);
    const entry = state.auditEntries[0];
    expect(entry.action).toBe('order_payment_verified');
    expect(entry.actorUid).toBe('admin-1');
    expect(entry.orderId).toBe('o-1');
    expect(entry.payload.before.status).toBe('pending_verification');
    expect(entry.payload.after.status).toBe('verified');
    expect(entry.payload.changedFields).toContain('status');
  });

  it('combined update (verified + completed): exactly ONE entry by precedence, changedFields has both keys', async () => {
    seedOrder('o-1', {});
    const res = await PATCH(
      authedRequest('PATCH', 'http://localhost/api/store/orders', {
        orderId: 'o-1',
        updates: { status: 'verified', paymentStatus: 'completed' },
      })
    );
    expect(res.status).toBe(200);
    expect(state.auditEntries).toHaveLength(1);
    expect(state.auditEntries[0].action).toBe('order_payment_verified');
    expect(state.auditEntries[0].payload.changedFields).toEqual(
      expect.arrayContaining(['status', 'paymentStatus'])
    );
  });

  it('paymentStatus completed alone: order_marked_paid', async () => {
    seedOrder('o-1', {});
    const res = await PATCH(
      authedRequest('PATCH', 'http://localhost/api/store/orders', {
        orderId: 'o-1',
        updates: { paymentStatus: 'completed' },
      })
    );
    expect(res.status).toBe(200);
    expect(state.auditEntries).toHaveLength(1);
    expect(state.auditEntries[0].action).toBe('order_marked_paid');
  });

  it('paymentStatus refunded: order_refunded', async () => {
    seedOrder('o-1', { status: 'verified', paymentStatus: 'completed' });
    const res = await PATCH(
      authedRequest('PATCH', 'http://localhost/api/store/orders', {
        orderId: 'o-1',
        updates: { paymentStatus: 'refunded' },
      })
    );
    expect(res.status).toBe(200);
    expect(state.auditEntries).toHaveLength(1);
    expect(state.auditEntries[0].action).toBe('order_refunded');
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
    const res = await PATCH(
      authedRequest('PATCH', 'http://localhost/api/store/orders', {
        orderId: 'ghost',
        updates: { status: 'verified' },
      })
    );
    expect(res.status).toBe(404);
    expect(state.auditEntries).toHaveLength(0);
  });
});

describe('DELETE /api/store/orders (Item 7)', () => {
  it('soft-deletes: doc remains with deletion metadata, one order_deleted entry', async () => {
    seedOrder('o-1', {});
    const res = await DELETE(
      authedRequest('DELETE', 'http://localhost/api/store/orders?orderId=o-1&reason=duplicate')
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);

    const stored = state.orders.get('o-1');
    expect(stored).toBeDefined();
    expect(stored!.deletedAt).toBeDefined();
    expect(stored!.deletedBy).toBe('admin-1');
    expect(stored!.deletedByRole).toBe('store_admin');
    expect(stored!.deleteReason).toBe('duplicate');
    expect(stored!.status).toBe('pending_verification'); // original status kept

    expect(state.auditEntries).toHaveLength(1);
    expect(state.auditEntries[0].action).toBe('order_deleted');
    expect(state.auditEntries[0].payload.reason).toBe('duplicate');
  });

  it('repeat DELETE is idempotent: alreadyDeleted true, still exactly one entry', async () => {
    seedOrder('o-1', {});
    await DELETE(authedRequest('DELETE', 'http://localhost/api/store/orders?orderId=o-1'));
    const res = await DELETE(
      authedRequest('DELETE', 'http://localhost/api/store/orders?orderId=o-1')
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alreadyDeleted).toBe(true);
    expect(state.auditEntries).toHaveLength(1);
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
