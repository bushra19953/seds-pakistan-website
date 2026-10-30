/**
 * MIGRATION SEAM: finance routes-core
 *
 * Supabase migration — FINANCE cluster FG2 (PLAN_FG123 §FG2): budgets,
 * destinations, auditor, reports routes.
 * Surface keys: `finance-budgets`, `finance-destinations`,
 * `finance-auditor`, `finance-reports`.
 *
 * Mapping (route read -> adapter call):
 *   supaListBudgets        <->  listDocs('finance_budgets', createdAt desc)
 *                               or fyLabel== with NO orderBy (the route's
 *                               L45 quirk, preserved exactly)   (FG2 R1)
 *   supaBudgetDoc          <->  getDoc('finance_budgets', id)   (R2/R3/R4, reports R9)
 *   supaBudgetByFyStatus   <->  listDocs('finance_budgets', fyLabel==,
 *                               status==, limit 1)              (reports R10)
 *   supaDestinationDoc     <->  getDoc(docPath[0], docPath[1])   (R5)
 *   supaPendingDestination <->  listDocs('money_approvals', targetType==
 *                               'destination_change', targetId==store,
 *                               status=='pending', limit 1)     (R6)
 *   supaAuditorDoc         <->  getDoc('auditor_appointments', fy) (R7)
 *   supaEntriesByFy        <->  listDocs('ledger_entries', fyLabel==) (R8)
 *   supaPostedEntries      <->  listDocs('ledger_entries', status=='posted') (R11)
 *   supaAllOrders          <->  listDocs('orders') — census C12 full get;
 *                               store owns orders writes (step 12)  (R12)
 * Mirrors (Firestore commit first, §0.2.6; MANUAL_LIST M-FG123-3/-4):
 *   mirrorBudgetSet / mirrorBudgetUpdate / mirrorAuditorSet.
 * Reports audit-before-return (M-FG123-1) is NOT here and never moves:
 * the reports route keeps its Firestore writeFinanceAudit batch before
 * the response, exactly as today.
 *
 * Fallback contract: helpers return null (gate off / unconfigured /
 * error) and the caller runs its Firestore path byte-identically.
 */

import {
  financeSupaPort,
  mirrorFinanceWrite,
  normalizeFinanceTimes,
  supaDocToFakeDoc,
  supaDocsToFakeSnap,
  type FinanceSupaPort,
} from './_shared';

export const FINANCE_BUDGETS_SURFACE = 'finance-budgets';
export const FINANCE_DESTINATIONS_SURFACE = 'finance-destinations';
export const FINANCE_AUDITOR_SURFACE = 'finance-auditor';
export const FINANCE_REPORTS_SURFACE = 'finance-reports';

type FakeDoc = ReturnType<typeof supaDocToFakeDoc>;
type FakeSnap = ReturnType<typeof supaDocsToFakeSnap>;

async function read<T>(
  surface: string,
  fn: (p: FinanceSupaPort) => Promise<T>,
): Promise<T | null> {
  const p = financeSupaPort(surface);
  if (!p) return null;
  try {
    return await fn(p);
  } catch (err) {
    console.error(`[finance-supa] ${surface} read failed; falling back`, err);
    return null;
  }
}

/** FG2 R1. fy present -> fyLabel filter and NO ordering (quirk preserved).
 * READ-BLEED FIX (rbt2): bounded at 100, matching the budgets route's
 * Firestore fallback arm. */
export async function supaListBudgets(fy: string | null): Promise<FakeSnap | null> {
  return read(FINANCE_BUDGETS_SURFACE, async (p) => {
    const docs = fy
      ? await p.listDocs('finance_budgets', { where: [['fyLabel', '==', fy]], limit: 100 })
      : await p.listDocs('finance_budgets', {
          orderBy: { field: 'createdAt', direction: 'desc' },
          limit: 100,
        });
    return supaDocsToFakeSnap(docs);
  });
}

/** FG2 R2/R3/R4 + reports R9: one budget doc, under a caller's surface. */
export async function supaBudgetDoc(surface: string, id: string): Promise<FakeDoc | null> {
  return read(surface, async (p) => supaDocToFakeDoc(await p.getDoc('finance_budgets', id)));
}

/** Reports R10 / variance budget resolution: first budget by fy+status. */
export async function supaBudgetByFyStatus(
  fyLabel: string,
  status: string,
): Promise<FakeSnap | null> {
  return read(FINANCE_REPORTS_SURFACE, async (p) =>
    supaDocsToFakeSnap(
      await p.listDocs('finance_budgets', {
        where: [
          ['fyLabel', '==', fyLabel],
          ['status', '==', status],
        ],
        limit: 1,
      }),
    ),
  );
}

/** FG2 R5: a settings-family / pages destination doc. */
export async function supaDestinationDoc(
  collection: string,
  id: string,
): Promise<FakeDoc | null> {
  return read(FINANCE_DESTINATIONS_SURFACE, async (p) =>
    supaDocToFakeDoc(await p.getDoc(collection, id)),
  );
}

/** FG2 R6: pending destination_change approvals for one store (limit 1). */
export async function supaPendingDestinationApprovals(store: string): Promise<FakeSnap | null> {
  return read(FINANCE_DESTINATIONS_SURFACE, async (p) =>
    supaDocsToFakeSnap(
      await p.listDocs('money_approvals', {
        where: [
          ['targetType', '==', 'destination_change'],
          ['targetId', '==', store],
          ['status', '==', 'pending'],
        ],
        limit: 1,
      }),
    ),
  );
}

/** FG2 R7: one auditor appointment doc ({fyLabel} id). */
export async function supaAuditorDoc(fy: string): Promise<FakeDoc | null> {
  return read(FINANCE_AUDITOR_SURFACE, async (p) =>
    supaDocToFakeDoc(await p.getDoc('auditor_appointments', fy)),
  );
}

/** Reports R8: ledger entries for one FY (unbounded, as today). */
export async function supaEntriesByFy(fyLabel: string): Promise<FakeSnap | null> {
  return read(FINANCE_REPORTS_SURFACE, async (p) =>
    supaDocsToFakeSnap(
      await p.listDocs('ledger_entries', { where: [['fyLabel', '==', fyLabel]] }),
    ),
  );
}

/** Reports R11: all posted ledger entries (balance sheet). */
export async function supaPostedEntries(): Promise<FakeSnap | null> {
  return read(FINANCE_REPORTS_SURFACE, async (p) =>
    supaDocsToFakeSnap(
      await p.listDocs('ledger_entries', { where: [['status', '==', 'posted']] }),
    ),
  );
}

/** Reports R12 (census C12): full orders get for order-income. */
export async function supaAllOrders(): Promise<FakeSnap | null> {
  return read(FINANCE_REPORTS_SURFACE, async (p) =>
    supaDocsToFakeSnap(await p.listDocs('orders')),
  );
}

/* --------------------------------------------------------------- mirrors */

export async function mirrorBudgetSet(id: string, data: Record<string, unknown>): Promise<void> {
  await mirrorFinanceWrite(FINANCE_BUDGETS_SURFACE, 'set', 'finance_budgets', id, data);
}

export async function mirrorBudgetUpdate(
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  await mirrorFinanceWrite(FINANCE_BUDGETS_SURFACE, 'update', 'finance_budgets', id, data);
}

export async function mirrorAuditorSet(
  fyLabel: string,
  data: Record<string, unknown>,
): Promise<void> {
  await mirrorFinanceWrite(FINANCE_AUDITOR_SURFACE, 'set', 'auditor_appointments', fyLabel, data);
}

export { normalizeFinanceTimes };
