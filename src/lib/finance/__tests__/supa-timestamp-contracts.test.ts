/**
 * @jest-environment node
 */
// SUPABASE MIGRATION CONTRACTS — TIMESTAMPS (current behavior).
//
// Finance documents carry Firestore Timestamps (createdAt, postedAt,
// slaDueAt, expiresAt, deliveredToTreasurerAt...); from jsonb they will
// arrive as ISO strings. The ISO-string equivalents are pinned in
// supa-timestamp-target.test.ts (skipped until the migrated seams land).
// THIS file pins how the current code treats time today:
//
//  - Date bucketing has NO timezone conversion anywhere in the finance
//    cluster (grep: no "Karachi", no timeZone, no Intl in lib/routes).
//    Bucketing is by the stored `date` string (YYYY-MM-DD, entered as the
//    Asia/Karachi calendar day) compared lexicographically, and FY
//    derivation parses that string as UTC midnight. A migration that
//    re-parses instants through a timezone WILL shift buckets near
//    midnight PKT (= 19:00 UTC) — these pins catch that.
//  - The two Timestamp representations the code accepts today — a JS
//    Date and the { seconds, nanoseconds } wire shape — must produce
//    identical read models and identical expiry decisions.
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

import { deriveFyLabel, computeAccountBalance } from '../ledger';
import { buildBalanceSheetSummary } from '../reports';
import { expireIfNeeded } from '../money-approval';
import { GET as receiptsGET } from '@/app/api/admin/finance/receipts/route';

describe('timestamp contracts: FY + period bucketing is by stored date string (no TZ shift)', () => {
  it('deriveFyLabel: FY starts 1 July; the boundary dates pin exactly', () => {
    expect(deriveFyLabel('2026-06-30')).toBe('fy2025-26'); // last day of FY2025-26
    expect(deriveFyLabel('2026-07-01')).toBe('fy2026-27'); // first day of FY2026-27
    expect(deriveFyLabel('2027-06-30')).toBe('fy2026-27');
    expect(deriveFyLabel('2026-01-15')).toBe('fy2025-26');
    expect(deriveFyLabel('2026-12-31')).toBe('fy2026-27');
  });

  it('balance-sheet asOf: entry ON asOf counts, entry the day after does not (lexicographic date compare)', () => {
    const mk = (date: string) => ({
      type: 'income' as const, category: 'donations', amountPkr: 100, budgetLineId: null,
      status: 'posted' as const, accountLabel: 'Main Bank', relatedPartyEntryId: null,
      receiptDriveId: null, date,
    });
    const r = buildBalanceSheetSummary(
      [{ label: 'Main Bank', openingBalancePkr: 0 }],
      [mk('2026-10-31'), mk('2026-11-01')],
      '2026-10-31',
    );
    expect(r.accounts[0].netMovementPkr).toBe(100);
  });

  it('computeAccountBalance: periodStart and periodEnd are BOTH inclusive', async () => {
    const db = createFakeFirestore() as never as FakeFirestore;
    const rows: Array<[string, string, number]> = [
      ['before', '2026-09-30', 1],
      ['first', '2026-10-01', 10],
      ['last', '2026-10-31', 100],
      ['after', '2026-11-01', 1000],
    ];
    for (const [id, date, amountPkr] of rows) {
      db.__seed('ledger_entries', id, {
        date, fyLabel: 'fy2026-27', type: 'income', category: 'donations', amountPkr,
        accountLabel: 'Main Bank', status: 'posted', budgetLineId: null,
      });
    }
    const bal = await computeAccountBalance(db as never, 'Main Bank', 0, '2026-10-01', '2026-10-31');
    expect(bal).toBe(110);
  });
});

describe('timestamp contracts: Date and { seconds, nanoseconds } forms behave identically today', () => {
  const DUE = new Date('2026-09-15T00:00:00Z'); // in the past vs any run date >= 2026-10
  const DUE_TS = { seconds: Math.floor(DUE.getTime() / 1000), nanoseconds: 0 };

  it('receipts read model: slaBreached/daysRemaining identical for Date vs Timestamp-wire slaDueAt', async () => {
    const db = createFakeFirestore() as never as FakeFirestore;
    holder.db = db;
    const base = {
      officerUid: 'officer', kind: 'officer_expense', transactionDate: '2026-09-01', amountPkr: 100,
      receiptDriveId: 'd', deliveredToTreasurerAt: null,
    };
    db.__seed('finance_receipts', 'as-date', { ...base, slaDueAt: DUE });
    db.__seed('finance_receipts', 'as-ts', { ...base, slaDueAt: DUE_TS });
    const req = {
      method: 'GET',
      url: 'http://localhost/api/admin/finance/receipts',
      headers: { get: (h: string) => (h.toLowerCase() === 'authorization' ? 'Bearer token-fin' : null) },
      json: async () => ({}),
    } as never;
    const res = await receiptsGET(req);
    expect(res.status).toBe(200);
    const { receipts } = await res.json();
    const a = receipts.find((r: { id: string }) => r.id === 'as-date');
    const b = receipts.find((r: { id: string }) => r.id === 'as-ts');
    expect(a.slaBreached).toBe(true);
    expect(b.slaBreached).toBe(true);
    expect(b.daysRemaining).toBe(a.daysRemaining);
    expect(a.daysRemaining).toBeLessThan(0);
  });

  it('receipts read model: a delivered receipt reports daysRemaining null in both forms', async () => {
    const db = createFakeFirestore() as never as FakeFirestore;
    holder.db = db;
    const base = {
      officerUid: 'officer', kind: 'officer_expense', transactionDate: '2026-09-01', amountPkr: 100,
      receiptDriveId: 'd', deliveredToTreasurerAt: new Date('2026-09-10T00:00:00Z'),
    };
    db.__seed('finance_receipts', 'del-date', { ...base, slaDueAt: DUE });
    db.__seed('finance_receipts', 'del-ts', { ...base, slaDueAt: DUE_TS });
    const req = {
      method: 'GET',
      url: 'http://localhost/api/admin/finance/receipts',
      headers: { get: (h: string) => (h.toLowerCase() === 'authorization' ? 'Bearer token-fin' : null) },
      json: async () => ({}),
    } as never;
    const { receipts } = await (await receiptsGET(req)).json();
    for (const id of ['del-date', 'del-ts']) {
      const r = receipts.find((x: { id: string }) => x.id === id);
      expect(r.slaBreached).toBe(false);
      expect(r.daysRemaining).toBeNull();
    }
  });

  it('expireIfNeeded: past expiry fires for BOTH Date and { seconds } forms; future expiry does not', async () => {
    const db = createFakeFirestore() as never as FakeFirestore;
    const past = new Date(Date.now() - 60_000);
    const mk = (expiresAt: unknown) => ({
      id: 'x', status: 'pending', expiresAt,
    }) as never;
    db.__seed('money_approvals', 'x', { status: 'pending' });
    expect(await expireIfNeeded(db as never, mk(past))).toBe(true);
    expect(db.__doc('money_approvals', 'x')?.status).toBe('expired');

    const db2 = createFakeFirestore() as never as FakeFirestore;
    db2.__seed('money_approvals', 'x', { status: 'pending' });
    expect(await expireIfNeeded(db2 as never, mk({ seconds: Math.floor(past.getTime() / 1000) }))).toBe(true);

    const db3 = createFakeFirestore() as never as FakeFirestore;
    db3.__seed('money_approvals', 'x', { status: 'pending' });
    const future = new Date(Date.now() + 60_000);
    expect(await expireIfNeeded(db3 as never, mk(future))).toBe(false);
    expect(await expireIfNeeded(db3 as never, mk({ seconds: Math.floor(future.getTime() / 1000) }))).toBe(false);
    expect(db3.__doc('money_approvals', 'x')?.status).toBe('pending');
  });

  it('receipts POST stamps slaDueAt as transactionDate + 14 days and returns it as an ISO string', async () => {
    // The response-side contract the client already consumes; the stored
    // value is a Date today and will be an ISO string from jsonb — the
    // RESPONSE must stay an ISO string either way (pinned in route parity).
    const db = createFakeFirestore() as never as FakeFirestore;
    holder.db = db;
    const { POST } = await import('@/app/api/admin/finance/receipts/route');
    const req = {
      method: 'POST',
      url: 'http://localhost/api/admin/finance/receipts',
      headers: { get: (h: string) => (h.toLowerCase() === 'authorization' ? 'Bearer token-fin' : null) },
      json: async () => ({ kind: 'officer_expense', transactionDate: '2026-10-01', amountPkr: 10, receiptDriveId: 'd' }),
    } as never;
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.slaDueAt).toBe('2026-10-15T00:00:00.000Z');
  });
});
