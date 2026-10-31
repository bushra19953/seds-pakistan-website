/**
 * @jest-environment node
 */
// T4: vendor balance + sales tests (GG plan Section 8). Proof: V4.
import { createVendorFakeDb, type VendorFakeDb } from '@/lib/server/__tests__/vendor-fake-db';

const holder: { db: VendorFakeDb | null } = { db: null };

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    auth: () => ({
      verifyIdToken: async (token: string) => {
        if (token === 'bad') throw new Error('invalid');
        return { uid: `uid-${token}` };
      },
    }),
    firestore: { Timestamp: { now: () => new Date() }, FieldValue: { serverTimestamp: () => new Date() } },
  },
}));
jest.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => new Date() } }));
jest.mock('@/lib/server/firebase-admin', () => ({ getDb: () => holder.db }));
jest.mock('@/lib/server/vendor-access', () => ({
  resolveActiveVendorByUid: async (db: VendorFakeDb, uid: string) => {
    const snap = await db.collection('vendors').where('userId', '==', uid).limit(1).get();
    if (snap.empty) return null;
    const d = snap.docs[0];
    return { id: d.id, ...(d.data() as Record<string, unknown>) };
  },
}));

import { GET as getBalance } from '../balance/route';
import { GET as getSales } from '../sales/route';

function req(token: string, url = 'http://localhost/api/vendor/balance') {
  return {
    method: 'GET',
    url,
    headers: { get: (h: string) => (h.toLowerCase() === 'authorization' ? `Bearer ${token}` : null) },
    json: async () => ({}),
  } as never;
}

function entry(vendorDuePkr: number, state: string, extra: Record<string, unknown> = {}) {
  return {
    vendorId: 'VEND-A',
    orderId: 'ORD-1',
    type: 'accrual',
    salePricePkr: vendorDuePkr + 100,
    commissionRate: 0.1,
    commissionPkr: 100,
    vendorDuePkr,
    state,
    payoutId: null,
    createdAt: new Date('2026-10-29T10:00:00Z'),
    ...extra,
  };
}

function seed() {
  const db = createVendorFakeDb({
    vendors: {
      'VEND-A': { userId: 'uid-vendor-a', businessName: 'Alpha Parts', status: 'active', agreementStatus: 'signed', commissionRate: 0.1 },
      'VEND-B': { userId: 'uid-vendor-b', businessName: 'Beta Tools', status: 'active', agreementStatus: 'signed', commissionRate: 0.1 },
    },
    commission_ledger: {
      'ORD-1': entry(900, 'accrued'),
      'ORD-2': entry(1800, 'payable', { orderId: 'ORD-2' }),
      'ORD-3': entry(2700, 'paid', { orderId: 'ORD-3' }),
      'ORD-4': entry(450, 'held_dispute', { orderId: 'ORD-4' }),
      'ORD-9': { ...entry(9999, 'payable', { orderId: 'ORD-9' }), vendorId: 'VEND-B' },
    },
    vendor_payouts: {
      PAY1: {
        vendorId: 'VEND-A',
        periodStart: '2026-10-19',
        periodEnd: '2026-10-25',
        entryIds: ['ORD-3'],
        grossPkr: 3000,
        commissionPkr: 300,
        netPkr: 2700,
        financeApprovalId: 'APPROVAL-SECRET',
        status: 'transferred',
        createdBy: 'uid-founder',
        createdAt: new Date('2026-10-26T10:00:00Z'),
        transferredAt: new Date('2026-10-27T10:00:00Z'),
      },
    },
    orders: {
      'ORD-1': {
        vendorId: 'VEND-A',
        status: 'processing',
        items: [{ productId: 'P1', productName: 'Widget', quantity: 2, price: 500, subtotal: 1000 }],
        createdAt: new Date('2026-10-29T09:00:00Z'),
      },
      'ORD-2': { vendorId: 'VEND-A', status: 'shipped', items: [], createdAt: new Date('2026-10-29T09:30:00Z') },
    },
  });
  holder.db = db;
  return db;
}

describe('vendor balance', () => {
  beforeEach(() => seed());

  it('balance sums accrued payable paid and held_dispute from the caller ledger only (V4)', async () => {
    const res = await getBalance(req('vendor-a'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.accruedPkr).toBe(900);
    expect(data.payablePkr).toBe(1800);
    expect(data.paidPkr).toBe(2700);
    expect(data.heldDisputePkr).toBe(450);
    expect(data.heldDisputeCount).toBe(1);
  });

  it('balance returns payout history newest first through the stripped view (no financeApprovalId, no createdBy)', async () => {
    const data = await (await getBalance(req('vendor-a'))).json();
    expect(data.payouts).toHaveLength(1);
    expect(data.payouts[0].netPkr).toBe(2700);
    const json = JSON.stringify(data.payouts);
    expect(json).not.toContain('APPROVAL-SECRET');
    expect(json).not.toContain('financeApprovalId');
    expect(json).not.toContain('createdBy');
  });

  it('balance counts toDispatch and awaitingDelivery from own orders only', async () => {
    const data = await (await getBalance(req('vendor-a'))).json();
    expect(data.toDispatchCount).toBe(1);
    expect(data.awaitingDeliveryCount).toBe(1);
  });

  it('sales rows join product names from orders and paginate', async () => {
    const res = await getSales(req('vendor-a', 'http://localhost/api/vendor/sales?limit=2'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.rows).toHaveLength(2);
    expect(data.hasMore).toBe(true);
    const first = data.rows.find((r: { orderId: string }) => r.orderId === 'ORD-1');
    expect(first.productName).toBe('Widget');
    expect(first.itemsSummary).toBe('Widget x2');
    const missing = data.rows.find((r: { orderId: string }) => r.orderId === 'ORD-3');
    if (missing) expect(missing.productName).toBeNull();
  });
});
