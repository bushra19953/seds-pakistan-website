/**
 * @jest-environment node
 */
// Report aggregation tests (spec Part C section 7, cases 24-25).
// Case 25 (every generation writes FINANCE_REPORT_GENERATED BEFORE
// returning) is exercised at the route level by the reports route's
// audit-first implementation; here case 24 covers the pure variance
// aggregation the route serves.
import { buildIncomeExpenditure, buildVariance, buildBalanceSheetSummary, buildOrderIncome } from '../reports';
import { normalizeOrder } from '../order-canonical';

const baseEntry = {
  category: 'operations',
  budgetLineId: null as string | null,
  status: 'posted' as const,
  accountLabel: 'Main Bank',
  relatedPartyEntryId: null as string | null,
  receiptDriveId: null as string | null,
  date: '2026-10-05',
};

describe('reports (case 24 + aggregations)', () => {
  it('case 24: variance_report_shows_actuals_from_posted_entries_only', () => {
    const budget = {
      fyLabel: 'fy2026-27',
      fyStart: '2026-07-01',
      fyEnd: '2027-06-30',
      status: 'approved' as const,
      revision: 1,
      totalAllocatedPkr: 150000,
      consentId: null,
      consentPending: false,
      lines: [
        { lineId: 'l-sponsor', category: 'sponsorships' as const, label: 'Sponsorships', allocatedPkr: 100000 },
        { lineId: 'l-ops', category: 'operations' as const, label: 'Operations', allocatedPkr: 50000 },
      ],
    };
    const entries = [
      { ...baseEntry, type: 'income' as const, category: 'sponsorships', amountPkr: 120000, budgetLineId: 'l-sponsor' },
      { ...baseEntry, type: 'expense' as const, amountPkr: 30000, budgetLineId: 'l-ops' },
      { ...baseEntry, type: 'expense' as const, amountPkr: 999, budgetLineId: 'l-ops', status: 'draft' as const }, // excluded
      { ...baseEntry, type: 'expense' as const, amountPkr: 7000, budgetLineId: null }, // unbudgeted
      // reversal pair on the ops line nets to zero
      { ...baseEntry, type: 'expense' as const, amountPkr: 5000, budgetLineId: 'l-ops' },
      { ...baseEntry, type: 'income' as const, amountPkr: 5000, budgetLineId: 'l-ops' },
    ];
    const v = buildVariance(budget, entries);
    const sponsor = v.lines.find((l) => l.lineId === 'l-sponsor')!;
    const ops = v.lines.find((l) => l.lineId === 'l-ops')!;
    expect(sponsor.actualPkr).toBe(120000);
    expect(sponsor.variancePkr).toBe(-20000);
    expect(ops.actualPkr).toBe(30000);
    expect(ops.variancePkr).toBe(20000);
    expect(v.unbudgetedPostedExpensePkr).toBe(7000);
  });

  it('income-expenditure totals posted only', () => {
    const r = buildIncomeExpenditure([
      { ...baseEntry, type: 'income', category: 'donations', amountPkr: 1000 },
      { ...baseEntry, type: 'expense', category: 'operations', amountPkr: 400 },
      { ...baseEntry, type: 'income', category: 'donations', amountPkr: 500, status: 'draft' },
    ]);
    expect(r.totalIncomePkr).toBe(1000);
    expect(r.totalExpensePkr).toBe(400);
    expect(r.netPkr).toBe(600);
  });

  it('balance sheet summary nets movements per account and notes unreceipted related-party spend', () => {
    const r = buildBalanceSheetSummary(
      [{ label: 'Main Bank', openingBalancePkr: 1000 }],
      [
        { ...baseEntry, type: 'income', amountPkr: 500 },
        { ...baseEntry, type: 'expense', amountPkr: 200, relatedPartyEntryId: 'rp-1', receiptDriveId: null },
        { ...baseEntry, type: 'expense', amountPkr: 100, relatedPartyEntryId: 'rp-1', receiptDriveId: 'drv' },
      ],
      '2026-10-31',
    );
    expect(r.accounts[0].fundsHeldPkr).toBe(1200);
    expect(r.relatedPartyUnreceiptedNotePkr).toBe(200);
  });

  it('order income uses canonical reader: skips deleted, non-PKR, and unpaid orders', () => {
    const orders = [
      normalizeOrder({ paymentStatus: 'completed', totalPkr: 1000, originatingModule: 'Events' }, 'a'),
      normalizeOrder({ paymentStatus: 'completed', total: 500, originatingModule: 'store' }, 'b'),
      normalizeOrder({ paymentStatus: 'pending', total: 700 }, 'c'),
      normalizeOrder({ paymentStatus: 'completed', total: 300, isDeleted: true }, 'd'),
      normalizeOrder({ paymentStatus: 'completed', total: 900, currency: 'USD' }, 'e'),
    ];
    const r = buildOrderIncome(orders);
    expect(r.grandTotalPkr).toBe(1500);
  });
});
