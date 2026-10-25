/**
 * MIGRATION SEAM: finance money-approvals
 *
 * Supabase migration — FINANCE cluster FG4 (PLAN_FG45 §1). Surface key:
 * `finance-approvals`. This seam serves ONLY the read sites of
 * src/lib/finance/money-approval.ts and the approvals routes:
 *
 *   supaApprovalTargetDoc   <->  getDoc(<target collection>, targetId),
 *                                with targetRef's special cases resolved
 *                                by the CALLER into (collection, id):
 *                                settings/payment_methods, pages/donate,
 *                                or MONEY_APPROVAL_TARGET_COLLECTIONS[t]
 *                                (money-approval.ts R1/R2/R5/R6)
 *   supaPendingApproval     <->  listDocs('money_approvals', targetType==,
 *                                targetId==, status=='pending', limit 1)
 *                                (R3, create-time duplicate check)
 *   supaApprovalDoc         <->  getDoc('money_approvals', id)  (R4)
 *   supaListApprovals       <->  listDocs('money_approvals', createdAt
 *                                desc, limit 100)                (R7)
 *
 * WRITES: ALL MANUAL_LIST (M-FG4-1 decide transaction, M-FG4-2 create
 * batch, M-FG4-3 expire update). Per PLAN_FG45 §1.4 this seam provides
 * NO write or mirror functions in this phase — a mirror of a
 * money_approvals row written outside the decide transaction's
 * semantics would invite divergence the cluster cannot reconcile.
 * decideMoneyApproval, createMoneyApprovalRequest and expireIfNeeded
 * stay on Firestore exactly as today; only their pre-reads and the
 * queue list read may be served from Supabase behind the flag.
 *
 * Hidden reads inside applyChange (decide transaction) are NOT served
 * by this seam — they stay on the non-transactional Firestore handle
 * inside the transaction, exactly as today; the full per-targetType
 * inventory is in residual-sections/finance.md.
 *
 * Timestamp care (FG4 §1.5): decidedAtSort / decidedAt / createdAt /
 * expiresAt are normalized to ISO strings; money-approval.ts's toMillis
 * (patched in this build) parses ISO strings so expireIfNeeded behaves
 * identically on seam-shaped rows (pinned by the activated
 * supa-timestamp-target.test.ts).
 */

import {
  financeSupaPort,
  normalizeFinanceTimes,
  supaDocToFakeDoc,
  supaDocsToFakeSnap,
  type FinanceSupaPort,
} from './_shared';

export const FINANCE_APPROVALS_SURFACE = 'finance-approvals';

type FakeDoc = ReturnType<typeof supaDocToFakeDoc>;
type FakeSnap = ReturnType<typeof supaDocsToFakeSnap>;

async function read<T>(fn: (p: FinanceSupaPort) => Promise<T>): Promise<T | null> {
  const p = financeSupaPort(FINANCE_APPROVALS_SURFACE);
  if (!p) return null;
  try {
    return await fn(p);
  } catch (err) {
    console.error('[finance-supa] finance-approvals read failed; falling back', err);
    return null;
  }
}

/** R1/R2/R5/R6: an approval TARGET doc (collection resolved by caller). */
export async function supaApprovalTargetDoc(
  collection: string,
  id: string,
): Promise<FakeDoc | null> {
  return read(async (p) => supaDocToFakeDoc(await p.getDoc(collection, id)));
}

/** R3: pending approvals for one (targetType, targetId), limit 1. */
export async function supaPendingApproval(
  targetType: string,
  targetId: string,
): Promise<FakeSnap | null> {
  return read(async (p) =>
    supaDocsToFakeSnap(
      await p.listDocs('money_approvals', {
        where: [
          ['targetType', '==', targetType],
          ['targetId', '==', targetId],
          ['status', '==', 'pending'],
        ],
        limit: 1,
      }),
    ),
  );
}

/** R4: one money_approvals doc (decide load). */
export async function supaApprovalDoc(id: string): Promise<FakeDoc | null> {
  return read(async (p) => supaDocToFakeDoc(await p.getDoc('money_approvals', id)));
}

/** R7: approvals queue list (createdAt desc, limit 100) as plain rows. */
export async function supaListApprovals(): Promise<Array<Record<string, unknown>> | null> {
  return read(async (p) =>
    (
      await p.listDocs('money_approvals', {
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit: 100,
      })
    ).map((d) => normalizeFinanceTimes(d as Record<string, unknown>)),
  );
}
