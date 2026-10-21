import { INCOME_CATEGORY_CODES, type Budget, type LedgerEntry } from '@/types/finance';
import type { CanonicalOrder } from '@/lib/finance/order-canonical';

/**
 * Pure report aggregations (spec Part C 4.6). No Firestore access: these
 * functions consume API-returned data so they are unit-testable with
 * fixtures. Budget-vs-actual is ALWAYS computed from posted ledger
 * entries here, never read from a stored figure. Drafts never count.
 * A posted entry and its posted reversal net to zero naturally (the
 * reversal is an opposite-type entry of equal amount on the same line).
 */

type EntryLike = Pick<
  LedgerEntry,
  'type' | 'category' | 'amountPkr' | 'budgetLineId' | 'status' | 'accountLabel' | 'relatedPartyEntryId' | 'receiptDriveId' | 'date'
>;

export interface IncomeExpenditureReport {
  byCategory: Array<{ category: string; incomePkr: number; expensePkr: number }>;
  totalIncomePkr: number;
  totalExpensePkr: number;
  netPkr: number;
}

export function buildIncomeExpenditure(entries: EntryLike[]): IncomeExpenditureReport {
  const map = new Map<string, { incomePkr: number; expensePkr: number }>();
  let totalIncomePkr = 0;
  let totalExpensePkr = 0;
  for (const e of entries) {
    if (e.status !== 'posted') continue;
    const row = map.get(e.category) ?? { incomePkr: 0, expensePkr: 0 };
    if (e.type === 'income') {
      row.incomePkr += e.amountPkr;
      totalIncomePkr += e.amountPkr;
    } else {
      row.expensePkr += e.amountPkr;
      totalExpensePkr += e.amountPkr;
    }
    map.set(e.category, row);
  }
  return {
    byCategory: [...map.entries()].map(([category, v]) => ({ category, ...v })),
    totalIncomePkr,
    totalExpensePkr,
    netPkr: totalIncomePkr - totalExpensePkr,
  };
}

export interface VarianceLine {
  lineId: string;
  category: string;
  label: string;
  allocatedPkr: number;
  actualPkr: number;
  variancePkr: number;
  variancePercent: number | null;
}

export interface VarianceReport {
  lines: VarianceLine[];
  totalAllocatedPkr: number;
  totalActualPkr: number;
  /** Posted expenses carrying no budget line (or a line outside this budget). */
  unbudgetedPostedExpensePkr: number;
}

export function buildVariance(budget: Budget, entries: EntryLike[]): VarianceReport {
  const lines: VarianceLine[] = budget.lines.map((line) => {
    const isIncome = INCOME_CATEGORY_CODES.has(line.category);
    // Net movement on the line: a posted reversal is an opposite-type
    // entry of equal amount on the same line, so pairs net to zero.
    let netPkr = 0;
    for (const e of entries) {
      if (e.status !== 'posted' || e.budgetLineId !== line.lineId) continue;
      netPkr += e.type === 'income' ? e.amountPkr : -e.amountPkr;
    }
    const actualPkr = isIncome ? netPkr : -netPkr;
    const variancePkr = line.allocatedPkr - actualPkr;
    return {
      lineId: line.lineId,
      category: line.category,
      label: line.label,
      allocatedPkr: line.allocatedPkr,
      actualPkr,
      variancePkr,
      variancePercent: line.allocatedPkr > 0 ? (variancePkr / line.allocatedPkr) * 100 : null,
    };
  });
  const lineIds = new Set(budget.lines.map((l) => l.lineId));
  let unbudgetedPostedExpensePkr = 0;
  for (const e of entries) {
    if (e.status !== 'posted' || e.type !== 'expense') continue;
    if (!e.budgetLineId || !lineIds.has(e.budgetLineId)) unbudgetedPostedExpensePkr += e.amountPkr;
  }
  return {
    lines,
    totalAllocatedPkr: lines.reduce((s, l) => s + l.allocatedPkr, 0),
    totalActualPkr: lines.reduce((s, l) => s + l.actualPkr, 0),
    unbudgetedPostedExpensePkr,
  };
}

export interface BalanceSheetSummary {
  accounts: Array<{ label: string; openingBalancePkr: number; netMovementPkr: number; fundsHeldPkr: number }>;
  totalFundsHeldPkr: number;
  /** Posted related-party expenses with no receipt on file: a NOTE line, not a liability engine (MVP has no payables ledger). */
  relatedPartyUnreceiptedNotePkr: number;
}

export function buildBalanceSheetSummary(
  accounts: Array<{ label: string; openingBalancePkr: number }>,
  entries: EntryLike[],
  asOf: string,
): BalanceSheetSummary {
  const rows = accounts.map((a) => {
    let netMovementPkr = 0;
    for (const e of entries) {
      if (e.status !== 'posted' || e.accountLabel !== a.label || e.date > asOf) continue;
      netMovementPkr += e.type === 'income' ? e.amountPkr : -e.amountPkr;
    }
    return { label: a.label, openingBalancePkr: a.openingBalancePkr, netMovementPkr, fundsHeldPkr: a.openingBalancePkr + netMovementPkr };
  });
  let relatedPartyUnreceiptedNotePkr = 0;
  for (const e of entries) {
    if (e.status === 'posted' && e.type === 'expense' && e.relatedPartyEntryId && !e.receiptDriveId) {
      relatedPartyUnreceiptedNotePkr += e.amountPkr;
    }
  }
  return {
    accounts: rows,
    totalFundsHeldPkr: rows.reduce((s, r) => s + r.fundsHeldPkr, 0),
    relatedPartyUnreceiptedNotePkr,
  };
}

export interface OrderIncomeReport {
  byModule: Array<{ module: string; totalPkr: number; count: number }>;
  grandTotalPkr: number;
}

export function buildOrderIncome(orders: CanonicalOrder[]): OrderIncomeReport {
  const map = new Map<string, { totalPkr: number; count: number }>();
  let grandTotalPkr = 0;
  for (const o of orders) {
    if (o.isDeleted) continue;
    if (o.currency !== 'PKR') continue; // legacy non-PKR (USD certificate) excluded until priced in PKR
    if (o.paymentStatus !== 'completed') continue;
    const total = o.totalPkr ?? 0;
    const key = o.originatingModule ?? 'store';
    const row = map.get(key) ?? { totalPkr: 0, count: 0 };
    row.totalPkr += total;
    row.count += 1;
    map.set(key, row);
    grandTotalPkr += total;
  }
  return {
    byModule: [...map.entries()].map(([module, v]) => ({ module, ...v })),
    grandTotalPkr,
  };
}
