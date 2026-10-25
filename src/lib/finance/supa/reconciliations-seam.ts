/**
 * MIGRATION SEAM: finance reconciliations
 *
 * Supabase migration — FINANCE cluster FG5 (PLAN_FG45 §2). Surface key:
 * `finance-reconciliations`. Serves the reconciliations routes' reads:
 *
 *   supaListReconciliations <->  listDocs('finance_reconciliations',
 *                                optional periodMonth==, createdAt desc,
 *                                limit 100)                       (R1)
 *   supaReconciliationDoc   <->  getDoc('finance_reconciliations', id)
 *                                under a caller-named surface     (R2/R3/R4)
 * Mirrors (W1 create / W2 edit only; §0.2.6):
 *   mirrorReconciliationSet / mirrorReconciliationUpdate.
 *
 * W3 (complete route) is MANUAL_LIST M-FG5-1 (distinct-UID law): NO
 * generic-adapter write and NO mirror in this phase — the completion
 * stays on its Firestore batch exactly as today.
 *
 * The admin finance client (FG5 §2.3) has ZERO data-path changes: all
 * components go through components/finance-api.ts to these routes; no
 * firebase/firestore/onSnapshot/useCollection imports exist under
 * src/app/admin/finance/. No NEXT_PUBLIC_ twin flag is needed.
 */

import {
  financeSupaPort,
  mirrorFinanceWrite,
  supaDocToFakeDoc,
  type FinanceSupaPort,
} from './_shared';
import { normalizeFinanceTimes } from './_shared';
import type { SupaDoc } from './_shared';

export const FINANCE_RECONCILIATIONS_SURFACE = 'finance-reconciliations';

type FakeDoc = ReturnType<typeof supaDocToFakeDoc>;

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

/** R1: reconciliations list as plain rows (optional month filter). */
export async function supaListReconciliations(
  month: string | null,
): Promise<Array<Record<string, unknown>> | null> {
  return read(FINANCE_RECONCILIATIONS_SURFACE, async (p) =>
    (
      await p.listDocs('finance_reconciliations', {
        where: month ? [['periodMonth', '==', month]] : undefined,
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit: 100,
      })
    ).map((d: SupaDoc) => normalizeFinanceTimes(d as Record<string, unknown>)),
  );
}

/** R2/R3/R4: one reconciliation doc under the caller's surface. */
export async function supaReconciliationDoc(
  surface: string,
  id: string,
): Promise<FakeDoc | null> {
  return read(surface, async (p) =>
    supaDocToFakeDoc(await p.getDoc('finance_reconciliations', id)),
  );
}

/* --------------------------------------------------------------- mirrors */

export async function mirrorReconciliationSet(
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  await mirrorFinanceWrite(FINANCE_RECONCILIATIONS_SURFACE, 'set', 'finance_reconciliations', id, data);
}

export async function mirrorReconciliationUpdate(
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  await mirrorFinanceWrite(
    FINANCE_RECONCILIATIONS_SURFACE,
    'update',
    'finance_reconciliations',
    id,
    data,
  );
}
