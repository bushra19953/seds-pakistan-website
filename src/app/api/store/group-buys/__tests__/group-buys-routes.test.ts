/**
 * @jest-environment node
 *
 * PLAN-gh 8.2: route tests for /api/store/group-buys, following the
 * orders route test precedent (mocked verifyIdToken and
 * permissions) with the real group-buys library over an in-memory
 * fake Firestore. The fake's runTransaction stages writes and
 * applies them only when the callback resolves (PLAN-gh 8.4).
 */

jest.mock('firebase-admin/firestore', () => {
  class FakeTimestamp {
    seconds: number;
    nanoseconds: number;
    constructor(seconds: number, nanoseconds = 0) {
      this.seconds = seconds;
      this.nanoseconds = nanoseconds;
    }
    static fromDate(d: Date) {
      return new FakeTimestamp(Math.floor(d.getTime() / 1000), (d.getTime() % 1000) * 1e6);
    }
    static fromMillis(ms: number) {
      return new FakeTimestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6);
    }
    static now() {
      return FakeTimestamp.fromDate(new Date());
    }
    toMillis() {
      return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6);
    }
    toDate() {
      return new Date(this.toMillis());
    }
  }
  return {
    Timestamp: FakeTimestamp,
    FieldValue: { serverTimestamp: () => ({ _serverTimestamp: true }) },
  };
});

jest.mock('@/lib/finance/money-approval', () => {
  const state = {
    nextId: 1,
    pending: new Map<string, string>(),
    calls: [] as Array<{ caller: any; input: any }>,
  };
  return {
    __approvalState: state,
    MoneyApprovalError: class MoneyApprovalError extends Error {
      status?: number;
      existingId?: string;
    },
    createMoneyApprovalRequest: jest.fn(async (_db: any, caller: any, input: any) => {
      state.calls.push({ caller, input });
      const key = `${input.targetType}:${input.targetId}`;
      const existing = state.pending.get(key);
      if (existing) {
        const e: any = new Error('A pending request already exists for this target');
        e.status = 409;
        e.existingId = existing;
        throw e;
      }
      const id = `approval-${state.nextId++}`;
      state.pending.set(key, id);
      return { id };
    }),
  };
});

const mockHolder: { db: any; permission: boolean } = { db: null, permission: true };

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    auth: () => ({
      verifyIdToken: async (token: string) => {
        if (token === 'bad-token') throw new Error('invalid token');
        return { uid: token };
      },
    }),
  },
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockHolder.db),
  ensureAdminInitialized: jest.fn(() => true),
  admin: {},
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => mockHolder.permission),
  resolveUserRole: jest.fn(async () => 'store_admin'),
}));

import { NextRequest } from 'next/server';
import { Timestamp } from 'firebase-admin/firestore';
import * as moneyApproval from '@/lib/finance/money-approval';
import { POST as createTeam } from '@/app/api/store/group-buys/route';
import { GET as getPublic } from '@/app/api/store/group-buys/[shareCode]/route';
import { POST as joinTeam } from '@/app/api/store/group-buys/[shareCode]/join/route';
import { POST as cancelTeam } from '@/app/api/store/group-buys/[shareCode]/cancel/route';
import { POST as overrideWindow } from '@/app/api/store/group-buys/[shareCode]/override-window/route';
import { POST as sweepExpired } from '@/app/api/store/group-buys/sweep-expired/route';

const approvalState = (moneyApproval as any).__approvalState as {
  nextId: number;
  pending: Map<string, string>;
  calls: Array<{ caller: any; input: any }>;
};

/* ------------------------------------------------------------ fake */

type Row = Record<string, any>;

function toMillis(v: any): number {
  if (v == null) return NaN;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  return NaN;
}

function compare(a: any, b: any): number {
  const am = toMillis(a);
  const bm = toMillis(b);
  if (Number.isFinite(am) && Number.isFinite(bm)) return am - bm;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

class FakeDb {
  stores = new Map<string, Map<string, Row>>();
  seq = 0;

  store(name: string): Map<string, Row> {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
    return this.stores.get(name)!;
  }

  collection(name: string) {
    const db = this;
    const makeQuery = (filters: Array<[string, string, any]> = [], orderField: string | null = null, limitN: number | null = null): any => ({
      where: (field: string, op: string, value: any) => makeQuery([...filters, [field, op, value]], orderField, limitN),
      orderBy: (field: string) => makeQuery(filters, field, limitN),
      limit: (n: number) => makeQuery(filters, orderField, n),
      get: async () => {
        let rows = [...db.store(name).entries()].map(([id, data]) => ({ id, data }));
        for (const [field, op, value] of filters) {
          rows = rows.filter((r) => {
            const v = r.data[field];
            if (op === '==') return v === value || (v == null && value == null);
            if (op === '<=') return compare(v, value) <= 0;
            if (op === '>=') return compare(v, value) >= 0;
            throw new Error(`unsupported op ${op}`);
          });
        }
        if (orderField) rows.sort((a, b) => compare(a.data[orderField], b.data[orderField]));
        if (limitN != null) rows = rows.slice(0, limitN);
        const docs = rows.map((r) => ({
          id: r.id,
          ref: db.docRef(name, r.id),
          data: () => structuredClone(r.data),
        }));
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
    });
    return {
      ...makeQuery(),
      doc: (id?: string) => db.docRef(name, id ?? `${name}-${++db.seq}`),
      add: async (data: Row) => {
        const id = `${name}-${++db.seq}`;
        db.store(name).set(id, structuredClone(data));
        return { id };
      },
    };
  }

  docRef(collectionName: string, id: string) {
    const db = this;
    return {
      id,
      path: `${collectionName}/${id}`,
      get: async () => {
        const data = db.store(collectionName).get(id);
        return {
          exists: !!data,
          id,
          data: () => (data ? structuredClone(data) : undefined),
        };
      },
      set: async (data: Row) => {
        db.store(collectionName).set(id, structuredClone(data));
      },
      update: async (data: Row) => {
        const cur = db.store(collectionName).get(id);
        if (!cur) throw new Error(`update on missing doc ${collectionName}/${id}`);
        db.store(collectionName).set(id, { ...cur, ...structuredClone(data) });
      },
    };
  }

  async runTransaction(fn: (tx: any) => Promise<any>) {
    const staged: Array<{ ref: any; kind: 'set' | 'update'; data: Row }> = [];
    const tx = {
      get: async (ref: any) => ref.get(),
      update: (ref: any, data: Row) => staged.push({ ref, kind: 'update', data }),
      set: (ref: any, data: Row) => staged.push({ ref, kind: 'set', data }),
      create: (ref: any, data: Row) => staged.push({ ref, kind: 'set', data }),
    };
    const result = await fn(tx);
    for (const op of staged) {
      if (op.kind === 'set') await op.ref.set(op.data);
      else await op.ref.update(op.data);
    }
    return result;
  }
}

/* ---------------------------------------------------------- seeding */

const NOW = new Date('2026-10-31T10:00:00Z');
let db: FakeDb;

function ts(d: Date) {
  return (Timestamp as any).fromDate(d);
}

function seedProduct(id = 'p1', overrides: Row = {}) {
  db.store('products').set(id, {
    name: 'Widget',
    price: 4500,
    stock: 5,
    isActive: true,
    vendorId: 'v1',
    groupBuyEligible: true,
    groupBuyTeamSize: 3,
    groupBuyWindowHours: 48,
    deliveryChargePkr: 300,
    imageUrl: null,
    ...overrides,
  });
  db.store('vendors').set('v1', { status: 'active', businessName: 'Fixture Vendor' });
}

function seedTeam(id: string, overrides: Row = {}) {
  db.store('group_buys').set(id, {
    productId: 'p1',
    vendorId: 'v1',
    // Coordinator (merge gate): real share codes are uppercase Crockford
    // and resolveGroupBuyByShareCode normalizes lookups to uppercase, so
    // the seeded code must be uppercase too ('CODET1', not 'CODEt1').
    shareCode: `CODE${id}`.toUpperCase(),
    openerUserId: 'opener-1',
    unitPricePkr: 4500,
    teamSizeTarget: 3,
    memberOrderIds: [],
    memberUserIds: [],
    state: 'open',
    opensAt: ts(new Date(NOW.getTime() - 3600 * 1000)),
    expiresAt: ts(new Date(NOW.getTime() + 47 * 3600 * 1000)),
    refundApprovalIds: [],
    expiryClaimedAt: null,
    expiryProcessedAt: null,
    createdAt: ts(NOW),
    updatedAt: ts(NOW),
    ...overrides,
  });
}

function seedOrder(id: string, overrides: Row = {}) {
  db.store('orders').set(id, {
    status: 'pending_verification',
    paymentStatus: 'pending',
    buyerUserId: 'buyer-1',
    ...overrides,
  });
}

function team(id: string): Row {
  return db.store('group_buys').get(id)!;
}

function req(method: string, url: string, opts: { token?: string; body?: unknown } = {}) {
  return new NextRequest(url, {
    method,
    headers: {
      ...(opts.token ? { authorization: 'Bearer ' + opts.token } : {}),
      'content-type': 'application/json',
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

const params = (shareCode: string) => ({ params: Promise.resolve({ shareCode }) });

beforeEach(() => {
  db = new FakeDb();
  mockHolder.db = db;
  mockHolder.permission = true;
  approvalState.nextId = 1;
  approvalState.pending = new Map();
  approvalState.calls = [];
  seedProduct();
});

/* ------------------------------------------------------------ tests */

describe('POST create', () => {
  it('POST create: unauthenticated returns 401', async () => {
    const res = await createTeam(req('POST', 'http://localhost/api/store/group-buys', { body: { productId: 'p1' } }));
    expect(res.status).toBe(401);
    expect(db.store('group_buys').size).toBe(0);
  });

  it('POST create: creates an open team, locks the product price, ignores client sent price, target and window', async () => {
    const res = await createTeam(
      req('POST', 'http://localhost/api/store/group-buys', {
        token: 'opener-9',
        body: { productId: 'p1', unitPricePkr: 1, teamSizeTarget: 5, groupBuyWindowHours: 1, shareCode: 'HACKHACKHACK', state: 'filled' },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.unitPricePkr).toBe(4500);
    expect(body.teamSizeTarget).toBe(3);
    expect(body.shareCode).not.toBe('HACKHACKHACK');
    const created = team(body.groupBuyId);
    expect(created.state).toBe('open');
    expect(created.openerUserId).toBe('opener-9');
    expect(created.unitPricePkr).toBe(4500);
    expect(created.memberOrderIds).toEqual([]);
  });

  it('POST create: ineligible product returns 422', async () => {
    seedProduct('p2', { groupBuyEligible: false });
    const res = await createTeam(
      req('POST', 'http://localhost/api/store/group-buys', { token: 'opener-9', body: { productId: 'p2' } }),
    );
    expect(res.status).toBe(422);
  });

  it('POST create: product with stock 0 returns 422', async () => {
    seedProduct('p3', { stock: 0 });
    const res = await createTeam(
      req('POST', 'http://localhost/api/store/group-buys', { token: 'opener-9', body: { productId: 'p3' } }),
    );
    expect(res.status).toBe(422);
  });
});

describe('GET public', () => {
  it('GET public: signed out request returns product, locked price, seats and time fields', async () => {
    seedTeam('t1', { memberOrderIds: ['order-secret-1'], memberUserIds: ['opener-1'] });
    seedOrder('order-secret-1', { status: 'verified', paymentStatus: 'completed' });
    db.store('users').set('opener-1', { displayName: 'Ayesha Khan' });
    const res = await getPublic(req('GET', 'http://localhost/api/store/group-buys/CODEt1'), params('CODEt1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.product.name).toBe('Widget');
    expect(body.unitPricePkr).toBe(4500);
    expect(body.seatsFilled).toBe(1);
    expect(body.teamSizeTarget).toBe(3);
    expect(body.expiresAt).toBeTruthy();
    expect(body.serverNow).toBeTruthy();
    expect(body.openerFirstName).toBe('Ayesha');
    expect(body.members).toEqual([{ isOpener: true, seated: true, paymentState: 'paid' }]);
  });

  it('GET public: response contains no member ids, order ids, emails, phones or approval ids', async () => {
    seedTeam('t1', {
      memberOrderIds: ['order-secret-1'],
      memberUserIds: ['member-secret-1'],
      refundApprovalIds: ['approval-secret-1'],
    });
    seedOrder('order-secret-1', { status: 'verified', paymentStatus: 'completed' });
    db.store('users').set('opener-1', { displayName: 'Ayesha Khan', email: 'ayesha@example.com', phone: '0300' });
    const res = await getPublic(req('GET', 'http://localhost/api/store/group-buys/CODEt1'), params('CODEt1'));
    const body = await res.json();
    const keys = new Set<string>();
    const walk = (v: any) => {
      if (v && typeof v === 'object') {
        for (const [k, val] of Object.entries(v)) {
          keys.add(k);
          walk(val);
        }
      }
    };
    walk(body);
    for (const forbidden of ['memberUserIds', 'memberOrderIds', 'openerUserId', 'email', 'phone', 'address', 'refundApprovalIds', 'vendorId', 'costPricePkr']) {
      expect(keys.has(forbidden)).toBe(false);
    }
    const text = JSON.stringify(body);
    expect(text).not.toContain('order-secret-1');
    expect(text).not.toContain('member-secret-1');
    expect(text).not.toContain('approval-secret-1');
    expect(text).not.toContain('ayesha@example.com');
  });

  it('GET public: unknown shareCode returns 404', async () => {
    const res = await getPublic(req('GET', 'http://localhost/api/store/group-buys/NOPE'), params('NOPE'));
    expect(res.status).toBe(404);
  });

  it('GET public: due team reads as expired (lazy claim on read)', async () => {
    seedTeam('t1', { expiresAt: ts(new Date(Date.now() - 3600 * 1000)) });
    const res = await getPublic(req('GET', 'http://localhost/api/store/group-buys/CODEt1'), params('CODEt1'));
    const body = await res.json();
    expect(body.state).toBe('expired');
    expect(team('t1').state).toBe('expired');
  });
});

describe('POST join', () => {
  it('POST join: returns the checkout handoff with groupBuyId and writes nothing to the team', async () => {
    seedTeam('t1');
    const before = structuredClone(team('t1'));
    const res = await joinTeam(
      req('POST', 'http://localhost/api/store/group-buys/CODEt1/join', { token: 'buyer-7' }),
      params('CODEt1'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checkoutUrl).toBe('/checkout?productId=p1&groupBuyId=t1');
    expect(team('t1')).toEqual(before);
  });

  it('POST join: filled team returns 409', async () => {
    seedTeam('t1', { state: 'filled', memberOrderIds: ['o1', 'o2', 'o3'], memberUserIds: ['u1', 'u2', 'u3'] });
    const res = await joinTeam(
      req('POST', 'http://localhost/api/store/group-buys/CODEt1/join', { token: 'buyer-7' }),
      params('CODEt1'),
    );
    expect(res.status).toBe(409);
  });

  it('POST join: expired team returns 409 TEAM_EXPIRED', async () => {
    seedTeam('t1', { state: 'expired', expiryClaimedAt: ts(NOW) });
    const res = await joinTeam(
      req('POST', 'http://localhost/api/store/group-buys/CODEt1/join', { token: 'buyer-7' }),
      params('CODEt1'),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('TEAM_EXPIRED');
  });

  it('POST join: already seated user returns 409 ALREADY_SEATED', async () => {
    seedTeam('t1', { memberOrderIds: ['o1'], memberUserIds: ['buyer-7'] });
    seedOrder('o1');
    const res = await joinTeam(
      req('POST', 'http://localhost/api/store/group-buys/CODEt1/join', { token: 'buyer-7' }),
      params('CODEt1'),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_SEATED');
  });

  it('POST join: opener without a seat receives his own handoff', async () => {
    seedTeam('t1');
    const res = await joinTeam(
      req('POST', 'http://localhost/api/store/group-buys/CODEt1/join', { token: 'opener-1' }),
      params('CODEt1'),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).checkoutUrl).toContain('groupBuyId=t1');
  });
});

describe('POST cancel', () => {
  it('POST cancel: non-opener returns 403', async () => {
    seedTeam('t1');
    const res = await cancelTeam(
      req('POST', 'http://localhost/api/store/group-buys/CODEt1/cancel', { token: 'buyer-7' }),
      params('CODEt1'),
    );
    expect(res.status).toBe(403);
    expect(team('t1').state).toBe('open');
  });

  it('POST cancel: opener with another seated member returns 409', async () => {
    seedTeam('t1', { memberOrderIds: ['o1', 'o2'], memberUserIds: ['opener-1', 'buyer-7'] });
    seedOrder('o1');
    seedOrder('o2');
    const res = await cancelTeam(
      req('POST', 'http://localhost/api/store/group-buys/CODEt1/cancel', { token: 'opener-1' }),
      params('CODEt1'),
    );
    expect(res.status).toBe(409);
    expect(team('t1').state).toBe('open');
  });

  it('POST cancel: sole opener cancels and his pending order follows transition 2', async () => {
    seedTeam('t1', { memberOrderIds: ['o1'], memberUserIds: ['opener-1'] });
    seedOrder('o1', { status: 'pending_verification', paymentStatus: 'pending', buyerUserId: 'opener-1' });
    const res = await cancelTeam(
      req('POST', 'http://localhost/api/store/group-buys/CODEt1/cancel', { token: 'opener-1' }),
      params('CODEt1'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe('cancelled');
    expect(body.openerOrderOutcome).toBe('cancelled');
    expect(team('t1').state).toBe('cancelled');
    expect(db.store('orders').get('o1')!.status).toBe('cancelled');
  });
});

describe('POST override-window', () => {
  it('POST override-window: non-admin returns 403', async () => {
    mockHolder.permission = false;
    seedTeam('t1');
    const res = await overrideWindow(
      req('POST', 'http://localhost/api/store/group-buys/CODEt1/override-window', { token: 'buyer-7', body: { windowHours: 1 } }),
      params('CODEt1'),
    );
    expect(res.status).toBe(403);
  });

  it('POST override-window: shortens expiresAt to opensAt plus one hour and writes an audit entry', async () => {
    const opens = new Date('2026-10-31T09:00:00Z');
    seedTeam('t1', {
      opensAt: ts(opens),
      expiresAt: ts(new Date(opens.getTime() + 48 * 3600 * 1000)),
    });
    const res = await overrideWindow(
      req('POST', 'http://localhost/api/store/group-buys/CODEt1/override-window', { token: 'admin-1', body: { windowHours: 1 } }),
      params('CODEt1'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.expiresAt).toBe('2026-10-31T10:00:00.000Z');
    const audits = [...db.store('audit_logs').values()];
    expect(audits.some((a) => a.action === 'GROUP_BUY_WINDOW_OVERRIDDEN')).toBe(true);
  });

  it('POST override-window: extending the window returns 422', async () => {
    seedTeam('t1');
    const res = await overrideWindow(
      req('POST', 'http://localhost/api/store/group-buys/CODEt1/override-window', { token: 'admin-1', body: { windowHours: 100 } }),
      params('CODEt1'),
    );
    expect(res.status).toBe(422);
  });
});

describe('POST sweep', () => {
  it('POST sweep: unauthenticated returns 401 and processes nothing', async () => {
    seedTeam('t1', { expiresAt: ts(new Date(Date.now() - 3600 * 1000)) });
    const res = await sweepExpired(req('POST', 'http://localhost/api/store/group-buys/sweep-expired', { body: {} }));
    expect(res.status).toBe(401);
    expect(team('t1').state).toBe('open');
  });

  it('POST sweep: admin sweep expires due teams and reports counts', async () => {
    seedTeam('t1', {
      expiresAt: ts(new Date(Date.now() - 3600 * 1000)),
      memberOrderIds: ['o1', 'o2'],
      memberUserIds: ['u1', 'u2'],
    });
    seedOrder('o1', { status: 'pending_verification', paymentStatus: 'pending' });
    seedOrder('o2', { status: 'verified', paymentStatus: 'completed' });
    const res = await sweepExpired(
      req('POST', 'http://localhost/api/store/group-buys/sweep-expired', { token: 'admin-1', body: {} }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claimed).toBe(1);
    expect(body.cancelledOrders).toBe(1);
    expect(body.refundApprovalsCreated).toBe(1);
    expect(team('t1').state).toBe('expired');
    expect(team('t1').refundApprovalIds).toEqual(['approval-1']);
  });

  it('POST sweep: filled teams past expiresAt are left untouched', async () => {
    seedTeam('t1', {
      state: 'filled',
      expiresAt: ts(new Date(Date.now() - 3600 * 1000)),
      memberOrderIds: ['o1', 'o2', 'o3'],
      memberUserIds: ['u1', 'u2', 'u3'],
    });
    const res = await sweepExpired(
      req('POST', 'http://localhost/api/store/group-buys/sweep-expired', { token: 'admin-1', body: {} }),
    );
    expect(res.status).toBe(200);
    expect(team('t1').state).toBe('filled');
  });
});
