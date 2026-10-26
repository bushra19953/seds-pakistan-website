import { NextRequest, NextResponse } from 'next/server';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import type { Budget, LedgerEntry } from '@/types/finance';
import { writeFinanceAudit } from '@/lib/server/finance-audit';
import { normalizeOrder } from '@/lib/finance/order-canonical';
import {
  buildBalanceSheetSummary,
  buildIncomeExpenditure,
  buildOrderIncome,
  buildVariance,
} from '@/lib/finance/reports';
import { getFinanceAccounts } from '@/lib/finance/ledger';
import { deriveFyLabel } from '@/lib/finance/ledger';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';
// MIGRATION SEAM: finance finance-reports
import {
  FINANCE_REPORTS_SURFACE,
  supaAllOrders,
  supaBudgetByFyStatus,
  supaBudgetDoc,
  supaEntriesByFy,
  supaPostedEntries,
} from '@/lib/finance/supa/routes-core-seam';
// CUTOVER: finance write-primary (SUPA_PRIMARY=finance) — see
// src/lib/finance/supa/primary.ts.
import { randomUUID } from 'crypto';
import { callFinanceTx, financePrimaryEnabled } from '@/lib/finance/supa/primary';

/**
 * Reporting API (spec Part C 4.6). GET only - a report writes nothing
 * except its own FINANCE_REPORT_GENERATED audit row, which is written
 * BEFORE the payload is returned so an export can never leave the
 * building unlogged. Aggregations are computed from posted ledger
 * entries via the pure functions in src/lib/finance/reports.ts.
 */
export async function GET(request: NextRequest) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  try {
    const can =
      (await hasServerPermissionForUser(caller.db, caller.uid, 'canManageFinance')) ||
      (await hasServerPermissionForUser(caller.db, caller.uid, 'canApproveMoney')) ||
      (await hasServerPermissionForUser(caller.db, caller.uid, 'canViewAuditLogs'));
    if (!can) return httpError(403, 'Forbidden');

    const url = new URL(request.url);
    const type = url.searchParams.get('type');
    const fy = url.searchParams.get('fy');
    const asOf = url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
    if (!type) return httpError(400, 'type is required');

    const loadEntries = async (fyLabel: string): Promise<LedgerEntry[]> => {
      // MIGRATION SEAM: finance finance-reports (R8)
      const supaSnap = await supaEntriesByFy(fyLabel);
      const snap = supaSnap ?? (await caller.db.collection('ledger_entries').where('fyLabel', '==', fyLabel).get());
      return snap.docs.map((d) => d.data() as LedgerEntry);
    };

    let report: unknown;
    let fyLabel = fy ?? deriveFyLabel(asOf);

    switch (type) {
      case 'income-expenditure': {
        if (!fy) return httpError(400, 'fy is required for income-expenditure');
        report = buildIncomeExpenditure(await loadEntries(fy));
        break;
      }
      case 'variance': {
        if (!fy) return httpError(400, 'fy is required for variance');
        const budgetId = url.searchParams.get('budgetId');
        let budget: (Budget & { id: string }) | null = null;
        if (budgetId) {
          // MIGRATION SEAM: finance finance-reports (R9)
          const snap =
            (await supaBudgetDoc(FINANCE_REPORTS_SURFACE, budgetId)) ??
            (await caller.db.collection('finance_budgets').doc(budgetId).get());
          if (!snap.exists) return httpError(404, 'Budget not found');
          budget = { id: snap.id, ...(snap.data() as Budget) };
        } else {
          // MIGRATION SEAM: finance finance-reports (R10)
          const snap =
            (await supaBudgetByFyStatus(fy, 'approved')) ??
            (await caller.db
              .collection('finance_budgets')
              .where('fyLabel', '==', fy)
              .where('status', '==', 'approved')
              .limit(1)
              .get());
          if (snap.empty) return httpError(404, 'No approved budget for this FY');
          budget = { id: snap.docs[0].id, ...(snap.docs[0].data() as Budget) };
        }
        report = {
          variance: buildVariance(budget, await loadEntries(fy)),
          budgetId: budget.id,
          budgetStatus: budget.status,
          consentPending: budget.status === 'approved' ? budget.consentPending === true : false,
          budgetFyLabel: budget.fyLabel,
        };
        fyLabel = budget.fyLabel;
        break;
      }
      case 'balance-sheet': {
        const accounts = await getFinanceAccounts(caller.db);
        // MIGRATION SEAM: finance finance-reports (R11)
        const snap =
          (await supaPostedEntries()) ??
          (await caller.db.collection('ledger_entries').where('status', '==', 'posted').get());
        const entries = snap.docs.map((d) => d.data() as LedgerEntry);
        report = buildBalanceSheetSummary(
          accounts.map((a) => ({ label: a.label, openingBalancePkr: a.openingBalancePkr ?? 0 })),
          entries,
          asOf,
        );
        fyLabel = fy ?? deriveFyLabel(asOf);
        break;
      }
      case 'order-income': {
        // MIGRATION SEAM: finance finance-reports (R12, census C12; orders owned by store cluster)
        const snap = (await supaAllOrders()) ?? (await caller.db.collection('orders').get());
        const orders = snap.docs.map((d) => normalizeOrder(d.data() as Record<string, unknown>, d.id));
        report = buildOrderIncome(orders);
        fyLabel = fy ?? 'all';
        break;
      }
      default:
        return httpError(400, `Unknown report type: ${type}`);
    }

    // CUTOVER (F7): write-primary — the function inserts ONLY the
    // FINANCE_REPORT_GENERATED audit row and returns before the report
    // is served, preserving audit-before-return and fail-closed (an rpc
    // failure returns 500 and no report). The idempotency key is unique
    // per request BY DESIGN here: a report generation's logical
    // operation is the request itself, and today every generation
    // writes its own audit row — a deterministic key would suppress
    // legitimate repeat exports.
    if (financePrimaryEnabled()) {
      const res = await callFinanceTx(
        'finance_report_audit',
        'tx_finance_report_audit',
        {
          p_caller_uid: caller.uid,
          p_report_type: type,
          p_payload: { type, fy: fyLabel, asOf },
          p_audit_action: 'FINANCE_REPORT_GENERATED',
        },
        `report_audit:${caller.uid}:${type}:${fyLabel}:${asOf}:${randomUUID()}`,
      );
      if (!res || res.ok !== true) return httpError(res?.httpStatus ?? 500, res?.message ?? 'Internal error');
      return NextResponse.json({ type, fy: fyLabel, asOf, report });
    }

    // The audit write happens FIRST; if it fails the report is not returned.
    const batch = caller.db.batch();
    await writeFinanceAudit(caller.db, batch, {
      action: 'FINANCE_REPORT_GENERATED',
      actorUid: caller.uid,
      targetUidOrResource: `reports/${type}`,
      payload: { type, fy: fyLabel, asOf },
    });
    await batch.commit();

    return NextResponse.json({ type, fy: fyLabel, asOf, report });
  } catch (err) {
    return financeErrorResponse(err);
  }
}
