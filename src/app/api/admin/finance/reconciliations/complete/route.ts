import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import type { Reconciliation } from '@/types/finance';
import { writeFinanceAudit } from '@/lib/server/finance-audit';
import { computeAccountBalance } from '@/lib/finance/ledger';
import { stampComplianceObligation } from '@/lib/finance/adapters';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';

/**
 * Reconciliation completion (spec Part C 3.3 + 4.3). This route IS the
 * checker step: the caller completes a reconciliation prepared by someone
 * else (checkedBy != reconciledBy, 422). The ledger balance is RECOMPUTED
 * from posted entries; a client-supplied value that differs is rejected
 * (422). A statement reference must already be on the record; a nonzero
 * difference needs an explanation of at least 10 characters on the
 * record. Completing a completed record is a 409 (idempotent-safe).
 *
 * ADAPTER (Phase 2, obligations): after completion, the compliance
 * obligation instance linked on the record is stamped completed with this
 * document as evidence - best-effort, never failing the completion.
 */
export async function POST(request: NextRequest) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  try {
    const can =
      (await hasServerPermissionForUser(caller.db, caller.uid, 'canManageFinance')) ||
      (await hasServerPermissionForUser(caller.db, caller.uid, 'canApproveMoney'));
    if (!can) return httpError(403, 'Forbidden');
    const body = (await request.json()) as { id?: string; ledgerBalancePkr?: number };
    if (!body.id) return httpError(400, 'id is required');
    const ref = caller.db.collection('finance_reconciliations').doc(body.id);
    const snap = await ref.get();
    if (!snap.exists) return httpError(404, 'Reconciliation not found');
    const rec = snap.data() as Reconciliation;
    if (rec.status === 'completed') return httpError(409, 'Reconciliation is already completed');
    if (caller.uid === rec.reconciledBy) {
      return httpError(422, 'The completing officer (checkedBy) must not be the officer who reconciled (reconciledBy)');
    }
    if (!rec.statementDriveId) {
      return httpError(422, 'A bank statement reference (statementDriveId) is required before completion');
    }
    if (rec.closingBalancePkr == null) {
      return httpError(422, 'closingBalancePkr (per the bank statement) must be set before completion');
    }

    const ledgerBalancePkr = await computeAccountBalance(
      caller.db,
      rec.accountLabel,
      rec.openingBalancePkr,
      rec.periodStart,
      rec.periodEnd,
    );
    if (body.ledgerBalancePkr !== undefined && body.ledgerBalancePkr !== ledgerBalancePkr) {
      return httpError(422, `Client-supplied ledger balance ${body.ledgerBalancePkr} differs from the recomputed ${ledgerBalancePkr}`);
    }
    const differencePkr = rec.closingBalancePkr - ledgerBalancePkr;
    if (differencePkr !== 0 && (rec.differenceExplanation ?? '').trim().length < 10) {
      return httpError(422, 'A nonzero difference requires an explanation of at least 10 characters');
    }

    const batch = caller.db.batch();
    batch.update(ref, {
      status: 'completed',
      checkedBy: caller.uid,
      completedAt: FieldValue.serverTimestamp(),
      computedAt: FieldValue.serverTimestamp(),
      ledgerBalancePkr,
      differencePkr,
      updatedAt: FieldValue.serverTimestamp(),
    });
    await writeFinanceAudit(caller.db, batch, {
      action: 'RECONCILIATION_COMPLETED',
      actorUid: caller.uid,
      targetUidOrResource: `finance_reconciliations/${body.id}`,
      payload: { differencePkr, ledgerBalancePkr, closingBalancePkr: rec.closingBalancePkr },
    });
    await batch.commit();

    // ADAPTER: Phase 2 compliance obligation stamping (best-effort).
    await stampComplianceObligation(caller.db, rec.complianceObligationId, body.id);

    return NextResponse.json({ id: body.id, status: 'completed', ledgerBalancePkr, differencePkr });
  } catch (err) {
    return financeErrorResponse(err);
  }
}
