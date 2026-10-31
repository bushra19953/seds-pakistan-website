/**
 * @jest-environment node
 *
 * PLAN-gh 8.1: library tests for the group buy state machine.
 * Fixtures only. The fake Firestore below implements the one hard
 * requirement of PLAN-gh 8.4: runTransaction stages writes and
 * applies them only when the callback resolves, so a throwing
 * transaction (the expiry claim inside register, a rejected seat)
 * leaves no partial writes behind.
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

import { Timestamp } from 'firebase-admin/firestore';
import * as moneyApproval from '@/lib/finance/money-approval';
import {
  GroupBuyError,
  checkAndCompleteGroupBuy,
  claimGroupBuyExpired,
  createGroupBuyTeam,
  generateShareCode,
  processExpiredGroupBuy,
  registerGroupBuySeat,
  releaseGroupBuySeat,
} from '@/lib/server/group-buys';

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
    const db = this;
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

function seedProduct(overrides: Row = {}) {
  db.store('products').set('p1', {
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
    shareCode: `CODE${id}`,
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

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
  await expect(promise.catch((e) => e)).resolves.toBeInstanceOf(GroupBuyError);
}

beforeEach(() => {
  db = new FakeDb();
  approvalState.nextId = 1;
  approvalState.pending = new Map();
  approvalState.calls = [];
  seedProduct();
});

/* ------------------------------------------------------------ tests */

describe('shareCode', () => {
  it('shareCode: generates 12 chars from the Crockford alphabet', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateShareCode()).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{12}$/);
    }
  });

  it('shareCode: regenerates on collision and succeeds', async () => {
    seedTeam('existing', { shareCode: 'AAAAAAAAAAAA' });
    const crypto = jest.requireActual('crypto');
    const original = crypto.randomInt;
    let calls = 0;
    (jest.spyOn(crypto, 'randomInt') as any).mockImplementation((...args: any[]) => {
      calls += 1;
      // 'A' is index 10 in the Crockford alphabet: the first 12 draws
      // spell the seeded code and collide; later draws are real.
      if (calls <= 12) return 10;
      return (original as any)(...args);
    });
    try {
      const created = await createGroupBuyTeam(db as any, {
        openerUserId: 'opener-1',
        productId: 'p1',
        now: NOW,
      });
      expect(created.shareCode).not.toBe('AAAAAAAAAAAA');
      expect(created.shareCode).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{12}$/);
    } finally {
      jest.restoreAllMocks();
    }
  });
});

describe('register', () => {
  it('register: appends the seat and keeps the member arrays parallel', async () => {
    seedTeam('t1');
    const result = await registerGroupBuySeat(db as any, {
      groupBuyId: 't1',
      orderId: 'o1',
      userId: 'buyer-1',
      productId: 'p1',
      now: NOW,
    });
    expect(result.outcome).toBe('registered');
    expect(team('t1').memberOrderIds).toEqual(['o1']);
    expect(team('t1').memberUserIds).toEqual(['buyer-1']);
    expect(team('t1').memberOrderIds.length).toBe(team('t1').memberUserIds.length);
  });

  it('register: flips open to filled exactly at teamSizeTarget', async () => {
    seedTeam('t1');
    await registerGroupBuySeat(db as any, { groupBuyId: 't1', orderId: 'o1', userId: 'u1', productId: 'p1', now: NOW });
    const second = await registerGroupBuySeat(db as any, { groupBuyId: 't1', orderId: 'o2', userId: 'u2', productId: 'p1', now: NOW });
    expect(second.state).toBe('open');
    const third = await registerGroupBuySeat(db as any, { groupBuyId: 't1', orderId: 'o3', userId: 'u3', productId: 'p1', now: NOW });
    expect(third.state).toBe('filled');
    expect(team('t1').state).toBe('filled');
  });

  it('register: second seat for the same user throws ALREADY_SEATED', async () => {
    seedTeam('t1');
    await registerGroupBuySeat(db as any, { groupBuyId: 't1', orderId: 'o1', userId: 'u1', productId: 'p1', now: NOW });
    await expectCode(
      registerGroupBuySeat(db as any, { groupBuyId: 't1', orderId: 'o2', userId: 'u1', productId: 'p1', now: NOW }),
      'ALREADY_SEATED',
    );
  });

  it('register: same orderId replay returns already_registered and writes nothing', async () => {
    seedTeam('t1');
    await registerGroupBuySeat(db as any, { groupBuyId: 't1', orderId: 'o1', userId: 'u1', productId: 'p1', now: NOW });
    const before = structuredClone(team('t1'));
    const replay = await registerGroupBuySeat(db as any, { groupBuyId: 't1', orderId: 'o1', userId: 'u1', productId: 'p1', now: NOW });
    expect(replay.outcome).toBe('already_registered');
    expect(team('t1')).toEqual(before);
  });

  it('register: same orderId with a different user throws SEAT_ORDER_CONFLICT', async () => {
    seedTeam('t1');
    await registerGroupBuySeat(db as any, { groupBuyId: 't1', orderId: 'o1', userId: 'u1', productId: 'p1', now: NOW });
    await expectCode(
      registerGroupBuySeat(db as any, { groupBuyId: 't1', orderId: 'o1', userId: 'u2', productId: 'p1', now: NOW }),
      'SEAT_ORDER_CONFLICT',
    );
  });

  it('register: full team throws TEAM_FULL', async () => {
    seedTeam('t1', {
      state: 'open',
      memberOrderIds: ['o1', 'o2', 'o3'],
      memberUserIds: ['u1', 'u2', 'u3'],
      teamSizeTarget: 3,
    });
    // A filled flip would normally have fired; force the defensive
    // branch by keeping state open with a full array (array is truth).
    await expectCode(
      registerGroupBuySeat(db as any, { groupBuyId: 't1', orderId: 'o4', userId: 'u4', productId: 'p1', now: NOW }),
      'TEAM_FULL',
    );
  });

  it('register: wrong product throws PRODUCT_MISMATCH', async () => {
    seedTeam('t1');
    await expectCode(
      registerGroupBuySeat(db as any, { groupBuyId: 't1', orderId: 'o1', userId: 'u1', productId: 'other', now: NOW }),
      'PRODUCT_MISMATCH',
    );
  });

  it('register: due team is claimed expired inside the transaction and throws TEAM_EXPIRED', async () => {
    seedTeam('t1', { expiresAt: ts(new Date(NOW.getTime() - 1000)) });
    await expectCode(
      registerGroupBuySeat(db as any, { groupBuyId: 't1', orderId: 'o1', userId: 'u1', productId: 'p1', now: NOW }),
      'TEAM_EXPIRED',
    );
    expect(team('t1').state).toBe('expired');
    expect(team('t1').expiryClaimedAt).not.toBeNull();
    expect(team('t1').memberOrderIds).toEqual([]);
  });
});

describe('release', () => {
  it('release: removes the pair and drops filled back to open', async () => {
    seedTeam('t1', {
      state: 'filled',
      memberOrderIds: ['o1', 'o2', 'o3'],
      memberUserIds: ['u1', 'u2', 'u3'],
    });
    const result = await releaseGroupBuySeat(db as any, {
      groupBuyId: 't1',
      orderId: 'o2',
      userId: 'u2',
      reason: 'order_cancelled',
      now: NOW,
    });
    expect(result.outcome).toBe('released');
    expect(result.state).toBe('open');
    expect(team('t1').memberOrderIds).toEqual(['o1', 'o3']);
    expect(team('t1').memberUserIds).toEqual(['u1', 'u3']);
  });

  it('release: unknown orderId is a no-op (not_seated)', async () => {
    seedTeam('t1');
    const result = await releaseGroupBuySeat(db as any, {
      groupBuyId: 't1',
      orderId: 'missing',
      userId: 'u9',
      reason: 'order_creation_failed',
      now: NOW,
    });
    expect(result.outcome).toBe('not_seated');
    expect(team('t1').memberOrderIds).toEqual([]);
  });

  it('release: terminal team arrays are not rewritten', async () => {
    seedTeam('t1', {
      state: 'expired',
      memberOrderIds: ['o1'],
      memberUserIds: ['u1'],
    });
    const before = structuredClone(team('t1'));
    const result = await releaseGroupBuySeat(db as any, {
      groupBuyId: 't1',
      orderId: 'o1',
      userId: 'u1',
      reason: 'order_refunded',
      now: NOW,
    });
    expect(result.outcome).toBe('team_terminal');
    expect(team('t1')).toEqual(before);
  });
});

describe('completion', () => {
  it('completion: all member orders delivered flips filled to completed', async () => {
    seedTeam('t1', { state: 'filled', memberOrderIds: ['o1', 'o2'], memberUserIds: ['u1', 'u2'] });
    seedOrder('o1', { status: 'delivered' });
    seedOrder('o2', { status: 'delivered' });
    const result = await checkAndCompleteGroupBuy(db as any, 't1');
    expect(result.outcome).toBe('completed');
    expect(team('t1').state).toBe('completed');
  });

  it('completion: one undelivered member order leaves the team filled', async () => {
    seedTeam('t1', { state: 'filled', memberOrderIds: ['o1', 'o2'], memberUserIds: ['u1', 'u2'] });
    seedOrder('o1', { status: 'delivered' });
    seedOrder('o2', { status: 'shipped' });
    const result = await checkAndCompleteGroupBuy(db as any, 't1');
    expect(result.outcome).toBe('orders_pending');
    expect(team('t1').state).toBe('filled');
  });

  it('completion: open team with all seated orders delivered does not complete', async () => {
    seedTeam('t1', { state: 'open', memberOrderIds: ['o1'], memberUserIds: ['u1'] });
    seedOrder('o1', { status: 'delivered' });
    const result = await checkAndCompleteGroupBuy(db as any, 't1');
    expect(result.outcome).toBe('not_filled');
    expect(team('t1').state).toBe('open');
  });

  it('completion: a refunded member order blocks completion', async () => {
    seedTeam('t1', { state: 'filled', memberOrderIds: ['o1', 'o2'], memberUserIds: ['u1', 'u2'] });
    seedOrder('o1', { status: 'delivered' });
    seedOrder('o2', { status: 'refunded', paymentStatus: 'refunded' });
    const result = await checkAndCompleteGroupBuy(db as any, 't1');
    expect(result.outcome).toBe('orders_pending');
    expect(team('t1').state).toBe('filled');
  });
});

describe('expiry claim', () => {
  it('expiry claim: only the first claimer wins', async () => {
    seedTeam('t1', { expiresAt: ts(new Date(NOW.getTime() - 1000)) });
    const first = await claimGroupBuyExpired(db as any, 't1', NOW);
    const second = await claimGroupBuyExpired(db as any, 't1', NOW);
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    expect(second.state).toBe('expired');
  });

  it('expiry claim: team not yet due is not claimed', async () => {
    seedTeam('t1');
    const result = await claimGroupBuyExpired(db as any, 't1', NOW);
    expect(result.claimed).toBe(false);
    expect(team('t1').state).toBe('open');
  });
});

describe('expiry processing', () => {
  const maker = { uid: 'admin-1', role: 'store_admin' };

  function dueTeam(overrides: Row = {}) {
    seedTeam('t1', {
      expiresAt: ts(new Date(NOW.getTime() - 1000)),
      ...overrides,
    });
  }

  it('expiry processing: pending order is cancelled and its escrow marked refunded', async () => {
    dueTeam({ memberOrderIds: ['o1'], memberUserIds: ['u1'] });
    seedOrder('o1', { status: 'pending_verification', paymentStatus: 'pending' });
    const summary = await processExpiredGroupBuy(db as any, 't1', { maker, trigger: 'sweep', now: NOW });
    expect(summary.cancelledOrderIds).toEqual(['o1']);
    expect(db.store('orders').get('o1')!.status).toBe('cancelled');
    expect(db.store('orders').get('o1')!.escrowStatus).toBe('refunded');
    expect(summary.processed).toBe(true);
    expect(team('t1').expiryProcessedAt).not.toBeNull();
  });

  it('expiry processing: verified order gets one full-refund request with the exact reason', async () => {
    dueTeam({ memberOrderIds: ['o1'], memberUserIds: ['u1'] });
    seedOrder('o1', { status: 'verified', paymentStatus: 'completed' });
    const summary = await processExpiredGroupBuy(db as any, 't1', { maker, trigger: 'sweep', now: NOW });
    expect(approvalState.calls).toHaveLength(1);
    expect(approvalState.calls[0].input).toMatchObject({
      targetType: 'order_refund',
      targetId: 'o1',
      changePayload: {},
      reason: 'Group buy team expired before it filled. Full refund, delivery included.',
    });
    expect(approvalState.calls[0].caller).toEqual(maker);
    expect(summary.refundApprovalIds).toEqual(['approval-1']);
    expect(team('t1').refundApprovalIds).toEqual(['approval-1']);
  });

  it('expiry processing: processing order is treated as paid (refund bucket)', async () => {
    dueTeam({ memberOrderIds: ['o1'], memberUserIds: ['u1'] });
    seedOrder('o1', { status: 'processing', paymentStatus: 'completed' });
    const summary = await processExpiredGroupBuy(db as any, 't1', { maker, trigger: 'sweep', now: NOW });
    expect(summary.refundApprovalIds).toEqual(['approval-1']);
    expect(summary.cancelledOrderIds).toEqual([]);
  });

  it('expiry processing: shipped order is skipped and reported in transit', async () => {
    dueTeam({ memberOrderIds: ['o1'], memberUserIds: ['u1'] });
    seedOrder('o1', { status: 'shipped', paymentStatus: 'completed' });
    const summary = await processExpiredGroupBuy(db as any, 't1', { maker, trigger: 'sweep', now: NOW });
    expect(summary.inTransitOrderIds).toEqual(['o1']);
    expect(approvalState.calls).toHaveLength(0);
    expect(summary.processed).toBe(false);
  });

  it('expiry processing: a 409 from the approvals engine records the existing approval id', async () => {
    dueTeam({ memberOrderIds: ['o1'], memberUserIds: ['u1'] });
    seedOrder('o1', { status: 'verified', paymentStatus: 'completed' });
    approvalState.pending.set('order_refund:o1', 'approval-existing');
    const summary = await processExpiredGroupBuy(db as any, 't1', { maker, trigger: 'sweep', now: NOW });
    expect(summary.refundApprovalIds).toEqual(['approval-existing']);
    expect(team('t1').refundApprovalIds).toEqual(['approval-existing']);
  });

  it('expiry processing: claim mode without a maker creates no refund requests and leaves expiryProcessedAt null', async () => {
    dueTeam({ memberOrderIds: ['o1'], memberUserIds: ['u1'] });
    seedOrder('o1', { status: 'verified', paymentStatus: 'completed' });
    const summary = await processExpiredGroupBuy(db as any, 't1', { trigger: 'lazy', now: NOW });
    expect(approvalState.calls).toHaveLength(0);
    expect(summary.awaitingRefundRequests).toBe(true);
    expect(summary.processed).toBe(false);
    expect(team('t1').state).toBe('expired');
    expect(team('t1').expiryProcessedAt).toBeNull();
  });

  it('expiry processing: second full run creates no duplicate approvals and changes nothing', async () => {
    dueTeam({ memberOrderIds: ['o1'], memberUserIds: ['u1'] });
    seedOrder('o1', { status: 'verified', paymentStatus: 'completed' });
    await processExpiredGroupBuy(db as any, 't1', { maker, trigger: 'sweep', now: NOW });
    const afterFirst = structuredClone(team('t1'));
    const second = await processExpiredGroupBuy(db as any, 't1', { maker, trigger: 'sweep', now: NOW });
    expect(second.refundApprovalIds).toEqual(['approval-1']);
    expect(team('t1').refundApprovalIds).toEqual(['approval-1']);
    expect(team('t1')).toEqual(afterFirst);
  });

  it('expiry processing: missing member order doc is counted as a phantom seat and does not throw', async () => {
    dueTeam({ memberOrderIds: ['ghost-order'], memberUserIds: ['u1'] });
    const summary = await processExpiredGroupBuy(db as any, 't1', { maker, trigger: 'sweep', now: NOW });
    expect(summary.phantomSeats).toBe(1);
    expect(summary.processed).toBe(true);
    expect(team('t1').state).toBe('expired');
  });
});
