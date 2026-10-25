/**
 * MIGRATION SEAM: finance lib-core
 *
 * Supabase migration — FINANCE cluster FG1 (PLAN_FG123 §FG1).
 * Surface key: `finance-lib-core`. Seam for the read paths of
 * src/lib/finance/ledger.ts and src/lib/finance/adapters.ts:
 *
 *   supaApprovedBudgetLines  <->  adapter listDocs('finance_budgets',
 *                                 fyLabel==, status=='approved', limit 1)
 *                                 (ledger.ts computeEntryFlags, R1)
 *   supaPostedEntriesByFy    <->  adapter listDocs('ledger_entries',
 *                                 fyLabel==, status=='posted')   (R2)
 *   supaPostedEntriesByAcct  <->  adapter listDocs('ledger_entries',
 *                                 accountLabel==, status=='posted') (R3;
 *                                 the period filter stays IN MEMORY in
 *                                 ledger.ts, exactly as today)
 *   supaFinanceAccounts      <->  adapter getDoc('settings','finance') (R4)
 *   supaConsentDoc           <->  adapter getDoc('consent_requests', id)
 *                                 (adapters.ts getConsentView, R5 — the
 *                                 consent doc itself belongs to the
 *                                 governance family; finance consumes the
 *                                 Firestore-shaped view behind the flag
 *                                 and does NOT port consent)
 *   mirrorFinanceAccounts    <->  adapter setDoc('settings','finance',
 *                                 {accounts, updatedAt}, {merge:true})
 *                                 (setFinanceAccounts W1 — MANUAL_LIST
 *                                 M-FG123-2: Firestore batch stays the
 *                                 write path; this is its §0.2.6 mirror)
 *
 * Fallback contract: every read helper returns null when the surface is
 * OFF / unconfigured / errored, and the caller runs its Firestore path
 * byte-identically. The one cross-cluster WRITE in FG1 (adapters.ts
 * compliance_obligations set, W2) is NOT migrated here — governance owns
 * it (merge step 15; MANUAL_LIST §4).
 *
 * Timestamp note: rows pass through normalizeFinanceTimes (ISO strings);
 * adapters.ts's timestampToIsoDate already handles ISO strings via its
 * string branch (the FG1.5 named conversion point: an ISO string yields
 * the same YYYY-MM-DD slice as the Timestamp form for UTC-stored values).
 */

import {
  financeSupaPort,
  mirrorFinanceWrite,
  normalizeFinanceTimes,
  type FinanceSupaPort,
} from './_shared';

export const FINANCE_LIB_CORE_SURFACE = 'finance-lib-core';

function port(): FinanceSupaPort | null {
  return financeSupaPort(FINANCE_LIB_CORE_SURFACE);
}

/** R1: lines[] of the APPROVED budget for an FY, or null to fall back. */
export async function supaApprovedBudgetLines(
  fyLabel: string,
): Promise<Array<{ lineId: string }> | null> {
  const p = port();
  if (!p) return null;
  try {
    const docs = await p.listDocs('finance_budgets', {
      where: [
        ['fyLabel', '==', fyLabel],
        ['status', '==', 'approved'],
      ],
      limit: 1,
    });
    if (docs.length === 0) return [];
    const lines = (docs[0] as { lines?: unknown }).lines;
    return Array.isArray(lines) ? (lines as Array<{ lineId: string }>) : [];
  } catch (err) {
    console.error('[finance-supa] finance-lib-core R1 failed; falling back', err);
    return null;
  }
}

/** R2: posted ledger entries for one FY (raw rows), or null to fall back. */
export async function supaPostedEntriesByFy(
  fyLabel: string,
): Promise<Array<Record<string, unknown>> | null> {
  const p = port();
  if (!p) return null;
  try {
    const docs = await p.listDocs('ledger_entries', {
      where: [
        ['fyLabel', '==', fyLabel],
        ['status', '==', 'posted'],
      ],
    });
    return docs.map((d) => normalizeFinanceTimes(d as Record<string, unknown>));
  } catch (err) {
    console.error('[finance-supa] finance-lib-core R2 failed; falling back', err);
    return null;
  }
}

/** R3: posted ledger entries for one account, or null to fall back. */
export async function supaPostedEntriesByAccount(
  accountLabel: string,
): Promise<Array<Record<string, unknown>> | null> {
  const p = port();
  if (!p) return null;
  try {
    const docs = await p.listDocs('ledger_entries', {
      where: [
        ['accountLabel', '==', accountLabel],
        ['status', '==', 'posted'],
      ],
    });
    return docs.map((d) => normalizeFinanceTimes(d as Record<string, unknown>));
  } catch (err) {
    console.error('[finance-supa] finance-lib-core R3 failed; falling back', err);
    return null;
  }
}

/** R4: the settings/finance accounts array, or null to fall back. */
export async function supaFinanceAccounts(): Promise<Array<Record<string, unknown>> | null> {
  const p = port();
  if (!p) return null;
  try {
    const doc = await p.getDoc('settings', 'finance');
    if (!doc) return [];
    const accounts = (doc as { accounts?: unknown }).accounts;
    return Array.isArray(accounts) ? (accounts as Array<Record<string, unknown>>) : [];
  } catch (err) {
    console.error('[finance-supa] finance-lib-core R4 failed; falling back', err);
    return null;
  }
}

/**
 * R5: one consent_requests doc as a fake Firestore doc snapshot
 * ({ exists, data() }), or null to fall back. Governance-owned data;
 * finance consumes the view only (brief rule).
 */
export async function supaConsentDoc(
  consentId: string,
): Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined } | null> {
  const p = port();
  if (!p) return null;
  try {
    const doc = await p.getDoc('consent_requests', consentId);
    if (!doc) return { exists: false, data: () => undefined };
    const { id: _id, ...rest } = normalizeFinanceTimes(doc as Record<string, unknown>);
    const data = rest as Record<string, unknown>;
    return { exists: true, data: () => data };
  } catch (err) {
    console.error('[finance-supa] finance-lib-core R5 failed; falling back', err);
    return null;
  }
}

/** W1 mirror (M-FG123-2): settings/finance accounts write, post-commit. */
export async function mirrorFinanceAccounts(accounts: unknown): Promise<void> {
  await mirrorFinanceWrite(
    FINANCE_LIB_CORE_SURFACE,
    'set',
    'settings',
    'finance',
    { accounts, updatedAt: new Date().toISOString() },
    { merge: true },
  );
}
