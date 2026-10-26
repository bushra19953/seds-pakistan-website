import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import type { FinanceReceipt } from '@/types/finance';
import { writeFinanceAudit } from '@/lib/server/finance-audit';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';
// MIGRATION SEAM: finance finance-receipts
import { mirrorReceiptUpdate, supaReceiptDoc } from '@/lib/finance/supa/ledger-receipts-seam';
// CUTOVER: finance write-primary (SUPA_PRIMARY=finance) — see
// src/lib/finance/supa/primary.ts.
import { callFinanceTx, financePrimaryEnabled } from '@/lib/finance/supa/primary';

/**
 * Receipt delivery stamp (spec Part C 4.4). Finance stamps delivery; for
 * officer expenses the stamper must not be the officer who spent the
 * money (422). Already-delivered is 409 (idempotent-safe).
 */
export async function POST(request: NextRequest) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  try {
    if (!(await hasServerPermissionForUser(caller.db, caller.uid, 'canManageFinance'))) return httpError(403, 'Forbidden');
    const body = (await request.json()) as { id?: string };
    if (!body.id) return httpError(400, 'id is required');
    const ref = caller.db.collection('finance_receipts').doc(body.id);
    // MIGRATION SEAM: finance finance-receipts (R7)
    const snap = (await supaReceiptDoc(body.id)) ?? (await ref.get());
    if (!snap.exists) return httpError(404, 'Receipt not found');
    const receipt = snap.data() as FinanceReceipt;
    if (receipt.deliveredToTreasurerAt) return httpError(409, 'Receipt is already marked delivered');
    if (receipt.kind === 'officer_expense' && caller.uid === receipt.officerUid) {
      return httpError(422, 'The officer who spent the money cannot stamp their own receipt delivery');
    }
    // CUTOVER (F5f): the function re-checks not-delivered + the
    // self-stamp rule under the receipt's row lock, stamps delivery,
    // and writes RECEIPT_DELIVERED in the same tx.
    if (financePrimaryEnabled()) {
      const res = await callFinanceTx(
        'finance_receipt_deliver',
        'tx_finance_receipt_deliver',
        {
          p_caller_uid: caller.uid,
          p_receipt_id: body.id,
          p_audit_action: 'RECEIPT_DELIVERED',
        },
        `receipt_deliver:${body.id}:${caller.uid}`,
      );
      if (!res || res.ok !== true) return httpError(res?.httpStatus ?? 500, res?.message ?? 'Internal error');
      return NextResponse.json({ id: body.id, delivered: true });
    }
    const batch = caller.db.batch();
    batch.update(ref, { deliveredToTreasurerAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    await writeFinanceAudit(caller.db, batch, {
      action: 'RECEIPT_DELIVERED',
      actorUid: caller.uid,
      targetUidOrResource: `finance_receipts/${body.id}`,
      payload: { officerUid: receipt.officerUid, kind: receipt.kind },
    });
    await batch.commit();
    // MIGRATION SEAM: finance finance-receipts (W6 mirror, MANUAL_LIST M-FG123-5)
    await mirrorReceiptUpdate(body.id, {
      deliveredToTreasurerAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return NextResponse.json({ id: body.id, delivered: true });
  } catch (err) {
    return financeErrorResponse(err);
  }
}
