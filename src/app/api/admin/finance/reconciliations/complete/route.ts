import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { hasServerPermission } from '@/lib/server/permissions';
import type { Reconciliation } from '@/types/finance';
import { writeFinanceAudit } from '@/lib/server/finance-audit';
import { computeAccountBalance } from '@/lib/finance/ledger';
import { stampComplianceObligation } from '@/lib/finance/adapters';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';

/**
 * Reconciliation completion (spec Part C 4.3). The completing officer must
 * NOT be the reconciledBy maker (422), a statement reference is required,
 * the ledger balance is RECOMPUTED from posted entries (a differing
 * client-supplied figure is rejected), and a nonzero difference needs an
 * explanation of at least 10 characters. Completing a completed record is
 * a 409 (idempotent-safe).
 *
 * ADAPTER (Phase 2, obligations): after completion the compliance
 * obligation for this month's bank reconciliation is stamped via the
 * adapters module - best-effort, never failing the completion.
 */
export async function POST(request: NextRequest) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  try {
    if (!(await hasServerPermission(caller.role, 'canManageFinance'))) return httpError(403, 'Forbidden');
    const body = (await request.json()) as {
      id?: string;
      statementDriveId?: string;
      statementDriveUrl?: string;
      ledgerBalancePkr?: number;
    };
    if (!body.id) return httpError(400, 'id is required');
    const ref = caller.db.collection('finance_reconciliations').doc(body.id);
    const snap = await ref.get();
    if (!snap.exists) return httpError(404, 'Reconciliation not found');
    const rec = snap.data() as Reconciliation;
    if (rec.status === 'completed') return httpError(409, 'Reconciliation is already completed');
    if (caller.uid === rec.reconciledBy) {
      return httpError(422, 'The completing officer must not be the officer who reconciled (maker != checker)');
    }
    const statementDriveId = body.statementDriveId || rec.statementDriveId;
    if (!statementDriveId) return httpError(422, 'A bank statement reference (statementDriveId) is required');

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
    const differencePkr = rec.statementBalancePkr - ledgerBalancePkr;
    if (differencePkr !== 0 && (rec.differenceExplanation ?? '').trim().length < 10) {
      return httpError(422, 'A nonzero difference requires an explanation of at least 10 characters');
    }

    const batch = caller.db.batch();
    batch.update(ref, {
      status: 'completed',
      completedBy: caller.uid,
      ledgerBalancePkr,
      differencePkr,
      statementDriveId,
      statementDriveUrl: body.statementDriveUrl || rec.statementDriveUrl || '',
      updatedAt: FieldValue.serverTimestamp(),
    });
    await writeFinanceAudit(caller.db, batch, {
      action: 'RECONCILIATION_COMPLETED',
      actorUid: caller.uid,
      targetUidOrResource: `finance_reconciliations/${body.id}`,
      payload: { differencePkr, ledgerBalancePkr, statementBalancePkr: rec.statementBalancePkr },
    });
    await batch.commit();

    // ADAPTER: Phase 2 compliance obligation stamping (best-effort).
    await stampComplianceObligation(caller.db, 'bank_reconciliation', {
      id: body.id,
      accountLabel: rec.accountLabel,
      month: rec.month,
      reconciledBy: rec.reconciledBy,
      completedBy: caller.uid,
      differencePkr,
    });

    return NextResponse.json({ id: body.id, status: 'completed', ledgerBalancePkr, differencePkr });
  } catch (err) {
    return financeErrorResponse(err);
  }
}
