/**
 * @jest-environment node
 */
// ============================================================================
// MIGRATION TARGET — ACTIVATES AGAINST THE MIGRATED SEAMS. DO NOT UNSKIP
// ON THE CURRENT TREE.
//
// These contracts describe the behavior the Supabase-migrated finance code
// MUST have when timestamps arrive from jsonb as ISO strings. They cannot
// pass against current code by construction:
//   - receipts read model (receipts/route.ts toReadModel) computes
//     `new Date((slaDueAt as {seconds}).seconds * 1000)` for any non-Date
//     value — an ISO string yields NaN daysRemaining today;
//   - money-approval.ts toMillis() returns null for a string expiresAt,
//     so an ISO-string expiry would NEVER expire today.
// The whole file is describe.skip so the suite stays green on the current
// tree. When the adapter lands, remove the .skip markers (and this banner)
// in the same change that makes them pass — that flip is the migration's
// acceptance signal for the timestamp seam.
// ============================================================================
import { createFakeFirestore, type FakeFirestore } from './fake-firestore';

const holder: { db: FakeFirestore | null } = { db: null };
const rolePerms: Record<string, Set<string>> = {
  treasurer: new Set(['canManageFinance', 'canApproveMoney', 'canAccessAdmin']),
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
  hasServerPermissionForUser: jest.fn(async (_db: unknown, uid: string, perm: string) => rolePerms['treasurer'].has(perm)),
  resolveCanonicalRole: jest.fn(async () => 'treasurer'),
}));

import { expireIfNeeded } from '../money-approval';
import { GET as receiptsGET } from '@/app/api/admin/finance/receipts/route';

describe.skip('MIGRATION TARGET: ISO-string timestamps from jsonb', () => {
  it('receipts read model: ISO-string slaDueAt gives the same slaBreached/daysRemaining as the Timestamp form', async () => {
    const db = createFakeFirestore() as never as FakeFirestore;
    holder.db = db;
    const base = {
      officerUid: 'officer', kind: 'officer_expense', transactionDate: '2026-09-01', amountPkr: 100,
      receiptDriveId: 'd', deliveredToTreasurerAt: null,
    };
    db.__seed('finance_receipts', 'as-ts', { ...base, slaDueAt: { seconds: 1787000400, nanoseconds: 0 } });
    db.__seed('finance_receipts', 'as-iso', { ...base, slaDueAt: new Date(1787000400 * 1000).toISOString() });
    const req = {
      method: 'GET',
      url: 'http://localhost/api/admin/finance/receipts',
      headers: { get: (h: string) => (h.toLowerCase() === 'authorization' ? 'Bearer token-fin' : null) },
      json: async () => ({}),
    } as never;
    const { receipts } = await (await receiptsGET(req)).json();
    const ts = receipts.find((r: { id: string }) => r.id === 'as-ts');
    const iso = receipts.find((r: { id: string }) => r.id === 'as-iso');
    expect(iso.slaBreached).toBe(ts.slaBreached);
    expect(iso.daysRemaining).toBe(ts.daysRemaining);
    expect(Number.isNaN(iso.daysRemaining)).toBe(false);
  });

  it('expireIfNeeded: an ISO-string expiresAt in the past expires the request', async () => {
    const db = createFakeFirestore() as never as FakeFirestore;
    db.__seed('money_approvals', 'x', { status: 'pending' });
    const req = { id: 'x', status: 'pending', expiresAt: new Date(Date.now() - 60_000).toISOString() } as never;
    expect(await expireIfNeeded(db as never, req)).toBe(true);
    expect(db.__doc('money_approvals', 'x')?.status).toBe('expired');
  });

  it('expireIfNeeded: an ISO-string expiresAt in the future does not expire the request', async () => {
    const db = createFakeFirestore() as never as FakeFirestore;
    db.__seed('money_approvals', 'x', { status: 'pending' });
    const req = { id: 'x', status: 'pending', expiresAt: new Date(Date.now() + 60_000).toISOString() } as never;
    expect(await expireIfNeeded(db as never, req)).toBe(false);
    expect(db.__doc('money_approvals', 'x')?.status).toBe('pending');
  });
});
