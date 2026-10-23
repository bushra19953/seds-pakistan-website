/**
 * @jest-environment node
 */
// Reconciliation tests (spec Part C section 7, cases 16-18).
import { createFakeFirestore, type FakeFirestore } from '@/lib/finance/__tests__/fake-firestore';

const holder: { db: FakeFirestore | null } = { db: null };
const uidRoles: Record<string, string> = { 'rec-maker': 'treasurer', 'rec-checker': 'finance_lead' };
const rolePerms: Record<string, Set<string>> = {
  treasurer: new Set(['canManageFinance']),
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
const customGrants: Record<string, { perms: Set<string>; expired: boolean }> = {
  'custom-holder': { perms: new Set(['canManageFinance']), expired: false },
  'expired-holder': { perms: new Set(['canManageFinance']), expired: true },
};
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async (role: string, perm: string) => rolePerms[role]?.has(perm) ?? false),
  hasServerPermissionForUser: jest.fn(
    async (_db: unknown, uid: string, perm: string) =>
      (rolePerms[uidRoles[uid] ?? 'member']?.has(perm) ?? false) ||
      (!!customGrants[uid] && !customGrants[uid].expired && customGrants[uid].perms.has(perm)),
  ),
  resolveCanonicalRole: jest.fn(async (_db: unknown, uid: string) => uidRoles[uid] ?? 'member'),
}));

import { POST, PUT } from '../route';
import { POST as completePOST } from '../complete/route';

function req(uid: string, body: unknown) {
  return {
    method: 'POST',
    url: 'http://localhost/api/admin/finance/reconciliations',
    headers: { get: (h: string) => (h.toLowerCase() === 'authorization' ? `Bearer token-${uid}` : null) },
    json: async () => body,
  } as never;
}

function seedLedger(db: FakeFirestore) {
  // Opening 1000 + income 5000 - expense 2000 = ledger balance 4000 for Oct 2026.
  db.__seed('ledger_entries', 'e1', {
    date: '2026-10-03', fyLabel: 'fy2026-27', type: 'income', category: 'donations', amountPkr: 5000,
    accountLabel: 'Main Bank', status: 'posted', budgetLineId: null,
  });
  db.__seed('ledger_entries', 'e2', {
    date: '2026-10-10', fyLabel: 'fy2026-27', type: 'expense', category: 'operations', amountPkr: 2000,
    accountLabel: 'Main Bank', status: 'posted', budgetLineId: null,
  });
  db.__seed('ledger_entries', 'e3-draft', {
    date: '2026-10-11', fyLabel: 'fy2026-27', type: 'income', category: 'donations', amountPkr: 7777,
    accountLabel: 'Main Bank', status: 'draft', budgetLineId: null,
  });
}

async function createRec(db: FakeFirestore, closingBalancePkr: number) {
  const res = await POST(req('rec-maker', {
    accountLabel: 'Main Bank', periodMonth: '2026-10', openingBalancePkr: 1000,
  }));
  const { id } = await res.json();
  expect(id).toBe('main-bank-2026-10');
  await PUT(req('rec-maker', { id, closingBalancePkr, statementDriveId: 'drive-stmt-1' }));
  return id as string;
}

describe('reconciliations (cases 16-18)', () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = createFakeFirestore() as never;
    holder.db = db;
    seedLedger(db);
  });

  it('case 16: reconciliation_completed_by_different_user', async () => {
    const id = await createRec(db, 4000);
    const res = await completePOST(req('rec-checker', { id }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ledgerBalancePkr).toBe(4000);
    expect(body.differencePkr).toBe(0);
    const rec = db.__doc('finance_reconciliations', id)!;
    expect(rec.status).toBe('completed');
    expect(rec.checkedBy).toBe('rec-checker');
    expect(rec.reconciledBy).toBe('rec-maker');
  });

  it('case 17: same_user_cannot_complete_reconciliation - 422', async () => {
    const id = await createRec(db, 4000);
    const res = await completePOST(req('rec-maker', { id }));
    expect(res.status).toBe(422);
    expect(db.__doc('finance_reconciliations', id)?.status).toBe('draft');
  });

  it('case 18: unexplained_difference_blocks_completion', async () => {
    const id = await createRec(db, 4500); // statement 4500 vs ledger 4000 -> difference 500
    const blocked = await completePOST(req('rec-checker', { id }));
    expect(blocked.status).toBe(422);
    await PUT(req('rec-maker', { id, differenceExplanation: 'Bank charges not yet entered in the ledger' }));
    const ok = await completePOST(req('rec-checker', { id }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).differencePkr).toBe(500);
  });

  it('client-supplied ledger balance that differs from recomputation is rejected', async () => {
    const id = await createRec(db, 4000);
    const res = await completePOST(req('rec-checker', { id, ledgerBalancePkr: 9999 }));
    expect(res.status).toBe(422);
  });
});

describe('reconciliations parity: custom-role holder (Family C)', () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = createFakeFirestore() as never;
    holder.db = db;
    seedLedger(db);
  });

  it('primary member + unexpired custom canManageFinance grant can create a reconciliation (C16)', async () => {
    const res = await POST(req('custom-holder', {
      accountLabel: 'Main Bank', periodMonth: '2026-10', openingBalancePkr: 1000,
    }));
    expect(res.status).not.toBe(403);
    expect(db.__doc('finance_reconciliations', 'main-bank-2026-10')).toBeTruthy();
  });

  it('expired custom grant falls back to the original denial (403)', async () => {
    const res = await POST(req('expired-holder', {
      accountLabel: 'Main Bank', periodMonth: '2026-10', openingBalancePkr: 1000,
    }));
    expect(res.status).toBe(403);
  });

  it('primary member with no grant is denied unchanged (403)', async () => {
    const res = await POST(req('plain-member', {
      accountLabel: 'Main Bank', periodMonth: '2026-10', openingBalancePkr: 1000,
    }));
    expect(res.status).toBe(403);
  });
});
