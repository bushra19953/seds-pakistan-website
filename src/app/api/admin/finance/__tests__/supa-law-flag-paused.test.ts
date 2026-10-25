/**
 * @jest-environment node
 */
// SUPABASE MIGRATION CONTRACTS — LAW: controls-paused flag.
//
// FINANCE_MAKER_CHECKER_ENFORCED=false (src/lib/finance/flags.ts, spec
// Part C 9 rollback control) pauses the approvals POST path with 503.
// Surfaces do NOT fall back to direct writes. The flag is a compile-time
// const (true in the current tree), so this suite mocks the flags module
// OFF and pins both layers of the paused behavior:
//   1. engine: createMoneyApprovalRequest throws MoneyApprovalError 503
//      before touching the store — no request document is created;
//   2. route: POST /api/admin/finance/approvals surfaces 503 { error }
//      even for a fully permissioned caller with a valid target.
// The migrated flag mechanism (whatever replaces the const) must keep
// this exact observable behavior.
import { createFakeFirestore, type FakeFirestore } from '@/lib/finance/__tests__/fake-firestore';

const holder: { db: FakeFirestore | null } = { db: null };
const uidRoles: Record<string, string> = { fin: 'treasurer' };
const rolePerms: Record<string, Set<string>> = {
  treasurer: new Set(['canManageFinance', 'canApproveMoney']),
};

jest.mock('@/lib/finance/flags', () => ({ FINANCE_MAKER_CHECKER_ENFORCED: false }));
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

import { createMoneyApprovalRequest } from '@/lib/finance/money-approval';
import { POST as approvalsPOST } from '../approvals/route';

function req(uid: string, body?: unknown) {
  return {
    method: 'POST',
    url: 'http://localhost/api/admin/finance/approvals',
    headers: { get: (h: string) => (h.toLowerCase() === 'authorization' ? `Bearer token-${uid}` : null) },
    json: async () => body ?? {},
  } as never;
}

describe('LAW: FINANCE_MAKER_CHECKER_ENFORCED=false pauses approvals with 503', () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = createFakeFirestore() as never;
    holder.db = db;
    db.__seed('finance_budgets', 'bud-1', { status: 'draft', fyLabel: 'fy2026-27', revision: 1, lines: [] });
  });

  it('engine: createMoneyApprovalRequest rejects 503 and writes NO request document', async () => {
    await expect(
      createMoneyApprovalRequest(db as never, { uid: 'fin', role: 'treasurer' }, {
        targetType: 'budget_approve', targetId: 'bud-1', changePayload: {},
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(db.__store.get('money_approvals')?.size ?? 0).toBe(0);
  });

  it('route: approvals POST returns 503 { error } for a fully permissioned caller', async () => {
    const res = await approvalsPOST(req('fin', { targetType: 'budget_approve', targetId: 'bud-1', changePayload: {} }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
    expect(body.error).toMatch(/paused/);
    expect(db.__store.get('money_approvals')?.size ?? 0).toBe(0);
  });
});
