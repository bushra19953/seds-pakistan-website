/**
 * @jest-environment node
 */
// T7: payout submit under R-3 (GG plan Section 8, adapted). The original
// plan's vendor_payout target type was CUT by coordinator ruling R-3:
// submit rides the existing ledger_post machinery. Proofs: M6 engine
// half (maker stamps pending_approval through a real approval record),
// RISK-1 guard.
import { createVendorFakeDb, type VendorFakeDb } from '@/lib/server/__tests__/vendor-fake-db';

const holder: { db: VendorFakeDb | null } = { db: null };
const mockCreateApproval = jest.fn();
const mockPrimary = { enabled: false };

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
jest.mock('@/lib/finance/money-approval', () => ({
  createMoneyApprovalRequest: (...args: unknown[]) => mockCreateApproval(...args),
}));
jest.mock('@/lib/finance/ledger', () => ({
  deriveFyLabel: (isoDate: string) => {
    const d = new Date(`${isoDate}T00:00:00Z`);
    const startYear = d.getUTCMonth() + 1 >= 7 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
    return `fy${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
  },
}));
jest.mock('@/lib/finance/supa/primary', () => ({
  financePrimaryEnabled: () => mockPrimary.enabled,
}));
jest.mock('@/lib/server/vendor-shop', () => ({
  updateVendorPayout: async (db: VendorFakeDb, id: string, updates: Record<string, unknown>) => {
    await db.collection('vendor_payouts').doc(id).update({ ...updates });
  },
}));

import { POST as submitPayout } from '../[id]/submit/route';

function req(token: string) {
  return {
    method: 'POST',
    url: 'http://localhost/api/store/payouts/PAY1/submit',
    headers: { get: (h: string) => (h.toLowerCase() === 'authorization' ? `Bearer ${token}` : null) },
    json: async () => ({}),
  } as never;
}

function seed() {
  const db = createVendorFakeDb({
    vendors: {
      'VEND-A': { userId: 'uid-vendor-a', businessName: 'Alpha Parts', status: 'active', agreementStatus: 'signed', commissionRate: 0.1 },
    },
    vendor_payouts: {
      PAY1: {
        vendorId: 'VEND-A',
        periodStart: '2026-10-19',
        periodEnd: '2026-10-25',
        entryIds: ['ORD-1', 'ORD-2'],
        grossPkr: 3000,
        commissionPkr: 300,
        netPkr: 2700,
        financeApprovalId: null,
        status: 'draft',
        createdBy: 'uid-founder',
        transferredAt: null,
      },
    },
  });
  holder.db = db;
  return db;
}

describe('payout submit (ledger_post, R-3)', () => {
  beforeEach(() => {
    seed();
    mockPrimary.enabled = false;
    mockCreateApproval.mockReset();
    mockCreateApproval.mockResolvedValue({ id: 'APR1' });
  });

  it('submit creates one ledger_post approval and stamps pending_approval', async () => {
    const db = holder.db!;
    const res = await submitPayout(req('founder'), { params: Promise.resolve({ id: 'PAY1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.financeApprovalId).toBe('APR1');

    expect(mockCreateApproval).toHaveBeenCalledTimes(1);
    const [, callerArg, input] = mockCreateApproval.mock.calls[0];
    expect(callerArg.uid).toBe('uid-founder');
    expect(input.targetType).toBe('ledger_post');
    expect(input.reason).toContain('MzM Corporation (company hat)');
    expect(input.reason).toContain('Alpha Parts');
    expect(input.changePayload).toMatchObject({ vendorPayoutId: 'PAY1', netPkr: 2700 });

    // The ledger draft the approval targets is company/shop tagged for netPkr.
    const entrySnap = await db.collection('ledger_entries').doc(input.targetId).get();
    expect(entrySnap.exists).toBe(true);
    const entry = entrySnap.data() as Record<string, unknown>;
    expect(entry.status).toBe('draft');
    expect(entry.amountPkr).toBe(2700);
    expect(entry.type).toBe('expense');
    expect(entry.entityTag).toBe('company');
    expect(entry.shopTag).toBe('vendor_payout');
    expect(entry.vendorPayoutId).toBe('PAY1');

    const payout = (await db.collection('vendor_payouts').doc('PAY1').get()).data() as Record<string, unknown>;
    expect(payout.status).toBe('pending_approval');
    expect(payout.financeApprovalId).toBe('APR1');
  });

  it('submit refuses a non-draft payout with 422', async () => {
    const db = holder.db!;
    await db.collection('vendor_payouts').doc('PAY1').update({ status: 'transferred' });
    const res = await submitPayout(req('founder'), { params: Promise.resolve({ id: 'PAY1' }) });
    expect(res.status).toBe(422);
    expect(mockCreateApproval).not.toHaveBeenCalled();
  });

  it('submit returns 503 finance_primary_unsupported when the finance write-primary is on (RISK-1)', async () => {
    mockPrimary.enabled = true;
    const res = await submitPayout(req('founder'), { params: Promise.resolve({ id: 'PAY1' }) });
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.code).toBe('finance_primary_unsupported');
    expect(mockCreateApproval).not.toHaveBeenCalled();
  });

  it('submit surfaces an engine failure and removes the orphan ledger draft', async () => {
    const db = holder.db!;
    mockCreateApproval.mockRejectedValue(Object.assign(new Error('A pending request already exists for this target'), { status: 409 }));
    const res = await submitPayout(req('founder'), { params: Promise.resolve({ id: 'PAY1' }) });
    expect(res.status).toBe(409);
    const entries = await db.collection('ledger_entries').get();
    expect(entries.docs).toHaveLength(0);
    const payout = (await db.collection('vendor_payouts').doc('PAY1').get()).data() as Record<string, unknown>;
    expect(payout.status).toBe('draft');
  });

  it('submit rejects non-admin callers with 403', async () => {
    const res = await submitPayout(req('vendor-a'), { params: Promise.resolve({ id: 'PAY1' }) });
    expect(res.status).toBe(403);
  });
});
