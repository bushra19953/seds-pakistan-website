/**
 * @jest-environment node
 */
// SUPABASE MIGRATION CONTRACTS — FINANCE ROUTE PARITY.
//
// For every route under src/app/api/admin/finance/, this pins the response
// shape (status + body keys + value types) on the main success path and
// the main denial path, using the fake-firestore + permission-mock style
// of the existing finance suites. The migrated implementations must keep
// every one of these green with the surface flag OFF and ON (mocked
// adapter): a changed key, a renamed envelope, or a status drift is a
// migration regression, not a refactor.
import { createFakeFirestore, type FakeFirestore } from '@/lib/finance/__tests__/fake-firestore';

const holder: { db: FakeFirestore | null } = { db: null };
const uidRoles: Record<string, string> = {
  fin: 'treasurer',
  fin2: 'finance_officer',
  checker: 'president',
  officer: 'officer',
  'store-maker': 'store_officer',
};
const rolePerms: Record<string, Set<string>> = {
  treasurer: new Set(['canManageFinance', 'canApproveMoney', 'canAccessAdmin']),
  finance_officer: new Set(['canManageFinance', 'canAccessAdmin']),
  president: new Set(['canApproveMoney']),
  officer: new Set(['canAccessAdmin']),
  store_officer: new Set(['canManageStore']),
};

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: { auth: () => ({ verifyIdToken: async (token: string) => ({ uid: token.replace('token-', '') }) }) },
}));
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => holder.db,
  admin: { auth: () => ({ verifyIdToken: async (token: string) => ({ uid: token.replace('token-', '') }) }) },
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }), arrayUnion: (v: unknown) => ({ __arrayUnion: v }) },
}));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async (role: string, perm: string) => rolePerms[role]?.has(perm) ?? false),
  hasServerPermissionForUser: jest.fn(
    async (_db: unknown, uid: string, perm: string) => rolePerms[uidRoles[uid] ?? 'member']?.has(perm) ?? false,
  ),
  resolveCanonicalRole: jest.fn(async (_db: unknown, uid: string) => uidRoles[uid] ?? 'member'),
}));

import { GET as budgetsGET, POST as budgetsPOST, PUT as budgetsPUT } from '../budgets/route';
import { GET as destinationsGET, POST as destinationsPOST } from '../destinations/route';
import { GET as ledgerGET, POST as ledgerPOST } from '../ledger/route';
import { POST as reversePOST } from '../ledger/reverse/route';
import { GET as receiptsGET, POST as receiptsPOST } from '../receipts/route';
import { POST as deliverPOST } from '../receipts/deliver/route';
import { GET as approvalsGET, POST as approvalsPOST } from '../approvals/route';
import { POST as decidePOST } from '../approvals/decide/route';
import { GET as recsGET, POST as recsPOST, PUT as recsPUT } from '../reconciliations/route';
import { POST as completePOST } from '../reconciliations/complete/route';
import { GET as reportsGET } from '../reports/route';
import { GET as auditorGET, PUT as auditorPUT } from '../auditor/route';

function req(uid: string | null, body?: unknown, url = 'http://localhost/api/admin/finance/x', method = 'POST') {
  return {
    method,
    url,
    headers: { get: (h: string) => (h.toLowerCase() === 'authorization' && uid ? `Bearer token-${uid}` : null) },
    json: async () => body ?? {},
  } as never;
}

function keys(body: Record<string, unknown>): string[] {
  return Object.keys(body).sort();
}

function expectErrorShape(body: Record<string, unknown>) {
  expect(typeof body.error).toBe('string');
  expect((body.error as string).length).toBeGreaterThan(0);
}

const LEDGER_BODY = {
  date: '2026-10-05', type: 'expense', category: 'operations', amountPkr: 5000,
  counterparty: 'Print Shop', description: 'Banners', budgetLineId: 'ops-printing',
  paymentMethod: 'bank_transfer', accountLabel: 'Main Bank',
};

describe('supa route parity: finance routes', () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = createFakeFirestore() as never;
    holder.db = db;
    db.__seed('settings', 'finance', { accounts: [{ label: 'Main Bank', slug: 'main-bank', type: 'bank', openingBalancePkr: 1000 }] });
    db.__seed('finance_budgets', 'fy2026-27', {
      fyLabel: 'fy2026-27', fyStart: '2026-07-01', fyEnd: '2027-06-30', status: 'approved', revision: 1,
      lines: [{ lineId: 'ops-printing', category: 'operations', label: 'Printing', allocatedPkr: 100000 }],
      totalAllocatedPkr: 100000,
    });
  });

  /* budgets */
  it('budgets GET: 200 { budgets: [...] } with computedActuals object per budget; denial 403 { error }', async () => {
    const res = await budgetsGET(req('fin', undefined, 'http://localhost/api/admin/finance/budgets', 'GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(keys(body)).toEqual(['budgets']);
    expect(Array.isArray(body.budgets)).toBe(true);
    expect(body.budgets).toHaveLength(1);
    expect(typeof body.budgets[0].computedActuals).toBe('object');
    expect(typeof body.budgets[0].totalAllocatedPkr).toBe('number');

    const denied = await budgetsGET(req('plain', undefined, 'http://localhost/api/admin/finance/budgets', 'GET'));
    expect(denied.status).toBe(403);
    expectErrorShape(await denied.json());
  });

  it('budgets GET ?resource=accounts: 200 { accounts: [...] }', async () => {
    const res = await budgetsGET(req('fin', undefined, 'http://localhost/api/admin/finance/budgets?resource=accounts', 'GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(keys(body)).toEqual(['accounts']);
    expect(body.accounts[0]).toMatchObject({ label: 'Main Bank', slug: 'main-bank', type: 'bank' });
  });

  it('budgets POST: 201 { id, status: "draft" } exactly; PUT: 200 { id, totalAllocatedPkr:number }; denial 403', async () => {
    const res = await budgetsPOST(req('fin', {
      fyLabel: 'fy2027-28', fyStart: '2027-07-01', fyEnd: '2028-06-30',
      lines: [{ lineId: 'l1', category: 'operations', label: 'Ops', allocatedPkr: 40000 }],
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(keys(body)).toEqual(['id', 'status']);
    expect(body).toEqual({ id: 'fy2027-28', status: 'draft' });

    const put = await budgetsPUT(req('fin', {
      id: 'fy2027-28', lines: [{ lineId: 'l1', category: 'operations', label: 'Ops', allocatedPkr: 55000 }],
    }));
    expect(put.status).toBe(200);
    const putBody = await put.json();
    expect(keys(putBody)).toEqual(['id', 'totalAllocatedPkr']);
    expect(putBody.totalAllocatedPkr).toBe(55000);

    const denied = await budgetsPOST(req('plain', { fyLabel: 'fy2028-29', fyStart: '2028-07-01', fyEnd: '2029-06-30', lines: [] }));
    expect(denied.status).toBe(403);
    expectErrorShape(await denied.json());
  });

  /* destinations */
  it('destinations GET: 200 { destinations: [2 views] } with exact view keys; NO write handlers exist (CH-10); denial 403', async () => {
    const res = await destinationsGET(req('fin', undefined, 'http://localhost/api/admin/finance/destinations', 'GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(keys(body)).toEqual(['destinations']);
    expect(body.destinations).toHaveLength(2);
    for (const v of body.destinations) {
      expect(keys(v)).toEqual(['active', 'destinationMeta', 'label', 'pending', 'store']);
    }
    expect(body.destinations.map((d: { store: string }) => d.store)).toEqual(['payment_methods', 'pages_donate']);
    expect(destinationsPOST).toBeUndefined();

    const denied = await destinationsGET(req('plain', undefined, 'http://localhost/api/admin/finance/destinations', 'GET'));
    expect(denied.status).toBe(403);
  });

  /* ledger */
  it('ledger POST: 201 { id, fyLabel, unbudgeted, overThreshold } with types; GET: 200 { entries }; denials 403/401', async () => {
    const res = await ledgerPOST(req('fin', LEDGER_BODY));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(keys(body)).toEqual(['fyLabel', 'id', 'overThreshold', 'unbudgeted']);
    expect(typeof body.id).toBe('string');
    expect(body.fyLabel).toBe('fy2026-27');
    expect(body.unbudgeted).toBe(false);
    expect(body.overThreshold).toBe(false);

    const get = await ledgerGET(req('fin', undefined, 'http://localhost/api/admin/finance/ledger', 'GET'));
    expect(get.status).toBe(200);
    const getBody = await get.json();
    expect(keys(getBody)).toEqual(['entries']);
    expect(getBody.entries).toHaveLength(1);
    expect(typeof getBody.entries[0].amountPkr).toBe('number');

    const denied = await ledgerPOST(req('plain', LEDGER_BODY));
    expect(denied.status).toBe(403);
    expectErrorShape(await denied.json());

    const anon = await ledgerGET(req(null, undefined, 'http://localhost/api/admin/finance/ledger', 'GET'));
    expect(anon.status).toBe(401);
    expectErrorShape(await anon.json());
  });

  it('ledger POST rejects a non-integer amountPkr with 400 { error } (integer-PKR write contract)', async () => {
    const res = await ledgerPOST(req('fin', { ...LEDGER_BODY, amountPkr: 100.5 }));
    expect(res.status).toBe(400);
    expectErrorShape(await res.json());
  });

  it('ledger/reverse POST: 201 { id, reversalOf }; denial 403', async () => {
    db.__seed('ledger_entries', 'posted-1', {
      date: '2026-10-01', fyLabel: 'fy2026-27', type: 'income', category: 'donations', amountPkr: 8000,
      counterparty: 'Donor', description: 'Gift', budgetLineId: null, unbudgeted: false, overThreshold: false,
      consentId: null, paymentMethod: 'bank_transfer', accountLabel: 'Main Bank', enteredBy: 'fin',
      status: 'posted', postedBy: 'checker', reversalOf: null, reversedBy: null,
      counterpartyPartnerId: null, relatedPartyEntryId: null,
    });
    const res = await reversePOST(req('fin', { entryId: 'posted-1', reason: 'Wrong amount', date: '2026-10-06' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(keys(body)).toEqual(['id', 'reversalOf']);
    expect(body.reversalOf).toBe('posted-1');

    const denied = await reversePOST(req('plain', { entryId: 'posted-1', reason: 'x', date: '2026-10-06' }));
    expect(denied.status).toBe(403);
  });

  /* receipts + deliver */
  it('receipts POST: 201 { id, slaDueAt: ISO string }; GET: 200 { receipts } with sla fields; denial 403', async () => {
    const res = await receiptsPOST(req('officer', {
      kind: 'officer_expense', transactionDate: '2026-10-01', amountPkr: 4500,
      description: 'Taxi', receiptDriveId: 'drv-1',
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(keys(body)).toEqual(['id', 'slaDueAt']);
    expect(typeof body.slaDueAt).toBe('string');
    expect(body.slaDueAt.slice(0, 10)).toBe('2026-10-15');

    const get = await receiptsGET(req('fin', undefined, 'http://localhost/api/admin/finance/receipts', 'GET'));
    expect(get.status).toBe(200);
    const getBody = await get.json();
    expect(keys(getBody)).toEqual(['receipts']);
    expect(getBody.receipts).toHaveLength(1);
    expect(typeof getBody.receipts[0].slaBreached).toBe('boolean');
    expect('daysRemaining' in getBody.receipts[0]).toBe(true);
    expect(typeof getBody.receipts[0].amountPkr).toBe('number');

    const denied = await receiptsPOST(req('plain', {
      kind: 'officer_expense', transactionDate: '2026-10-01', amountPkr: 1, receiptDriveId: 'd',
    }));
    expect(denied.status).toBe(403);
  });

  it('receipts/deliver POST: 200 { id, delivered: true } exactly; denial 403', async () => {
    db.__seed('finance_receipts', 'rc-1', {
      officerUid: 'officer', kind: 'officer_expense', transactionDate: '2026-10-01', amountPkr: 100,
      receiptDriveId: 'd', deliveredToTreasurerAt: null, slaDueAt: new Date('2026-10-15T00:00:00Z'),
    });
    const res = await deliverPOST(req('fin', { id: 'rc-1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'rc-1', delivered: true });

    const denied = await deliverPOST(req('plain', { id: 'rc-1' }));
    expect(denied.status).toBe(403);
  });

  /* approvals + decide */
  it('approvals POST: 201 { id, status: "pending" }; GET: 200 { approvals }; denial 403', async () => {
    db.__seed('finance_budgets', 'bud-draft', { status: 'draft', fyLabel: 'fy2026-27', revision: 1, lines: [] });
    const res = await approvalsPOST(req('fin', { targetType: 'budget_approve', targetId: 'bud-draft', changePayload: {} }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(keys(body)).toEqual(['id', 'status']);
    expect(body.status).toBe('pending');

    const get = await approvalsGET(req('checker', undefined, 'http://localhost/api/admin/finance/approvals?scope=mine', 'GET'));
    expect(get.status).toBe(200);
    expect(keys(await get.json())).toEqual(['approvals']);

    const denied = await approvalsPOST(req('officer', { targetType: 'budget_approve', targetId: 'bud-draft', changePayload: {} }));
    expect(denied.status).toBe(403);
    expectErrorShape(await denied.json());
  });

  it('approvals/decide POST: 200 { status } on approve and on reject; reject without note is 400 { error }', async () => {
    db.__seed('orders', 'ord-1', {
      status: 'pending_verification', paymentStatus: 'pending', total: 2000, buyerUserId: 'buyer-1',
      buyer: { fullName: 'Buyer One', email: 'b@example.com' }, items: [], originatingModule: 'store', receiptUrl: '',
    });
    const created = await approvalsPOST(req('store-maker', { targetType: 'order_verify_payment', targetId: 'ord-1', changePayload: {} }));
    const { id } = await created.json();

    const noNote = await decidePOST(req('checker', { approvalId: id, decision: 'reject' }));
    expect(noNote.status).toBe(400);
    expectErrorShape(await noNote.json());

    const ok = await decidePOST(req('checker', { approvalId: id, decision: 'approve' }));
    expect(ok.status).toBe(200);
    const okBody = await ok.json();
    expect(keys(okBody)).toEqual(['status']);
    expect(okBody.status).toBe('approved_applied');

    const created2 = await approvalsPOST(req('store-maker', {
      targetType: 'order_refund', targetId: 'ord-1', changePayload: {}, reason: 'Duplicate payment',
    }));
    expect(created2.status).toBe(201);
    const { id: id2 } = await created2.json();
    const rej = await decidePOST(req('checker', { approvalId: id2, decision: 'reject', note: 'Not justified' }));
    expect(rej.status).toBe(200);
    expect(await rej.json()).toEqual({ status: 'rejected' });
  });

  /* reconciliations + complete */
  it('reconciliations POST: 201 { id, status: "draft" }; PUT: 200 { id }; GET: 200 { reconciliations }; denial 403', async () => {
    const res = await recsPOST(req('fin', { accountLabel: 'Main Bank', periodMonth: '2026-10', openingBalancePkr: 1000 }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'main-bank-2026-10', status: 'draft' });

    const put = await recsPUT(req('fin', { id: 'main-bank-2026-10', closingBalancePkr: 4000, statementDriveId: 'drive-stmt-1' }, 'http://localhost/api/admin/finance/reconciliations', 'PUT'));
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ id: 'main-bank-2026-10' });

    const get = await recsGET(req('fin', undefined, 'http://localhost/api/admin/finance/reconciliations', 'GET'));
    expect(get.status).toBe(200);
    const getBody = await get.json();
    expect(keys(getBody)).toEqual(['reconciliations']);
    expect(getBody.reconciliations).toHaveLength(1);

    const denied = await recsPOST(req('plain', { accountLabel: 'Main Bank', periodMonth: '2026-11', openingBalancePkr: 0 }));
    expect(denied.status).toBe(403);
  });

  it('reconciliations/complete POST: 200 { id, status: "completed", ledgerBalancePkr:number, differencePkr:number }; denial 403', async () => {
    db.__seed('ledger_entries', 'e1', {
      date: '2026-10-03', fyLabel: 'fy2026-27', type: 'income', category: 'donations', amountPkr: 5000,
      accountLabel: 'Main Bank', status: 'posted', budgetLineId: null,
    });
    db.__seed('ledger_entries', 'e2', {
      date: '2026-10-10', fyLabel: 'fy2026-27', type: 'expense', category: 'operations', amountPkr: 2000,
      accountLabel: 'Main Bank', status: 'posted', budgetLineId: null,
    });
    await recsPOST(req('fin', { accountLabel: 'Main Bank', periodMonth: '2026-10', openingBalancePkr: 1000 }));
    await recsPUT(req('fin', { id: 'main-bank-2026-10', closingBalancePkr: 4000, statementDriveId: 'drive-stmt-1' }, 'http://localhost/api/admin/finance/reconciliations', 'PUT'));
    const res = await completePOST(req('checker', { id: 'main-bank-2026-10' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(keys(body)).toEqual(['differencePkr', 'id', 'ledgerBalancePkr', 'status']);
    expect(body.status).toBe('completed');
    expect(body.ledgerBalancePkr).toBe(4000);
    expect(body.differencePkr).toBe(0);

    const denied = await completePOST(req('plain', { id: 'main-bank-2026-10' }));
    expect(denied.status).toBe(403);
  });

  /* reports */
  it('reports GET income-expenditure: 200 { type, fy, asOf, report } with pinned report keys; denial 403; missing type 400', async () => {
    db.__seed('ledger_entries', 'r1', {
      date: '2026-10-03', fyLabel: 'fy2026-27', type: 'income', category: 'donations', amountPkr: 1000,
      accountLabel: 'Main Bank', status: 'posted', budgetLineId: null,
    });
    const res = await reportsGET(req('fin', undefined, 'http://localhost/api/admin/finance/reports?type=income-expenditure&fy=fy2026-27&asOf=2026-10-31', 'GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(keys(body)).toEqual(['asOf', 'fy', 'report', 'type']);
    expect(body.type).toBe('income-expenditure');
    expect(body.fy).toBe('fy2026-27');
    expect(body.asOf).toBe('2026-10-31');
    expect(keys(body.report)).toEqual(['byCategory', 'netPkr', 'totalExpensePkr', 'totalIncomePkr']);
    expect(body.report.totalIncomePkr).toBe(1000);

    const denied = await reportsGET(req('plain', undefined, 'http://localhost/api/admin/finance/reports?type=income-expenditure&fy=fy2026-27', 'GET'));
    expect(denied.status).toBe(403);

    const noType = await reportsGET(req('fin', undefined, 'http://localhost/api/admin/finance/reports', 'GET'));
    expect(noType.status).toBe(400);
    expectErrorShape(await noType.json());
  });

  it('reports GET variance: report envelope carries variance + budget metadata keys', async () => {
    const res = await reportsGET(req('fin', undefined, 'http://localhost/api/admin/finance/reports?type=variance&fy=fy2026-27&asOf=2026-10-31', 'GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(keys(body.report)).toEqual(['budgetFyLabel', 'budgetId', 'budgetStatus', 'consentPending', 'variance']);
    expect(keys(body.report.variance)).toEqual(['lines', 'totalActualPkr', 'totalAllocatedPkr', 'unbudgetedPostedExpensePkr']);
    expect(body.report.variance.totalAllocatedPkr).toBe(100000);
  });

  /* auditor */
  it('auditor GET: 200 { auditor: null, fyLabel } when absent; PUT: 200 { fyLabel, fallback }; GET after PUT exposes fallback boolean; denial 403', async () => {
    const empty = await auditorGET(req('fin', undefined, 'http://localhost/api/admin/finance/auditor?fy=fy2026-27', 'GET'));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ auditor: null, fyLabel: 'fy2026-27' });

    const put = await auditorPUT(req('fin', {
      fyLabel: 'fy2026-27', auditorName: 'A. Chartered', firmName: 'Example & Co',
      appointedBy: 'founder_fallback', appointedAt: '2026-10-01', engagementLetterDriveId: 'drv-eng',
    }, 'http://localhost/api/admin/finance/auditor', 'PUT'));
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ fyLabel: 'fy2026-27', fallback: true });

    const get = await auditorGET(req('fin', undefined, 'http://localhost/api/admin/finance/auditor?fy=fy2026-27', 'GET'));
    const body = await get.json();
    expect(keys(body)).toEqual(['auditor', 'fyLabel']);
    expect(body.auditor.fallback).toBe(true);
    expect(typeof body.auditor.auditorName).toBe('string');

    const denied = await auditorPUT(req('plain', {
      fyLabel: 'fy2026-27', auditorName: 'X', appointedBy: 'board', appointedAt: '2026-10-01',
    }, 'http://localhost/api/admin/finance/auditor', 'PUT'));
    expect(denied.status).toBe(403);
  });
});
