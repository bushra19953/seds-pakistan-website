/**
 * @jest-environment node
 */
// SUPABASE MIGRATION CONTRACTS — FINANCE LAWS.
//
// Behavior that must survive the migration byte-for-byte. Two of the three
// laws are already pinned elsewhere (kept there, referenced here so the
// migration checklist has one home):
//   - maker != checker at the ENGINE level: money-approval.test.ts case 5
//     (decideMoneyApproval rejects 422 MAKER_EQUALS_CHECKER, denial audited).
//   - reconciliation same-user completion: reconcile.test.ts case 17 (422).
// This file pins what those suites do NOT: the laws as seen through the
// HTTP surface (status + error CODE in the body), and the ORDER of the
// reconciliation guards. The third law (approvals paused with 503 when
// FINANCE_MAKER_CHECKER_ENFORCED=false) lives in
// supa-law-flag-paused.test.ts, which mocks the flag module off.
import { createFakeFirestore, type FakeFirestore } from '@/lib/finance/__tests__/fake-firestore';

const holder: { db: FakeFirestore | null } = { db: null };
const uidRoles: Record<string, string> = {
  'maker-treasurer': 'treasurer',
  checker: 'president',
  'rec-maker': 'treasurer',
  'rec-other': 'finance_lead',
};
const rolePerms: Record<string, Set<string>> = {
  treasurer: new Set(['canManageFinance', 'canApproveMoney', 'canAccessAdmin']),
  president: new Set(['canApproveMoney']),
  finance_lead: new Set(['canManageFinance']),
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

import { POST as approvalsPOST } from '../approvals/route';
import { POST as decidePOST } from '../approvals/decide/route';
import { POST as completePOST } from '../reconciliations/complete/route';

function req(uid: string, body?: unknown) {
  return {
    method: 'POST',
    url: 'http://localhost/api/admin/finance/x',
    headers: { get: (h: string) => (h.toLowerCase() === 'authorization' ? `Bearer token-${uid}` : null) },
    json: async () => body ?? {},
  } as never;
}

function auditActions(db: FakeFirestore): string[] {
  const logs = db.__store.get('audit_logs');
  if (!logs) return [];
  return [...logs.values()].map((d) => d.action as string);
}

describe('LAW: maker != checker, through the HTTP surface', () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = createFakeFirestore() as never;
    holder.db = db;
    db.__seed('orders', 'ord-law', {
      status: 'pending_verification', paymentStatus: 'pending', total: 2000, buyerUserId: 'buyer-1',
      buyer: { fullName: 'Buyer One' }, items: [], originatingModule: 'store', receiptUrl: '',
    });
  });

  it('decide by the maker themselves: 422 with body.code MAKER_EQUALS_CHECKER, target untouched, denial audited', async () => {
    // The maker is a treasurer: holds canManageFinance (create) AND
    // canApproveMoney (check) — the self-check guard is the only thing
    // standing between them and their own money movement.
    const created = await approvalsPOST(req('maker-treasurer', {
      targetType: 'order_verify_payment', targetId: 'ord-law', changePayload: {},
    }));
    // order_verify_payment creation requires canManageStore; the treasurer
    // fixture lacks it, so seed the pending request directly instead —
    // the law under test is the DECIDE guard, not the create gate.
    if (created.status !== 201) {
      db.__seed('money_approvals', 'req-law', {
        targetType: 'order_verify_payment', targetId: 'ord-law', targetCollection: 'orders',
        changePayload: {},
        beforeSnapshot: { status: 'pending_verification', paymentStatus: 'pending', total: 2000, totalPkr: null, amount: null, isDeleted: null },
        reason: null, makerUid: 'maker-treasurer', makerRole: 'treasurer', checkerUid: null, checkerRole: null,
        status: 'pending', auditAction: 'ORDER_PAYMENT_VERIFIED',
        createdAt: new Date(), decidedAt: null, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });
    }
    const approvalId = created.status === 201 ? (await created.json()).id : 'req-law';

    const res = await decidePOST(req('maker-treasurer', { approvalId, decision: 'approve' }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('MAKER_EQUALS_CHECKER');
    expect(typeof body.error).toBe('string');
    // The money did not move and the request is still pending.
    expect(db.__doc('orders', 'ord-law')?.status).toBe('pending_verification');
    expect(db.__doc('money_approvals', approvalId)?.status).toBe('pending');
    // The denied self-check is itself written to the audit log.
    expect(auditActions(db)).toContain('MONEY_APPROVAL_SELF_CHECK_DENIED');
  });

  it('the same request decided by a DIFFERENT checker succeeds (guard is identity, not role)', async () => {
    db.__seed('money_approvals', 'req-law-2', {
      targetType: 'order_verify_payment', targetId: 'ord-law', targetCollection: 'orders',
      changePayload: {},
      beforeSnapshot: { status: 'pending_verification', paymentStatus: 'pending', total: 2000, totalPkr: null, amount: null, isDeleted: null },
      reason: null, makerUid: 'maker-treasurer', makerRole: 'treasurer', checkerUid: null, checkerRole: null,
      status: 'pending', auditAction: 'ORDER_PAYMENT_VERIFIED',
      createdAt: new Date(), decidedAt: null, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    const res = await decidePOST(req('checker', { approvalId: 'req-law-2', decision: 'approve' }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('approved_applied');
  });
});

describe('LAW: reconciliation completion rejects the reconciler (guard ORDER pinned)', () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = createFakeFirestore() as never;
    holder.db = db;
  });

  it('caller.uid === rec.reconciledBy is rejected BEFORE the statement/closing guards fire', async () => {
    // Record deliberately missing statementDriveId AND closingBalancePkr:
    // if the maker-checker guard were not first, the error would be about
    // the statement instead. The law is the identity check itself.
    db.__seed('finance_reconciliations', 'rec-law', {
      accountLabel: 'Main Bank', periodMonth: '2026-10', periodStart: '2026-10-01', periodEnd: '2026-10-31',
      openingBalancePkr: 1000, closingBalancePkr: null, ledgerBalancePkr: null, differencePkr: null,
      differenceExplanation: null, statementDriveId: null, reconciledBy: 'rec-maker', checkedBy: null,
      status: 'draft', completedAt: null, computedAt: null, complianceObligationId: null,
    });
    const res = await completePOST(req('rec-maker', { id: 'rec-law' }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/must not be the officer who reconciled/);
    expect(db.__doc('finance_reconciliations', 'rec-law')?.status).toBe('draft');
    expect(db.__doc('finance_reconciliations', 'rec-law')?.checkedBy).toBeNull();
  });

  it('a different officer passes the identity guard and reaches the statement guard (422, different law)', async () => {
    db.__seed('finance_reconciliations', 'rec-law-2', {
      accountLabel: 'Main Bank', periodMonth: '2026-10', periodStart: '2026-10-01', periodEnd: '2026-10-31',
      openingBalancePkr: 1000, closingBalancePkr: null, ledgerBalancePkr: null, differencePkr: null,
      differenceExplanation: null, statementDriveId: null, reconciledBy: 'rec-maker', checkedBy: null,
      status: 'draft', completedAt: null, computedAt: null, complianceObligationId: null,
    });
    const res = await completePOST(req('rec-other', { id: 'rec-law-2' }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/statement reference/);
  });
});
