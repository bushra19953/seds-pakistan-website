/**
 * @jest-environment node
 */
// T6: payout draft + delete + mark-transferred tests (GG plan Section 8).
// Proofs: M5, M6 completion half, M7 entries_changed interaction.
// R-3: no vendor_payout target type exists; submit is covered by T7
// against the ledger_post machinery.
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
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: async (_db: unknown, uid: string) => uid === 'uid-founder',
  resolveCanonicalRole: async () => 'superadmin',
}));
jest.mock('@/lib/server/vendor-money', () => ({
  isLedgerEntryPayoutEligible: (
    entry: { state: string; type?: string },
    order: { escrowStatus?: string | null } | null,
  ) => entry.state === 'payable' && (!order || order.escrowStatus !== 'held'),
}));
jest.mock('@/lib/server/vendor-shop', () => ({
  createVendorPayout: async (db: VendorFakeDb, input: Record<string, unknown>) => {
    const ref = await db.collection('vendor_payouts').add({ ...input, createdAt: new Date(), transferredAt: null });
    return { id: (ref as { id: string }).id, ...input };
  },
  updateVendorPayout: async (db: VendorFakeDb, id: string, updates: Record<string, unknown>) => {
    await db.collection('vendor_payouts').doc(id).update({ ...updates });
  },
}));
jest.mock('@/lib/supa/vendor-shop-mirror', () => ({
  mirrorVendorShopUpdate: async () => true,
  mirrorVendorShopSet: async () => true,
  mirrorVendorShopDelete: async () => true,
}));

import { POST as createPayout } from '../route';
import { DELETE as deletePayout } from '../[id]/route';
import { POST as markTransferred } from '../[id]/mark-transferred/route';

function req(token: string, body?: unknown) {
  return {
    method: 'POST',
    url: 'http://localhost/api/store/payouts',
    headers: { get: (h: string) => (h.toLowerCase() === 'authorization' ? `Bearer ${token}` : null) },
    json: async () => body ?? {},
  } as never;
}

function ledgerEntry(orderId: string, state: string, sale: number, commission: number, due: number) {
  return {
    vendorId: 'VEND-A',
    orderId,
    type: 'accrual',
    salePricePkr: sale,
    commissionRate: 0.1,
    commissionPkr: commission,
    vendorDuePkr: due,
    state,
    payoutId: null,
    createdAt: new Date('2026-10-29T10:00:00Z'),
  };
}

function seed() {
  const db = createVendorFakeDb({
    vendors: {
      'VEND-A': { userId: 'uid-vendor-a', businessName: 'Alpha Parts', status: 'active', agreementStatus: 'signed', commissionRate: 0.1 },
    },
    commission_ledger: {
      'ORD-1': ledgerEntry('ORD-1', 'payable', 1000, 100, 900),
      'ORD-2': ledgerEntry('ORD-2', 'payable', 2000, 200, 1800),
      'ORD-3': ledgerEntry('ORD-3', 'accrued', 500, 50, 450),
      'ORD-4': ledgerEntry('ORD-4', 'held_dispute', 700, 70, 630),
      'ORD-5': ledgerEntry('ORD-5', 'paid', 900, 90, 810),
      'ORD-6': ledgerEntry('ORD-6', 'payable', 400, 40, 360),
    },
    orders: {
      'ORD-1': { vendorId: 'VEND-A', status: 'delivered', escrowStatus: 'released' },
      'ORD-2': { vendorId: 'VEND-A', status: 'delivered', escrowStatus: 'released' },
      'ORD-6': { vendorId: 'VEND-A', status: 'shipped', escrowStatus: 'held', groupBuyId: 'GB1' },
    },
  });
  holder.db = db;
  return db;
}

describe('payout drafts', () => {
  beforeEach(() => seed());

  it('POST draft includes exactly the payable entries and sums to the rupee (M5)', async () => {
    const res = await createPayout(req('founder', { vendorId: 'VEND-A' }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect([...data.payout.entryIds].sort()).toEqual(['ORD-1', 'ORD-2']);
    expect(data.payout.grossPkr).toBe(3000);
    expect(data.payout.commissionPkr).toBe(300);
    expect(data.payout.netPkr).toBe(2700);
    expect(data.payout.status).toBe('draft');
  });

  it('POST draft with client-sent totals returns 400', async () => {
    const res = await createPayout(req('founder', { vendorId: 'VEND-A', netPkr: 1 }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe('client_totals_not_accepted');
  });

  it('POST draft with zero payable entries returns 422', async () => {
    const db = holder.db!;
    await db.collection('commission_ledger').doc('ORD-1').update({ state: 'accrued' });
    await db.collection('commission_ledger').doc('ORD-2').update({ state: 'accrued' });
    const res = await createPayout(req('founder', { vendorId: 'VEND-A' }));
    expect(res.status).toBe(422);
  });

  it('POST draft intersecting an existing draft returns 409', async () => {
    const first = await createPayout(req('founder', { vendorId: 'VEND-A' }));
    expect(first.status).toBe(201);
    const second = await createPayout(req('founder', { vendorId: 'VEND-A' }));
    expect(second.status).toBe(409);
    const data = await second.json();
    expect(data.code).toBe('duplicate_draft');
  });

  it('DELETE removes a draft and refuses a transferred payout with 409', async () => {
    const db = holder.db!;
    const created = await (await createPayout(req('founder', { vendorId: 'VEND-A' }))).json();
    const draftId = created.payout.id;
    const res = await deletePayout(req('founder'), { params: Promise.resolve({ id: draftId }) });
    expect(res.status).toBe(200);
    const gone = await db.collection('vendor_payouts').doc(draftId).get();
    expect(gone.exists).toBe(false);

    await db.collection('vendor_payouts').doc('PAY-T').set({
      vendorId: 'VEND-A', status: 'transferred', entryIds: [], grossPkr: 0, commissionPkr: 0, netPkr: 0,
    });
    const refused = await deletePayout(req('founder'), { params: Promise.resolve({ id: 'PAY-T' }) });
    expect(refused.status).toBe(409);
  });

  it('all payout routes reject non-admin callers with 403', async () => {
    expect((await createPayout(req('vendor-a', { vendorId: 'VEND-A' }))).status).toBe(403);
    expect((await deletePayout(req('vendor-a'), { params: Promise.resolve({ id: 'X' }) })).status).toBe(403);
    expect((await markTransferred(req('vendor-a'), { params: Promise.resolve({ id: 'X' }) })).status).toBe(403);
  });
});

describe('mark transferred', () => {
  beforeEach(() => seed());

  async function seedApprovedPayout(db: VendorFakeDb) {
    await db.collection('vendor_payouts').doc('PAY1').set({
      vendorId: 'VEND-A',
      periodStart: '2026-10-19',
      periodEnd: '2026-10-25',
      entryIds: ['ORD-1', 'ORD-2'],
      grossPkr: 3000,
      commissionPkr: 300,
      netPkr: 2700,
      financeApprovalId: 'APR1',
      status: 'pending_approval',
      createdBy: 'uid-founder',
      transferredAt: null,
    });
    await db.collection('money_approvals').doc('APR1').set({ status: 'approved_applied', targetType: 'ledger_post' });
  }

  it('mark-transferred after approval pays entries and stamps orders with payoutId (M6)', async () => {
    const db = holder.db!;
    await seedApprovedPayout(db);
    const res = await markTransferred(req('founder'), { params: Promise.resolve({ id: 'PAY1' }) });
    expect(res.status).toBe(200);
    const payout = (await db.collection('vendor_payouts').doc('PAY1').get()).data() as Record<string, unknown>;
    expect(payout.status).toBe('transferred');
    expect(payout.transferredAt).toBeTruthy();
    for (const oid of ['ORD-1', 'ORD-2']) {
      const entry = (await db.collection('commission_ledger').doc(oid).get()).data() as Record<string, unknown>;
      expect(entry.state).toBe('paid');
      expect(entry.payoutId).toBe('PAY1');
      const order = (await db.collection('orders').doc(oid).get()).data() as Record<string, unknown>;
      expect(order.payoutId).toBe('PAY1');
    }
  });

  it('mark-transferred refuses when an entry left payable (claim flagged) with 409 entries_changed (M7)', async () => {
    const db = holder.db!;
    await seedApprovedPayout(db);
    await db.collection('commission_ledger').doc('ORD-2').update({ state: 'held_dispute' });
    const res = await markTransferred(req('founder'), { params: Promise.resolve({ id: 'PAY1' }) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.code).toBe('entries_changed');
    const entry = (await db.collection('commission_ledger').doc('ORD-1').get()).data() as Record<string, unknown>;
    expect(entry.state).toBe('payable');
    const payout = (await db.collection('vendor_payouts').doc('PAY1').get()).data() as Record<string, unknown>;
    expect(payout.status).toBe('pending_approval');
  });
});
