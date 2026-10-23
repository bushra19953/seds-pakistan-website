/**
 * @jest-environment node
 */
// Maker-checker engine tests (spec Part C section 7, cases 5-10).
import { createFakeFirestore, type FakeFirestore } from './fake-firestore';

const rolePerms: Record<string, Set<string>> = {
  store_officer: new Set(['canManageStore']),
  president: new Set(['canApproveMoney']),
  treasurer: new Set(['canApproveMoney', 'canManageFinance']),
  finance_officer: new Set(['canManageFinance']),
};

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => ({ __serverTimestamp: true }),
    arrayUnion: (v: unknown) => ({ __arrayUnion: v }),
  },
}));

// uid -> primary role for the pre-existing callers (their Caller.role values,
// re-keyed by uid because hasServerPermissionForUser resolves by uid).
const uidRoles: Record<string, string> = {
  'maker-1': 'treasurer',
  'checker-1': 'president',
  'checker-2': 'treasurer',
  'fin-1': 'finance_officer',
};
// Canonical holder fixture (parity program): primary `member` holding an
// unexpired custom grant; an expired grant contributes nothing.
const customGrants: Record<string, { perms: Set<string>; expired: boolean }> = {
  'holder-checker': { perms: new Set(['canApproveMoney', 'canManageFinance']), expired: false },
  'holder-finance-only': { perms: new Set(['canManageFinance']), expired: false },
  'expired-holder': { perms: new Set(['canApproveMoney', 'canManageFinance']), expired: true },
};
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async (role: string, perm: string) => rolePerms[role]?.has(perm) ?? false),
  hasServerPermissionForUser: jest.fn(
    async (_db: unknown, uid: string, perm: string) =>
      (rolePerms[uidRoles[uid] ?? 'member']?.has(perm) ?? false) ||
      (!!customGrants[uid] && !customGrants[uid].expired && customGrants[uid].perms.has(perm)),
  ),
  resolveCanonicalRole: jest.fn(async () => 'officer'),
}));

import { createMoneyApprovalRequest, decideMoneyApproval, MoneyApprovalError } from '../money-approval';

const maker = { uid: 'maker-1', role: 'store_officer' };
const checker = { uid: 'checker-1', role: 'president' };

function seedOrder(db: FakeFirestore) {
  return db.__seed('orders', 'ord-1', {
    status: 'pending_verification',
    paymentStatus: 'pending',
    total: 2000,
    buyerUserId: 'buyer-1',
    buyer: { fullName: 'Buyer One', email: 'b@example.com' },
    items: [],
    originatingModule: 'store',
    receiptUrl: 'https://drive.example/r1',
  });
}

function auditActions(db: FakeFirestore): string[] {
  const logs = db.__store.get('audit_logs');
  if (!logs) return [];
  return [...logs.values()].map((d) => d.action as string);
}

describe('money-approval engine (cases 5-10)', () => {
  it('case 5: maker_cannot_check_own_request - 422 MAKER_EQUALS_CHECKER and denial is audit-logged', async () => {
    const db = createFakeFirestore();
    seedOrder(db as never);
    // The self-check attack is a PRIVILEGED maker approving their own
    // request, so this maker also holds the checker permission (treasurer).
    // Per the spec decide order, permission is checked first: a maker
    // WITHOUT canApproveMoney would correctly get 403 before this point.
    const privilegedMaker = { uid: 'maker-1', role: 'treasurer' };
    const { id } = await createMoneyApprovalRequest(db as never, privilegedMaker, {
      targetType: 'order_verify_payment',
      targetId: 'ord-1',
      changePayload: { fromStatus: 'pending_verification', toStatus: 'verified' },
    });
    await expect(decideMoneyApproval(db as never, privilegedMaker, id, 'approve')).rejects.toMatchObject({
      status: 422,
      code: 'MAKER_EQUALS_CHECKER',
    });
    expect(auditActions(db)).toContain('MONEY_APPROVAL_SELF_CHECK_DENIED');
    expect(db.__doc('orders', 'ord-1')?.status).toBe('pending_verification');
  });

  it('case 6: checker_approval_applies_change_atomically', async () => {
    const db = createFakeFirestore();
    seedOrder(db as never);
    const { id } = await createMoneyApprovalRequest(db as never, maker, {
      targetType: 'order_verify_payment',
      targetId: 'ord-1',
      changePayload: {},
    });
    const res = await decideMoneyApproval(db as never, checker, id, 'approve');
    expect(res.status).toBe('approved_applied');
    const order = db.__doc('orders', 'ord-1')!;
    expect(order.status).toBe('verified');
    expect(order.paymentStatus).toBe('completed');
    expect(order.totalPkr).toBe(2000);
    // ledger draft + receipt record created by the same approval
    const entries = [...(db.__store.get('ledger_entries')?.values() ?? [])];
    expect(entries).toHaveLength(1);
    expect(entries[0].sourceOrderId).toBe('ord-1');
    expect(entries[0].status).toBe('draft'); // checker lacks canManageFinance
    const receipts = [...(db.__store.get('finance_receipts')?.values() ?? [])];
    expect(receipts).toHaveLength(1);
    expect(receipts[0].kind).toBe('inbound_payment');
    expect(auditActions(db)).toContain('ORDER_PAYMENT_VERIFIED');
    expect(db.__doc('money_approvals', id)?.status).toBe('approved_applied');
  });

  it('case 6b: injected apply failure leaves the target untouched and marks apply_failed', async () => {
    const db = createFakeFirestore();
    // Event item pointing at a non-existent event doc: the registration
    // mirror update throws inside the transaction.
    db.__seed('orders', 'ord-ev', {
      status: 'pending_verification',
      paymentStatus: 'pending',
      total: 500,
      buyerUserId: 'buyer-9',
      buyer: { fullName: 'Ev Buyer' },
      items: [{ type: 'event_ticket', eventId: 'missing-event' }],
      originatingModule: 'Events',
    });
    const { id } = await createMoneyApprovalRequest(db as never, maker, {
      targetType: 'order_verify_payment',
      targetId: 'ord-ev',
      changePayload: {},
    });
    await expect(decideMoneyApproval(db as never, checker, id, 'approve')).rejects.toMatchObject({ status: 500 });
    expect(db.__doc('orders', 'ord-ev')?.status).toBe('pending_verification');
    expect(db.__store.get('ledger_entries')?.size ?? 0).toBe(0);
    expect(db.__doc('money_approvals', id)?.status).toBe('apply_failed');
  });

  it('case 7: stale_snapshot_blocks_apply - 409 and target unchanged', async () => {
    const db = createFakeFirestore();
    seedOrder(db as never);
    const { id } = await createMoneyApprovalRequest(db as never, maker, {
      targetType: 'order_verify_payment',
      targetId: 'ord-1',
      changePayload: {},
    });
    // External change after the request was created.
    db.__doc('orders', 'ord-1')!.total = 9999;
    await expect(decideMoneyApproval(db as never, checker, id, 'approve')).rejects.toMatchObject({ status: 409 });
    expect(db.__doc('orders', 'ord-1')?.status).toBe('pending_verification');
    expect(db.__doc('money_approvals', id)?.status).toBe('pending');
  });

  it('case 8: duplicate_pending_request_rejected - 409 with existing id', async () => {
    const db = createFakeFirestore();
    seedOrder(db as never);
    const first = await createMoneyApprovalRequest(db as never, maker, {
      targetType: 'order_verify_payment',
      targetId: 'ord-1',
      changePayload: {},
    });
    await expect(
      createMoneyApprovalRequest(db as never, maker, {
        targetType: 'order_verify_payment',
        targetId: 'ord-1',
        changePayload: {},
      }),
    ).rejects.toMatchObject({ status: 409, existingId: first.id });
  });

  it('case 9: expired_request_cannot_be_decided - stamped expired, 409', async () => {
    const db = createFakeFirestore();
    seedOrder(db as never);
    const { id } = await createMoneyApprovalRequest(db as never, maker, {
      targetType: 'order_verify_payment',
      targetId: 'ord-1',
      changePayload: {},
    });
    (db.__doc('money_approvals', id) as { expiresAt: unknown }).expiresAt = new Date(Date.now() - 1000);
    await expect(decideMoneyApproval(db as never, checker, id, 'approve')).rejects.toMatchObject({ status: 409 });
    expect(db.__doc('money_approvals', id)?.status).toBe('expired');
  });

  it('case 10: destination_change_never_live_before_approval', async () => {
    const db = createFakeFirestore();
    const before = { methods: [{ id: 'bank', name: 'Bank', instructions: 'Old instructions' }], order: ['bank'], testMode: false };
    db.__seed('settings', 'payment_methods', { ...before });
    const payload = { methods: [{ id: 'bank', name: 'Bank', instructions: 'New instructions' }], order: ['bank'], testMode: false };
    const finMaker = { uid: 'fin-1', role: 'finance_officer' };
    const { id } = await createMoneyApprovalRequest(db as never, finMaker, {
      targetType: 'destination_change',
      targetId: 'payment_methods',
      changePayload: payload,
      reason: 'Correcting account instructions',
    });
    // Live store byte-identical before approval.
    expect(db.__doc('settings', 'payment_methods')).toEqual(before);
    await decideMoneyApproval(db as never, { uid: 'checker-2', role: 'treasurer' }, id, 'approve');
    const after = db.__doc('settings', 'payment_methods')!;
    expect(after.methods).toEqual(payload.methods);
    const meta = after.destinationMeta as { lastChangedBy: string; approvedBy: string; approvalId: string };
    expect(meta.lastChangedBy).toBe('fin-1');
    expect(meta.approvedBy).toBe('checker-2');
    expect(meta.approvalId).toBe(id);
    expect(auditActions(db)).toContain('PAYMENT_DESTINATION_CHANGED');
  });

  it('reject leaves the target untouched and records the note', async () => {
    const db = createFakeFirestore();
    seedOrder(db as never);
    const { id } = await createMoneyApprovalRequest(db as never, maker, {
      targetType: 'order_verify_payment',
      targetId: 'ord-1',
      changePayload: {},
    });
    const res = await decideMoneyApproval(db as never, checker, id, 'reject', 'Receipt is illegible');
    expect(res.status).toBe('rejected');
    expect(db.__doc('orders', 'ord-1')?.status).toBe('pending_verification');
    expect(db.__doc('money_approvals', id)?.decisionNote).toBe('Receipt is illegible');
  });

  it('MoneyApprovalError is exported for route mapping', () => {
    expect(new MoneyApprovalError(422, 'x').status).toBe(422);
  });
});

describe('money-approval parity: custom-role holder (Family C, C22/C23)', () => {
  it('C22: primary member + custom canApproveMoney grant can check; C23: its canManageFinance grant posts the ledger entry immediately', async () => {
    const db = createFakeFirestore();
    seedOrder(db as never);
    const { id } = await createMoneyApprovalRequest(db as never, maker, {
      targetType: 'order_verify_payment',
      targetId: 'ord-1',
      changePayload: {},
    });
    const holderCaller = { uid: 'holder-checker', role: 'member' };
    const res = await decideMoneyApproval(db as never, holderCaller, id, 'approve');
    expect(res.status).toBe('approved_applied');
    const entries = [...(db.__store.get('ledger_entries')?.values() ?? [])];
    expect(entries).toHaveLength(1);
    // C23: checkerCanManageFinance came from the custom grant, so the entry
    // is posted immediately (case 6's president checker leaves it a draft).
    expect(entries[0].status).toBe('posted');
    expect(entries[0].postedBy).toBe('holder-checker');
  });

  it('C22 fallback: primary member + ONLY a custom canManageFinance grant can check a routine (not over-threshold) ledger_post', async () => {
    const db = createFakeFirestore();
    db.__seed('ledger_entries', 'draft-1', {
      date: '2026-10-03', fyLabel: 'fy2026-27', type: 'expense', category: 'operations',
      amountPkr: 5000, counterparty: 'Print Shop', description: 'Banners', budgetLineId: null,
      unbudgeted: false, overThreshold: false, consentId: null, paymentMethod: 'bank_transfer',
      accountLabel: 'Main Bank', enteredBy: 'maker-1', status: 'draft', reversalOf: null,
    });
    const finMaker = { uid: 'fin-1', role: 'finance_officer' };
    const { id } = await createMoneyApprovalRequest(db as never, finMaker, {
      targetType: 'ledger_post',
      targetId: 'draft-1',
      changePayload: {},
    });
    const holderCaller = { uid: 'holder-finance-only', role: 'member' };
    const res = await decideMoneyApproval(db as never, holderCaller, id, 'approve');
    expect(res.status).toBe('approved_applied');
    expect(db.__doc('ledger_entries', 'draft-1')?.status).toBe('posted');
    expect(db.__doc('ledger_entries', 'draft-1')?.postedBy).toBe('holder-finance-only');
  });

  it('C22 fallback does NOT open for an over-threshold ledger_post', async () => {
    const db = createFakeFirestore();
    db.__seed('ledger_entries', 'draft-big', {
      date: '2026-10-03', fyLabel: 'fy2026-27', type: 'expense', category: 'operations',
      amountPkr: 300000, counterparty: 'Vendor', description: 'Big buy', budgetLineId: null,
      unbudgeted: false, overThreshold: true, consentId: null, paymentMethod: 'bank_transfer',
      accountLabel: 'Main Bank', enteredBy: 'maker-1', status: 'draft', reversalOf: null,
    });
    const finMaker = { uid: 'fin-1', role: 'finance_officer' };
    // Creation itself is consent-gated for over-threshold entries, so seed
    // the pending request directly to isolate the checker gate.
    db.__seed('money_approvals', 'req-big', {
      targetType: 'ledger_post', targetId: 'draft-big', targetCollection: 'ledger_entries',
      changePayload: {}, beforeSnapshot: { status: 'draft', amountPkr: 300000, consentId: null, unbudgeted: false, overThreshold: true },
      reason: null, makerUid: 'fin-1', makerRole: 'finance_officer', checkerUid: null, checkerRole: null,
      status: 'pending', auditAction: 'LEDGER_ENTRY_POSTED', createdAt: new Date(), decidedAt: null,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    const holderCaller = { uid: 'holder-finance-only', role: 'member' };
    await expect(decideMoneyApproval(db as never, holderCaller, 'req-big', 'approve')).rejects.toMatchObject({ status: 403 });
    expect(db.__doc('ledger_entries', 'draft-big')?.status).toBe('draft');
  });

  it('expired custom grant falls back to the original checker denial (403)', async () => {
    const db = createFakeFirestore();
    seedOrder(db as never);
    const { id } = await createMoneyApprovalRequest(db as never, maker, {
      targetType: 'order_verify_payment',
      targetId: 'ord-1',
      changePayload: {},
    });
    const expiredCaller = { uid: 'expired-holder', role: 'member' };
    await expect(decideMoneyApproval(db as never, expiredCaller, id, 'approve')).rejects.toMatchObject({ status: 403 });
    expect(db.__doc('orders', 'ord-1')?.status).toBe('pending_verification');
  });
});
