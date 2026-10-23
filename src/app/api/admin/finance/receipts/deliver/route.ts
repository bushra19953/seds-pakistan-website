import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import type { FinanceReceipt } from '@/types/finance';
import { writeFinanceAudit } from '@/lib/server/finance-audit';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';

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
    const snap = await ref.get();
    if (!snap.exists) return httpError(404, 'Receipt not found');
    const receipt = snap.data() as FinanceReceipt;
    if (receipt.deliveredToTreasurerAt) return httpError(409, 'Receipt is already marked delivered');
    if (receipt.kind === 'officer_expense' && caller.uid === receipt.officerUid) {
      return httpError(422, 'The officer who spent the money cannot stamp their own receipt delivery');
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
    return NextResponse.json({ id: body.id, delivered: true });
  } catch (err) {
    return financeErrorResponse(err);
  }
}
