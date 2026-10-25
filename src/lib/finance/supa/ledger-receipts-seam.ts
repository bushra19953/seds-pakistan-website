/**
 * MIGRATION SEAM: finance ledger-receipts
 *
 * Supabase migration — FINANCE cluster FG3 (PLAN_FG123 §FG3): ledger,
 * ledger/reverse, receipts, receipts/deliver routes.
 * Surface keys: `finance-ledger`, `finance-receipts`.
 *
 * Mapping (read -> adapter call):
 *   supaListLedgerEntries  <->  listDocs('ledger_entries', wheres from the
 *                               route's query params, createdAt desc,
 *                               limit 200)                       (FG3 R1)
 *   supaRelatedPartyDoc    <->  getDoc('sponsors_partners', id) — CRM-owned
 *                               read (step 7); finance consumes only (R2)
 *   supaLedgerEntryDoc     <->  getDoc('ledger_entries', id) under a
 *                               caller-named surface             (R4/R5)
 *   supaListReceipts       <->  listDocs('finance_receipts', optional
 *                               kind==, createdAt desc, limit 200) (R6)
 *   supaReceiptDoc         <->  getDoc('finance_receipts', id)    (R7)
 * Mirrors (MANUAL_LIST M-FG123-5 uniform pattern; Firestore batch first):
 *   mirrorLedgerSet / mirrorLedgerUpdate / mirrorLedgerDelete /
 *   mirrorReceiptSet / mirrorReceiptUpdate.
 *
 * HIGHEST-CARE (FG3.5): receipts rows pass normalizeFinanceTimes, so
 * slaDueAt reaches receipts/route.ts's toReadModel as an ISO string —
 * which the migrated toReadModel parses directly. Without this the SLA
 * bucketing computed (slaDueAt as {seconds}).seconds -> NaN silently
 * (pinned by supa-timestamp-target.test.ts, activated in this build).
 *
 * Ledger list rows are returned as PLAIN objects ({id, ...data}, times
 * normalized) because the ledger GET maps docs itself; the receipts list
 * returns the same plain shape and receipts/route.ts feeds each row to
 * its read model. Related-party / single-doc reads return fake doc
 * snapshots ({exists, data()}) matching the call sites' Firestore use.
 */

import {
  financeSupaPort,
  mirrorFinanceWrite,
  normalizeFinanceTimes,
  supaDocToFakeDoc,
  type FinanceSupaPort,
  type SupaDoc,
} from './_shared';
import type { WhereClause } from '@/lib/supa';

export const FINANCE_LEDGER_SURFACE = 'finance-ledger';
export const FINANCE_RECEIPTS_SURFACE = 'finance-receipts';

type FakeDoc = ReturnType<typeof supaDocToFakeDoc>;

async function tryPort<T>(
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

function plain(d: SupaDoc): Record<string, unknown> {
  return normalizeFinanceTimes(d as Record<string, unknown>);
}

/** FG3 R1: ledger list with the route's optional filters, desc, limit 200. */
export async function supaListLedgerEntries(
  where: WhereClause[],
): Promise<Array<Record<string, unknown>> | null> {
  return tryPort(FINANCE_LEDGER_SURFACE, async (p) =>
    (
      await p.listDocs('ledger_entries', {
        where,
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit: 200,
      })
    ).map(plain),
  );
}

/** FG3 R2: related-party gate input doc (sponsors_partners, CRM-owned). */
export async function supaRelatedPartyDoc(id: string): Promise<FakeDoc | null> {
  return tryPort(FINANCE_LEDGER_SURFACE, async (p) =>
    supaDocToFakeDoc(await p.getDoc('sponsors_partners', id)),
  );
}

/** FG3 R4/R5: one ledger entry doc under the caller's surface. */
export async function supaLedgerEntryDoc(surface: string, id: string): Promise<FakeDoc | null> {
  return tryPort(surface, async (p) => supaDocToFakeDoc(await p.getDoc('ledger_entries', id)));
}

/** FG3 R6: receipts list (optional kind filter), desc, limit 200. */
export async function supaListReceipts(
  kind: string | null,
): Promise<Array<Record<string, unknown>> | null> {
  return tryPort(FINANCE_RECEIPTS_SURFACE, async (p) =>
    (
      await p.listDocs('finance_receipts', {
        where: kind ? [['kind', '==', kind] as WhereClause] : undefined,
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit: 200,
      })
    ).map(plain),
  );
}

/** FG3 R7: one receipt doc. */
export async function supaReceiptDoc(id: string): Promise<FakeDoc | null> {
  return tryPort(FINANCE_RECEIPTS_SURFACE, async (p) =>
    supaDocToFakeDoc(await p.getDoc('finance_receipts', id)),
  );
}

/* --------------------------------------------------------------- mirrors */

export async function mirrorLedgerSet(id: string, data: Record<string, unknown>): Promise<void> {
  await mirrorFinanceWrite(FINANCE_LEDGER_SURFACE, 'set', 'ledger_entries', id, data);
}

export async function mirrorLedgerUpdate(
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  await mirrorFinanceWrite(FINANCE_LEDGER_SURFACE, 'update', 'ledger_entries', id, data);
}

export async function mirrorLedgerDelete(id: string): Promise<void> {
  await mirrorFinanceWrite(FINANCE_LEDGER_SURFACE, 'delete', 'ledger_entries', id);
}

export async function mirrorReceiptSet(id: string, data: Record<string, unknown>): Promise<void> {
  await mirrorFinanceWrite(FINANCE_RECEIPTS_SURFACE, 'set', 'finance_receipts', id, data);
}

export async function mirrorReceiptUpdate(
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  await mirrorFinanceWrite(FINANCE_RECEIPTS_SURFACE, 'update', 'finance_receipts', id, data);
}
