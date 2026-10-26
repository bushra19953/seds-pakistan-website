/**
 * @jest-environment node
 */
// SUPABASE CUTOVER — FINANCE WRITES RED CONTRACTS (design wave,
// feat/supa-cut-finance-design). Design: ~/workspace/supabase-migration/
// cutover-sections/finance-design.md.
//
// These contracts pin the TARGET behavior for finance write-primary
// (SUPA_PRIMARY=finance -> Postgres functions via adapter rpc(), caller-
// supplied idempotency keys). They drive the REAL current entry points
// with a mocked '@/lib/supa' transport. Finance READS are forced to the
// fake-Firestore side (seam test hooks, enabled=false) so only the WRITE
// path is under test.
//
// Expected state on the design branch: every "ON:" test FAILS for the
// stated reason — the current code has no isSupaPrimary/rpc write path,
// so writes land in fake Firestore and rpc is never called. Every "OFF:"
// test PASSES today and must keep passing after the build (byte-identity
// pin). Each test name states the invariant it pins.
import { createFakeFirestore, type FakeFirestore } from './fake-firestore';

/* ------------------------------------------------------------ rpc mock */
interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}
const mockRpc: { calls: RpcCall[]; impl: ((fn: string, args: Record<string, unknown>) => unknown) | null } = {
  calls: [],
  impl: null,
};

function defaultRpcImpl(fn: string, args: Record<string, unknown>): unknown {
  switch (fn) {
    case 'finance_create_money_approval':
      return { ok: true, id: (args.p_new_id as string) ?? 'rpc-created-id' };
    case 'finance_decide_money_approval':
      return { ok: true, status: args.p_decision === 'reject' ? 'rejected' : 'approved_applied' };
    case 'finance_expire_money_approval':
      return { ok: true, expired: true };
    case 'finance_complete_reconciliation':
      return { ok: true, id: args.p_rec_id, status: 'completed', ledgerBalancePkr: 4000, differencePkr: 0 };
    case 'finance_ledger_create_draft':
      return { ok: true, id: (args.p_new_id as string) ?? 'rpc-entry-id', fyLabel: 'fy2026-27', unbudgeted: false, overThreshold: false };
    default:
      return { ok: true };
  }
}

jest.mock('@/lib/supa', () => {
  const rpc = jest.fn(async (fn: string, args: Record<string, unknown>) => {
    mockRpc.calls.push({ fn, args });
    return mockRpc.impl ? mockRpc.impl(fn, args) : defaultRpcImpl(fn, args);
  });
  const adapter = {
    getDoc: async () => null,
    listDocs: async () => [],
    countDocs: async () => 0,
    setDoc: async () => ({}),
    updateDoc: async () => ({}),
    deleteDoc: async () => undefined,
    rpc,
  };
  return {
    getSupaClient: () => ({}),
    getSupaAdapter: () => adapter,
    resetSupaClientForTests: () => undefined,
    createSupaAdapter: () => adapter,
    useSupa: () => false,
    parseSupaSurfaces: () => new Set<string>(),
    // Foundation primitive (design target): SUPA_PRIMARY=finance means
    // write-primary for the finance surface. Mocked here per the flag law.
    isSupaPrimary: (surface: string) =>
      (process.env.SUPA_PRIMARY ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .includes(surface.trim().toLowerCase()),
    __mockRpc: rpc,
  };
});

/* ------------------------------------------------------- auth/db mocks */
const holder: { db: FakeFirestore | null } = { db: null };
const uidRoles: Record<string, string> = {
  'maker-1': 'treasurer',
  'checker-1': 'president',
  'checker-2': 'treasurer',
  'fin-1': 'treasurer',
  'rec-maker': 'treasurer',
  'rec-checker': 'finance_lead',
};
const rolePerms: Record<string, Set<string>> = {
  president: new Set(['canApproveMoney']),
  treasurer: new Set(['canApproveMoney', 'canManageFinance', 'canAccessAdmin']),
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
  FieldValue: {
    serverTimestamp: () => ({ __serverTimestamp: true }),
    arrayUnion: (v: unknown) => ({ __arrayUnion: v }),
  },
}));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async (role: string, perm: string) => rolePerms[role]?.has(perm) ?? false),
  hasServerPermissionForUser: jest.fn(
    async (_db: unknown, uid: string, perm: string) => rolePerms[uidRoles[uid] ?? 'member']?.has(perm) ?? false,
  ),
  resolveCanonicalRole: jest.fn(async (_db: unknown, uid: string) => uidRoles[uid] ?? 'member'),
}));

import {
  createMoneyApprovalRequest,
  decideMoneyApproval,
  expireIfNeeded,
  snapshotFor,
} from '../money-approval';
import { __setFinanceSupaEnabledForTests, __setFinanceSupaPortForTests } from '../supa/_shared';
import { POST as ledgerPOST } from '@/app/api/admin/finance/ledger/route';
import { POST as completePOST } from '@/app/api/admin/finance/reconciliations/complete/route';

const maker = { uid: 'maker-1', role: 'treasurer' };
const checker = { uid: 'checker-1', role: 'president' };

function seedOrder(db: FakeFirestore) {
  db.__seed('orders', 'ord-1', {
    status: 'pending_verification',
    paymentStatus: 'pending',
    total: 2000,
    totalPkr: 2000,
    buyerUserId: 'buyer-1',
    buyer: { fullName: 'Buyer One', email: 'b@example.com' },
    items: [],
    originatingModule: 'store',
    receiptUrl: 'https://drive.example/r1',
  });
}

function seedPendingApproval(db: FakeFirestore, id = 'appr-1') {
  const order = db.__doc('orders', 'ord-1')!;
  db.__seed('money_approvals', id, {
    targetType: 'order_verify_payment',
    targetId: 'ord-1',
    targetCollection: 'orders',
    changePayload: {},
    beforeSnapshot: snapshotFor('order_verify_payment', order),
    reason: null,
    makerUid: 'maker-1',
    makerRole: 'treasurer',
    checkerUid: null,
    checkerRole: null,
    status: 'pending',
    auditAction: 'ORDER_PAYMENT_VERIFIED',
    createdAt: new Date(),
    decidedAt: null,
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  });
}

function auditActions(db: FakeFirestore): string[] {
  const logs = db.__store.get('audit_logs');
  if (!logs) return [];
  return [...logs.values()].map((d) => d.action as string);
}

function req(uid: string, body: unknown) {
  return {
    method: 'POST',
    url: 'http://localhost/api/admin/finance',
    headers: { get: (h: string) => (h.toLowerCase() === 'authorization' ? `Bearer ${'token'}-${uid}` : null) },
    json: async () => body,
  } as never;
}

/** Deep-scan rpc args for forbidden timestamp shapes (design T2). */
function findForbiddenTimestampShapes(v: unknown, path = '$'): string[] {
  const hits: string[] = [];
  if (v instanceof Date) hits.push(`${path}:Date`);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('__serverTimestamp' in o) hits.push(`${path}:serverTimestamp-sentinel`);
    if ('_seconds' in o || 'seconds' in o) hits.push(`${path}:firestore-timestamp-object`);
    for (const [k, val] of Object.entries(o)) hits.push(...findForbiddenTimestampShapes(val, `${path}.${k}`));
  }
  return hits;
}

beforeEach(() => {
  mockRpc.calls = [];
  mockRpc.impl = null;
  delete process.env.SUPA_PRIMARY;
  __setFinanceSupaEnabledForTests(false); // reads: fake Firestore side
  __setFinanceSupaPortForTests(null);
  holder.db = null;
});

function onPrimary() {
  process.env.SUPA_PRIMARY = 'finance';
}

/* ============================================================ OFF pins */
describe('OFF byte-identity pins (must pass before AND after the build)', () => {
  it('OFF: create+decide run entirely on Firestore and rpc is never called', async () => {
    const db = createFakeFirestore();
    holder.db = db;
    seedOrder(db);
    const { id } = await createMoneyApprovalRequest(db as never, maker, {
      targetType: 'order_verify_payment',
      targetId: 'ord-1',
      changePayload: {},
    });
    const res = await decideMoneyApproval(db as never, checker, id, 'approve');
    expect(res.status).toBe('approved_applied');
    expect(db.__doc('orders', 'ord-1')?.status).toBe('verified');
    expect(auditActions(db)).toContain('MONEY_APPROVAL_REQUESTED');
    expect(auditActions(db)).toContain('ORDER_PAYMENT_VERIFIED');
    expect(mockRpc.calls).toHaveLength(0);
  });

  it('OFF: ledger POST writes the draft + audit on Firestore and rpc is never called', async () => {
    const db = createFakeFirestore();
    holder.db = db;
    const res = await ledgerPOST(
      req('fin-1', {
        date: '2026-10-05',
        type: 'income',
        amountPkr: 5000,
        category: 'donations',
        paymentMethod: 'bank_transfer',
        accountLabel: 'Main Bank',
      }),
    );
    expect(res.status).toBe(201);
    expect([...(db.__store.get('ledger_entries')?.values() ?? [])]).toHaveLength(1);
    expect(auditActions(db)).toContain('LEDGER_DRAFT_CREATED');
    expect(mockRpc.calls).toHaveLength(0);
  });
});

/* ==================================================== F1 create (ON) */
describe('ON: finance_create_money_approval', () => {
  it('atomicity shape: ON create is exactly one rpc and zero Firestore writes', async () => {
    onPrimary();
    const db = createFakeFirestore();
    holder.db = db;
    seedOrder(db);
    await createMoneyApprovalRequest(db as never, maker, {
      targetType: 'order_verify_payment',
      targetId: 'ord-1',
      changePayload: {},
    });
    expect(mockRpc.calls.map((c) => c.fn)).toEqual(['finance_create_money_approval']);
    expect(db.__store.get('money_approvals')).toBeUndefined();
    expect(auditActions(db)).toHaveLength(0);
  });

  it('idempotent replay: a retried create reuses the same key and returns the same id', async () => {
    onPrimary();
    const db = createFakeFirestore();
    holder.db = db;
    seedOrder(db);
    const input = { targetType: 'order_verify_payment' as const, targetId: 'ord-1', changePayload: {} };
    const first = await createMoneyApprovalRequest(db as never, maker, input);
    const second = await createMoneyApprovalRequest(db as never, maker, input);
    expect(second.id).toBe(first.id);
    const keys = mockRpc.calls.map((c) => c.args.p_idempotency_key as string);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toContain('create:order_verify_payment:ord-1');
  });

  it('timestamp law T2/T4: create rpc args carry no Date, sentinel, or Firestore timestamp objects (expiry is computed inside the function)', async () => {
    onPrimary();
    const db = createFakeFirestore();
    holder.db = db;
    seedOrder(db);
    await createMoneyApprovalRequest(db as never, maker, {
      targetType: 'order_verify_payment',
      targetId: 'ord-1',
      changePayload: {},
    });
    expect(mockRpc.calls).toHaveLength(1);
    expect(findForbiddenTimestampShapes(mockRpc.calls[0].args)).toEqual([]);
  });
});

/* ==================================================== F2 decide (ON) */
describe('ON: finance_decide_money_approval', () => {
  it('atomicity shape: ON approve is exactly one rpc; target, approval, and audit in Firestore are untouched (the SQL tx owns all three)', async () => {
    onPrimary();
    const db = createFakeFirestore();
    holder.db = db;
    seedOrder(db);
    seedPendingApproval(db);
    const res = await decideMoneyApproval(db as never, checker, 'appr-1', 'approve');
    expect(res.status).toBe('approved_applied');
    expect(mockRpc.calls.map((c) => c.fn)).toEqual(['finance_decide_money_approval']);
    expect(db.__doc('orders', 'ord-1')?.status).toBe('pending_verification');
    expect(db.__doc('money_approvals', 'appr-1')?.status).toBe('pending');
    expect(auditActions(db)).toHaveLength(0);
  });

  it('idempotency key: decide key is deterministic decide:{approvalId}:{decision}:{checkerUid} and carries the checker permission resolution as an explicit arg', async () => {
    onPrimary();
    const db = createFakeFirestore();
    holder.db = db;
    seedOrder(db);
    seedPendingApproval(db);
    await decideMoneyApproval(db as never, checker, 'appr-1', 'approve');
    expect(mockRpc.calls).toHaveLength(1);
    const args = mockRpc.calls[0].args;
    expect(args.p_idempotency_key).toBe('decide:appr-1:approve:checker-1');
    expect(args.p_approval_id).toBe('appr-1');
    expect(args.p_checker_uid).toBe('checker-1');
    expect(args.p_checker_can_manage_finance).toBe(false); // president lacks canManageFinance
  });

  it('concurrent decide race: two checkers deciding at once both route through rpc; exactly one applies, the other maps the function 409, and Firestore sees no writes', async () => {
    onPrimary();
    const db = createFakeFirestore();
    holder.db = db;
    seedOrder(db);
    seedPendingApproval(db);
    let n = 0;
    mockRpc.impl = (fn) => {
      if (fn !== 'finance_decide_money_approval') return defaultRpcImpl(fn, {});
      n += 1;
      return n === 1
        ? { ok: true, status: 'approved_applied' }
        : { ok: false, httpStatus: 409, message: 'Request is already approved_applied' };
    };
    const results = await Promise.allSettled([
      decideMoneyApproval(db as never, checker, 'appr-1', 'approve'),
      decideMoneyApproval(db as never, { uid: 'checker-2', role: 'treasurer' }, 'appr-1', 'approve'),
    ]);
    expect(mockRpc.calls.filter((c) => c.fn === 'finance_decide_money_approval')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409 });
    expect(db.__doc('money_approvals', 'appr-1')?.status).toBe('pending');
    expect(auditActions(db)).toHaveLength(0);
  });

  it('gate parity: a GATE_NOT_SATISFIED function result maps to 422 with the request left pending and NO apply_failed stamp attempted', async () => {
    onPrimary();
    const db = createFakeFirestore();
    holder.db = db;
    db.__seed('sponsors_partners', 'crm-1', {
      status: 'Pending',
      isRelatedParty: true,
      relatedParty: { consentRequestId: 'consent-x' },
      financials: {},
    });
    db.__seed('money_approvals', 'appr-crm', {
      targetType: 'crm_status_active',
      targetId: 'crm-1',
      targetCollection: 'sponsors_partners',
      changePayload: {},
      beforeSnapshot: snapshotFor('crm_status_active', db.__doc('sponsors_partners', 'crm-1')!),
      reason: null,
      makerUid: 'maker-1',
      makerRole: 'treasurer',
      checkerUid: null,
      checkerRole: null,
      status: 'pending',
      auditAction: 'CRM_STATUS_ACTIVATED',
      createdAt: new Date(),
      decidedAt: null,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    });
    mockRpc.impl = (fn) =>
      fn === 'finance_decide_money_approval'
        ? { ok: false, httpStatus: 422, code: 'GATE_NOT_SATISFIED', message: 'Related-party gate not satisfied' }
        : defaultRpcImpl(fn, {});
    await expect(decideMoneyApproval(db as never, checker, 'appr-crm', 'approve')).rejects.toMatchObject({
      status: 422,
      code: 'GATE_NOT_SATISFIED',
    });
    // Exactly one rpc: no follow-up apply_failed stamp call, no Firestore write.
    expect(mockRpc.calls).toHaveLength(1);
    expect(db.__doc('money_approvals', 'appr-crm')?.status).toBe('pending');
  });

  it('audit parity: ON reject routes through the same single rpc (the function writes MONEY_APPROVAL_REJECTED atomically) and Firestore stays untouched', async () => {
    onPrimary();
    const db = createFakeFirestore();
    holder.db = db;
    seedOrder(db);
    seedPendingApproval(db);
    const res = await decideMoneyApproval(db as never, checker, 'appr-1', 'reject', 'no proof');
    expect(res.status).toBe('rejected');
    expect(mockRpc.calls.map((c) => c.fn)).toEqual(['finance_decide_money_approval']);
    expect(mockRpc.calls[0].args.p_decision).toBe('reject');
    expect(db.__doc('money_approvals', 'appr-1')?.status).toBe('pending');
    expect(auditActions(db)).toHaveLength(0);
  });
});

/* ===================================================== F3 expire (ON) */
describe('ON: finance_expire_money_approval', () => {
  it('ON expire is one rpc with key expire:{approvalId} and no Firestore update; an ISO-string expiresAt in the past expires (never-expire regression pin)', async () => {
    onPrimary();
    const db = createFakeFirestore();
    holder.db = db;
    seedOrder(db);
    seedPendingApproval(db);
    const reqDoc = {
      id: 'appr-1',
      ...(db.__doc('money_approvals', 'appr-1') as Record<string, unknown>),
      // ISO string form, as served from Supabase jsonb — the shape that
      // used to NEVER expire before the read-migration toMillis fix.
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    };
    const expired = await expireIfNeeded(db as never, reqDoc as never);
    expect(expired).toBe(true);
    expect(mockRpc.calls.map((c) => c.fn)).toEqual(['finance_expire_money_approval']);
    expect(mockRpc.calls[0].args.p_idempotency_key).toBe('expire:appr-1');
    expect(db.__doc('money_approvals', 'appr-1')?.status).toBe('pending');
    expect(auditActions(db)).toHaveLength(0); // expire has NO audit row today; parity keeps it so (Q3)
  });
});

/* ============================================ F5 batch family (ON) */
describe('ON: batch(doc+audit) family', () => {
  it('atomicity shape: ON ledger POST is one rpc carrying the LEDGER_DRAFT_CREATED audit descriptor; no Firestore doc or audit row is written', async () => {
    onPrimary();
    const db = createFakeFirestore();
    holder.db = db;
    const res = await ledgerPOST(
      req('fin-1', {
        date: '2026-10-05',
        type: 'income',
        amountPkr: 5000,
        category: 'donations',
        paymentMethod: 'bank_transfer',
        accountLabel: 'Main Bank',
      }),
    );
    expect(res.status).toBe(201);
    expect(mockRpc.calls.map((c) => c.fn)).toEqual(['finance_ledger_create_draft']);
    expect(JSON.stringify(mockRpc.calls[0].args)).toContain('LEDGER_DRAFT_CREATED');
    expect(db.__store.get('ledger_entries')).toBeUndefined();
    expect(auditActions(db)).toHaveLength(0);
  });

  it('timestamp law T2: ledger create rpc args contain no serverTimestamp sentinels (the function stamps createdAt/updatedAt)', async () => {
    onPrimary();
    const db = createFakeFirestore();
    holder.db = db;
    await ledgerPOST(
      req('fin-1', {
        date: '2026-10-05',
        type: 'expense',
        amountPkr: 1200,
        category: 'operations',
        paymentMethod: 'bank_transfer',
        accountLabel: 'Main Bank',
      }),
    );
    expect(mockRpc.calls).toHaveLength(1);
    expect(findForbiddenTimestampShapes(mockRpc.calls[0].args)).toEqual([]);
  });
});

/* ==================================================== F4 complete (ON) */
describe('ON: finance_complete_reconciliation', () => {
  it('atomicity shape + distinct-UID law: ON complete is one rpc (recompute + update + audit inside the function); Firestore rec stays draft and no audit row lands locally', async () => {
    onPrimary();
    const db = createFakeFirestore();
    holder.db = db;
    db.__seed('ledger_entries', 'e1', {
      date: '2026-10-03', fyLabel: 'fy2026-27', type: 'income', category: 'donations',
      amountPkr: 5000, accountLabel: 'Main Bank', status: 'posted', budgetLineId: null,
    });
    db.__seed('ledger_entries', 'e2', {
      date: '2026-10-10', fyLabel: 'fy2026-27', type: 'expense', category: 'operations',
      amountPkr: 2000, accountLabel: 'Main Bank', status: 'posted', budgetLineId: null,
    });
    db.__seed('finance_reconciliations', 'main-bank-2026-10', {
      accountLabel: 'Main Bank',
      periodMonth: '2026-10',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      openingBalancePkr: 1000,
      closingBalancePkr: 4000,
      statementDriveId: 'drive-stmt-1',
      differenceExplanation: '',
      status: 'draft',
      reconciledBy: 'rec-maker',
      complianceObligationId: null,
    });
    const res = await completePOST(req('rec-checker', { id: 'main-bank-2026-10' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('completed');
    expect(mockRpc.calls.map((c) => c.fn)).toEqual(['finance_complete_reconciliation']);
    expect(mockRpc.calls[0].args.p_idempotency_key).toBe('complete:main-bank-2026-10:rec-checker');
    expect(db.__doc('finance_reconciliations', 'main-bank-2026-10')?.status).toBe('draft');
    expect(auditActions(db)).toHaveLength(0);
  });
});
