/**
 * @jest-environment node
 */
// SUPABASE MIGRATION CONTRACTS — AMOUNT PRECISION (finance cluster).
//
// The migration landing shape stores each finance document body as jsonb
// (a `data` column). Firestore stores amounts as JS numbers; jsonb
// round-trips through JSON serialization. These contracts prove, for every
// finance amount field, that a JSON serialize/parse cycle (the simulated
// jsonb round-trip) preserves the EXACT double, and that every aggregation
// in the finance lib (reports.ts summations, ledger balances, budget line
// actuals) produces the identical number on round-tripped input as on the
// Firestore-path input — pinned to the exact literal the current code
// produces today, float artifacts included. If a migrated implementation
// rounds, truncates, stringifies, or reorders a summation, these tests
// FAIL with both values in the assertion output. Drift found here is a
// migration blocker, never something to "fix" by editing the expectation.
//
// Note the module's own convention (src/types/finance.ts): live amounts
// are integer PKR and the write routes enforce Number.isInteger. Decimal
// values below pin the STORAGE/AGGREGATION layer, which also consumes
// legacy order totals (order-canonical accepts any finite number) and
// historical documents the integer validators never saw.
import { createFakeFirestore, type FakeFirestore } from './fake-firestore';

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => ({ __serverTimestamp: true }),
    arrayUnion: (v: unknown) => ({ __arrayUnion: v }),
  },
}));

import { buildIncomeExpenditure, buildVariance, buildBalanceSheetSummary, buildOrderIncome } from '../reports';
import { computeLineActuals, computeAccountBalance } from '../ledger';
import { normalizeOrder } from '../order-canonical';

/** Simulated jsonb round-trip: exactly what a `data` jsonb column does to a doc body. */
function jsonb<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function expectExact(actual: number, expected: number, label: string) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `AMOUNT DRIFT [${label}]: firestore-path=${expected} jsonb-path=${actual} ` +
        `(json firestore=${JSON.stringify(expected)} jsonb=${JSON.stringify(actual)})`,
    );
  }
  expect(actual).toBe(expected);
}

/* ---------- 1. Per-value round-trip, per finance amount field ---------- */

// The pinned value set: zero, one, whole PKR integers, tenths, the classic
// 0.1+0.2 artifact, realistic large PKR decimals, the stated maximum,
// sub-paisa fractions, exponent-notation values, and the safe-integer edge.
const PINNED_VALUES: Array<[string, number]> = [
  ['zero', 0],
  ['one', 1],
  ['whole PKR integer (ledger amount)', 5000],
  ['expenditure threshold PKR 250000', 250000],
  ['one tenth', 0.1],
  ['two tenths', 0.2],
  ['0.1+0.2 artifact', 0.1 + 0.2],
  ['large decimal 123456789.12', 123456789.12],
  ['max realistic 999999999.99', 999999999.99],
  ['small fraction 0.000001', 0.000001],
  ['exponent notation 1e-7 (json "1e-7")', 1e-7],
  ['exponent notation 1.5e21 (json "1.5e+21")', 1.5e21],
  ['Number.MAX_SAFE_INTEGER', 9007199254740991],
  ['2^53 (first unsafe integer)', 9007199254740992],
  ['receipt-style 1234.56', 1234.56],
];

// Every finance amount field, exercised through a whole-document round-trip
// shaped like the real collection documents.
const DOC_BUILDERS: Array<[string, (amount: number) => Record<string, unknown>, string]> = [
  ['ledger_entries.amountPkr', (a) => ({ date: '2026-10-05', type: 'expense', amountPkr: a, status: 'posted' }), 'amountPkr'],
  ['finance_budgets.lines[].allocatedPkr', (a) => ({ fyLabel: 'fy2026-27', lines: [{ lineId: 'l1', allocatedPkr: a }] }), 'lines'],
  ['finance_budgets.totalAllocatedPkr', (a) => ({ fyLabel: 'fy2026-27', totalAllocatedPkr: a }), 'totalAllocatedPkr'],
  ['finance_receipts.amountPkr', (a) => ({ kind: 'officer_expense', amountPkr: a }), 'amountPkr'],
  ['money_approvals snapshot amountPkr (ledger_post beforeSnapshot)', (a) => ({ beforeSnapshot: { amountPkr: a } }), 'beforeSnapshot'],
  ['finance_reconciliations.openingBalancePkr', (a) => ({ openingBalancePkr: a, closingBalancePkr: null }), 'openingBalancePkr'],
  ['finance_reconciliations.closingBalancePkr', (a) => ({ closingBalancePkr: a }), 'closingBalancePkr'],
  ['orders.totalPkr (report input)', (a) => ({ totalPkr: a, paymentStatus: 'completed' }), 'totalPkr'],
  ['settings/finance accounts[].openingBalancePkr', (a) => ({ accounts: [{ label: 'Main Bank', openingBalancePkr: a }] }), 'accounts'],
];

describe('amount precision: per-value jsonb round-trip is exact', () => {
  for (const [label, v] of PINNED_VALUES) {
    it(`scalar ${label}: ${v} round-trips exactly`, () => {
      const rt = jsonb(v);
      expect(typeof rt).toBe('number');
      expectExact(rt, v, label);
    });
  }

  for (const [field, build, key] of DOC_BUILDERS) {
    it(`${field} survives a whole-document round-trip for the full pinned set`, () => {
      for (const [label, v] of PINNED_VALUES) {
        const doc = build(v);
        const rt = jsonb(doc);
        const got =
          key === 'lines' ? (rt.lines as Array<{ allocatedPkr: number }>)[0].allocatedPkr
          : key === 'beforeSnapshot' ? (rt.beforeSnapshot as { amountPkr: number }).amountPkr
          : key === 'accounts' ? (rt.accounts as Array<{ openingBalancePkr: number }>)[0].openingBalancePkr
          : (rt[key] as number);
        expect(typeof got).toBe('number');
        expectExact(got, v, `${field} / ${label}`);
      }
    });
  }

  it('integer-PKR validation boundary still holds after round-trip (Number.isInteger preserved)', () => {
    for (const [, v] of PINNED_VALUES) {
      expect(Number.isInteger(jsonb(v))).toBe(Number.isInteger(v));
    }
  });
});

/* ---------- 2. Aggregations: firestore-path === jsonb-path === pinned literal ---------- */

const baseEntry = {
  category: 'operations' as const,
  budgetLineId: null as string | null,
  status: 'posted' as const,
  accountLabel: 'Main Bank',
  relatedPartyEntryId: null as string | null,
  receiptDriveId: null as string | null,
  date: '2026-10-05',
};

describe('amount precision: report aggregations do not drift through jsonb', () => {
  it('buildIncomeExpenditure: 0.1 + 0.2 income pins the float artifact 0.30000000000000004, both paths', () => {
    const entries = [
      { ...baseEntry, type: 'income' as const, category: 'donations' as const, amountPkr: 0.1 },
      { ...baseEntry, type: 'income' as const, category: 'donations' as const, amountPkr: 0.2 },
      { ...baseEntry, type: 'expense' as const, amountPkr: 123456789.12 },
      { ...baseEntry, type: 'expense' as const, amountPkr: 0.000001 },
    ];
    const fs = buildIncomeExpenditure(entries);
    const jb = buildIncomeExpenditure(jsonb(entries));
    expectExact(fs.totalIncomePkr, 0.30000000000000004, 'income total literal');
    expectExact(jb.totalIncomePkr, fs.totalIncomePkr, 'income total jsonb-vs-firestore');
    expectExact(fs.totalExpensePkr, 123456789.120001, 'expense total literal');
    expectExact(jb.totalExpensePkr, fs.totalExpensePkr, 'expense total jsonb-vs-firestore');
    expectExact(fs.netPkr, -123456788.820001, 'net literal');
    expectExact(jb.netPkr, fs.netPkr, 'net jsonb-vs-firestore');
    expectExact(jb.byCategory.find((c) => c.category === 'donations')!.incomePkr, 0.30000000000000004, 'category income');
  });

  it('buildIncomeExpenditure: ten 0.1 entries pin 0.9999999999999999 (NOT 1)', () => {
    const entries = Array.from({ length: 10 }, () => ({ ...baseEntry, type: 'income' as const, amountPkr: 0.1 }));
    expectExact(buildIncomeExpenditure(entries).totalIncomePkr, 0.9999999999999999, '10x0.1 firestore');
    expectExact(buildIncomeExpenditure(jsonb(entries)).totalIncomePkr, 0.9999999999999999, '10x0.1 jsonb');
  });

  it('buildVariance: decimal actuals, totals and variancePercent are exact on both paths', () => {
    const budget = {
      fyLabel: 'fy2026-27', fyStart: '2026-07-01', fyEnd: '2027-06-30', status: 'approved' as const,
      revision: 1, totalAllocatedPkr: 300, consentId: null, consentPending: false,
      lines: [
        { lineId: 'l-ops', category: 'operations' as const, label: 'Ops', allocatedPkr: 300 },
        { lineId: 'l-big', category: 'projects' as const, label: 'Big', allocatedPkr: 999999999 },
      ],
    };
    const entries = [
      { ...baseEntry, type: 'expense' as const, amountPkr: 0.1, budgetLineId: 'l-ops' },
      { ...baseEntry, type: 'expense' as const, amountPkr: 0.2, budgetLineId: 'l-ops' },
      { ...baseEntry, type: 'expense' as const, amountPkr: 999999999.99, budgetLineId: 'l-big' },
      { ...baseEntry, type: 'expense' as const, amountPkr: 0.000001, budgetLineId: null },
    ];
    for (const path of ['firestore', 'jsonb'] as const) {
      const v = buildVariance(budget as unknown as Parameters<typeof buildVariance>[0], path === 'jsonb' ? jsonb(entries) : entries);
      const ops = v.lines.find((l) => l.lineId === 'l-ops')!;
      expectExact(ops.actualPkr, 0.30000000000000004, `variance ops actual (${path})`);
      expectExact(ops.variancePkr, 300 - 0.30000000000000004, `variance ops variance (${path})`);
      expectExact(ops.variancePercent!, 99.9, `variance ops percent (${path})`);
      const big = v.lines.find((l) => l.lineId === 'l-big')!;
      expectExact(big.actualPkr, 999999999.99, `variance big actual (${path})`);
      expectExact(v.totalAllocatedPkr, 1000000299, `variance totalAllocated (${path})`);
      expectExact(v.totalActualPkr, 0.30000000000000004 + 999999999.99, `variance totalActual (${path})`);
      expectExact(v.unbudgetedPostedExpensePkr, 0.000001, `variance unbudgeted (${path})`);
    }
  });

  it('buildBalanceSheetSummary: opening 100000.5 with +0.1 -0.2 -1e-7 movements pins exact float results on both paths', () => {
    const accounts = [{ label: 'Main Bank', openingBalancePkr: 100000.5 }];
    const entries = [
      { ...baseEntry, type: 'income' as const, amountPkr: 0.1 },
      { ...baseEntry, type: 'expense' as const, amountPkr: 0.2 },
      { ...baseEntry, type: 'expense' as const, amountPkr: 1e-7, relatedPartyEntryId: 'rp-1' },
    ];
    for (const path of ['firestore', 'jsonb'] as const) {
      const r = buildBalanceSheetSummary(accounts, path === 'jsonb' ? jsonb(entries) : entries, '2026-10-31');
      expectExact(r.accounts[0].netMovementPkr, 0.1 - 0.2 - 1e-7, `balance net (${path})`);
      expectExact(r.accounts[0].fundsHeldPkr, 100000.5 + (0.1 - 0.2 - 1e-7), `balance fundsHeld (${path})`);
      expectExact(r.totalFundsHeldPkr, r.accounts[0].fundsHeldPkr, `balance total (${path})`);
      expectExact(r.relatedPartyUnreceiptedNotePkr, 1e-7, `balance rp note (${path})`);
    }
    // Cross-path identity is the actual contract; the literal above pins the pieces.
    const fs = buildBalanceSheetSummary(accounts, entries, '2026-10-31');
    const jb = buildBalanceSheetSummary(accounts, jsonb(entries), '2026-10-31');
    expectExact(jb.accounts[0].fundsHeldPkr, fs.accounts[0].fundsHeldPkr, 'balance fundsHeld cross-path');
  });

  it('buildOrderIncome: legacy decimal order totals aggregate exactly on both paths', () => {
    const raws = [
      { paymentStatus: 'completed', total: 0.1, originatingModule: 'store' },
      { paymentStatus: 'completed', totalPkr: 0.2, originatingModule: 'store' },
      { paymentStatus: 'completed', amount: 123456789.12, originatingModule: 'Events' },
      { paymentStatus: 'completed', total: 999999999.99, originatingModule: 'Events', currency: 'PKR' },
    ];
    for (const path of ['firestore', 'jsonb'] as const) {
      const orders = (path === 'jsonb' ? jsonb(raws) : raws).map((r, i) => normalizeOrder(r, `o${i}`));
      const rep = buildOrderIncome(orders);
      expectExact(rep.byModule.find((m) => m.module === 'store')!.totalPkr, 0.30000000000000004, `order store total (${path})`);
      expectExact(rep.byModule.find((m) => m.module === 'Events')!.totalPkr, 1123456789.1100001, `order events total (${path})`);
      expectExact(rep.grandTotalPkr, 0.30000000000000004 + 1123456789.1100001, `order grand total (${path})`);
    }
  });
});

describe('amount precision: ledger derivations through the (fake) store', () => {
  function seedEntries(db: FakeFirestore, roundTrip: boolean) {
    const rows: Array<[string, Record<string, unknown>]> = [
      ['a', { fyLabel: 'fy2026-27', status: 'posted', type: 'income', amountPkr: 0.1, budgetLineId: 'l-ops', accountLabel: 'Main Bank', date: '2026-10-03' }],
      ['b', { fyLabel: 'fy2026-27', status: 'posted', type: 'income', amountPkr: 0.2, budgetLineId: 'l-ops', accountLabel: 'Main Bank', date: '2026-10-04' }],
      ['c', { fyLabel: 'fy2026-27', status: 'posted', type: 'expense', amountPkr: 123456789.12, budgetLineId: 'l-ops', accountLabel: 'Main Bank', date: '2026-10-05' }],
      ['d', { fyLabel: 'fy2026-27', status: 'draft', type: 'income', amountPkr: 777, budgetLineId: 'l-ops', accountLabel: 'Main Bank', date: '2026-10-06' }],
    ];
    for (const [id, data] of rows) db.__seed('ledger_entries', id, roundTrip ? jsonb(data) : data);
  }

  it('computeLineActuals: actuals identical for stored vs round-tripped docs', async () => {
    const dbFs = createFakeFirestore() as never as FakeFirestore;
    seedEntries(dbFs, false);
    const dbJb = createFakeFirestore() as never as FakeFirestore;
    seedEntries(dbJb, true);
    const a = await computeLineActuals(dbFs as never, 'fy2026-27');
    const b = await computeLineActuals(dbJb as never, 'fy2026-27');
    expectExact(a.get('l-ops')!.incomePkr, 0.30000000000000004, 'lineActuals income literal');
    expectExact(b.get('l-ops')!.incomePkr, a.get('l-ops')!.incomePkr, 'lineActuals income cross-path');
    expectExact(a.get('l-ops')!.expensePkr, 123456789.12, 'lineActuals expense literal');
    expectExact(b.get('l-ops')!.expensePkr, a.get('l-ops')!.expensePkr, 'lineActuals expense cross-path');
  });

  it('computeAccountBalance: opening + posted movements identical on both paths, period bounds inclusive', async () => {
    const dbFs = createFakeFirestore() as never as FakeFirestore;
    seedEntries(dbFs, false);
    const dbJb = createFakeFirestore() as never as FakeFirestore;
    seedEntries(dbJb, true);
    const balFs = await computeAccountBalance(dbFs as never, 'Main Bank', 100000.5, '2026-10-01', '2026-10-31');
    const balJb = await computeAccountBalance(dbJb as never, 'Main Bank', 100000.5, '2026-10-01', '2026-10-31');
    expectExact(balFs, 100000.5 + 0.1 + 0.2 - 123456789.12, 'accountBalance literal');
    expectExact(balJb, balFs, 'accountBalance cross-path');
  });

  it('reversal-pair netting stays exact: posted expense + equal opposite reversal nets the line to the pinned residue', () => {
    const entries = [
      { ...baseEntry, type: 'expense' as const, amountPkr: 0.30000000000000004, budgetLineId: 'l-x' },
      { ...baseEntry, type: 'income' as const, amountPkr: 0.1, budgetLineId: 'l-x' },
      { ...baseEntry, type: 'income' as const, amountPkr: 0.2, budgetLineId: 'l-x' },
    ];
    const budget = {
      fyLabel: 'fy2026-27', fyStart: '2026-07-01', fyEnd: '2027-06-30', status: 'approved' as const,
      revision: 1, totalAllocatedPkr: 0, consentId: null, consentPending: false,
      lines: [{ lineId: 'l-x', category: 'operations' as const, label: 'X', allocatedPkr: 0 }],
    };
    for (const path of ['firestore', 'jsonb'] as const) {
      const v = buildVariance(budget as unknown as Parameters<typeof buildVariance>[0], path === 'jsonb' ? jsonb(entries) : entries);
      // net = -0.30000000000000004 + 0.1 + 0.2 = -5.551115123125783e-17, NOT 0:
      // today's float residue is pinned so a migrated "helpful rounding" fails loudly.
      expectExact(v.lines[0].actualPkr, 0.30000000000000004 - 0.1 - 0.2, `reversal residue (${path})`);
    }
  });
});
