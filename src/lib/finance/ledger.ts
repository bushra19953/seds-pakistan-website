import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { EXPENDITURE_THRESHOLD_PKR, type FinanceAccount, type LedgerEntry } from '@/types/finance';
import { writeFinanceAudit } from '@/lib/server/finance-audit';
// MIGRATION SEAM: finance finance-lib-core
import {
  mirrorFinanceAccounts,
  supaApprovedBudgetLines,
  supaFinanceAccounts,
  supaPostedEntriesByAccount,
  supaPostedEntriesByFy,
} from '@/lib/finance/supa/lib-core-seam';
// CUTOVER: finance write-primary (SUPA_PRIMARY=finance) — see
// src/lib/finance/supa/primary.ts.
import { callFinanceTx, financePayloadHash, financePrimaryEnabled } from '@/lib/finance/supa/primary';

/**
 * Server-only ledger helpers (spec Part C 3.2). Posting itself happens
 * ONLY through the money-approvals flow (money-approval.ts); this module
 * owns derivation (FY, hooks H1/H2) and computed figures (actuals,
 * balances), which are never stored as editable numbers.
 */

/** FY runs 1 July to 30 June; the label names the FY by its start year. */
export function deriveFyLabel(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1; // 1-12
  const startYear = month >= 7 ? year : year - 1;
  return `fy${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export interface EntryFlags {
  fyLabel: string;
  unbudgeted: boolean;
  overThreshold: boolean;
}

/**
 * Hooks H1/H2 (spec 1.2), computed at draft creation and again at posting:
 *  H1 unbudgeted: an expense with no budgetLineId, or whose budgetLineId is
 *     not in the APPROVED budget for its FY.
 *  H2 over threshold: a single expense above PKR 250,000.
 * Both require a decided Founder Consent (consentId) before posting.
 */
export async function computeEntryFlags(
  db: Firestore,
  entry: { date: string; type: string; amountPkr: number; budgetLineId: string | null },
): Promise<EntryFlags> {
  const fyLabel = deriveFyLabel(entry.date);
  const overThreshold = entry.type === 'expense' && entry.amountPkr > EXPENDITURE_THRESHOLD_PKR;
  let unbudgeted = false;
  if (entry.type === 'expense') {
    if (!entry.budgetLineId) {
      unbudgeted = true;
    } else {
      // MIGRATION SEAM: finance finance-lib-core (R1)
      const supaLines = await supaApprovedBudgetLines(fyLabel);
      if (supaLines !== null) {
        unbudgeted = !supaLines.some((l) => l.lineId === entry.budgetLineId);
      } else {
        const snap = await db
          .collection('finance_budgets')
          .where('fyLabel', '==', fyLabel)
          .where('status', '==', 'approved')
          .limit(1)
          .get();
        const budget = snap.empty ? null : (snap.docs[0].data() as { lines?: Array<{ lineId: string }> });
        unbudgeted = !budget || !(budget.lines ?? []).some((l) => l.lineId === entry.budgetLineId);
      }
    }
  }
  return { fyLabel, unbudgeted, overThreshold };
}

/** Posted actuals per budget line for one FY (drafts never count). */
export async function computeLineActuals(
  db: Firestore,
  fyLabel: string,
): Promise<Map<string, { incomePkr: number; expensePkr: number }>> {
  // MIGRATION SEAM: finance finance-lib-core (R2)
  const supaRows = await supaPostedEntriesByFy(fyLabel);
  const rows: Array<Record<string, unknown>> | null =
    supaRows ??
    (await (async () => {
      const snap = await db
        .collection('ledger_entries')
        .where('fyLabel', '==', fyLabel)
        .where('status', '==', 'posted')
        .get();
      return snap.docs.map((d) => d.data() as Record<string, unknown>);
    })());
  const out = new Map<string, { incomePkr: number; expensePkr: number }>();
  for (const docRow of rows) {
    const e = docRow as unknown as LedgerEntry;
    if (!e.budgetLineId) continue;
    const row = out.get(e.budgetLineId) ?? { incomePkr: 0, expensePkr: 0 };
    if (e.type === 'income') row.incomePkr += e.amountPkr;
    else row.expensePkr += e.amountPkr;
    out.set(e.budgetLineId, row);
  }
  return out;
}

/** Opening + posted income - posted expense for one account inside a period. */
export async function computeAccountBalance(
  db: Firestore,
  accountLabel: string,
  openingBalancePkr: number,
  periodStart: string,
  periodEnd: string,
): Promise<number> {
  // MIGRATION SEAM: finance finance-lib-core (R3; period filter stays in memory)
  const supaRows = await supaPostedEntriesByAccount(accountLabel);
  const rows: Array<Record<string, unknown>> =
    supaRows ??
    (await (async () => {
      const snap = await db
        .collection('ledger_entries')
        .where('accountLabel', '==', accountLabel)
        .where('status', '==', 'posted')
        .get();
      return snap.docs.map((d) => d.data() as Record<string, unknown>);
    })());
  let balance = openingBalancePkr;
  for (const docRow of rows) {
    const e = docRow as unknown as LedgerEntry;
    if (e.date < periodStart || e.date > periodEnd) continue;
    balance += e.type === 'income' ? e.amountPkr : -e.amountPkr;
  }
  return balance;
}

export async function getFinanceAccounts(db: Firestore): Promise<FinanceAccount[]> {
  // MIGRATION SEAM: finance finance-lib-core (R4)
  const supaAccounts = await supaFinanceAccounts();
  if (supaAccounts !== null) return supaAccounts as unknown as FinanceAccount[];
  const snap = await db.collection('settings').doc('finance').get();
  if (!snap.exists) return [];
  const accounts = (snap.data() as { accounts?: FinanceAccount[] }).accounts;
  return Array.isArray(accounts) ? accounts : [];
}

/** Accounts list lives on settings/finance; labels only, never payment destinations (not CH-10). */
export async function setFinanceAccounts(
  db: Firestore,
  accounts: FinanceAccount[],
  actorUid: string,
): Promise<void> {
  // CUTOVER (F6): write-primary — the function upserts settings/finance
  // (merge semantics, as below) and writes FINANCE_ACCOUNTS_UPDATED in
  // one tx. No Firestore batch, no post-commit mirror on this path.
  if (financePrimaryEnabled()) {
    const res = await callFinanceTx(
      'finance_set_accounts',
      'tx_finance_set_accounts',
      { p_caller_uid: actorUid, p_accounts: accounts as unknown as Record<string, unknown>[] },
      `set_accounts:${actorUid}:${financePayloadHash(accounts)}`,
    );
    if (res && res.ok === false) {
      throw new Error(res.message ?? 'Finance accounts update failed');
    }
    return;
  }
  const batch = db.batch();
  batch.set(
    db.collection('settings').doc('finance'),
    { accounts, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  await writeFinanceAudit(db, batch, {
    action: 'FINANCE_ACCOUNTS_UPDATED',
    actorUid,
    targetUidOrResource: 'settings/finance',
    payload: { accounts },
  });
  await batch.commit();
  // MIGRATION SEAM: finance finance-lib-core (W1 mirror, MANUAL_LIST M-FG123-2)
  await mirrorFinanceAccounts(accounts);
}
