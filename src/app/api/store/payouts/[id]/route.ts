import { NextRequest, NextResponse } from 'next/server';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { writeFinanceAudit } from '@/lib/server/finance-audit';
import { mirrorVendorShopDelete } from '@/lib/supa/vendor-shop-mirror';

/**
 * Delete a payout draft (spec 8 item 5: a mismatched draft is deleted,
 * never edited). Only a draft, or a pending_approval payout whose linked
 * finance approval was rejected or expired, can be deleted.
 * The fs_vendor_payouts mirror row is deleted after the commit via
 * mirrorVendorShopDelete (coordinator amendment, GG merge).
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  const db = caller.db;
  const { id } = await params;
  try {
    if (!(await hasServerPermissionForUser(db, caller.uid, 'canManageStore'))) return httpError(403, 'Forbidden');
    const ref = db.collection('vendor_payouts').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return httpError(404, 'Payout not found');
    const payout = snap.data() as Record<string, unknown>;

    let deletable = payout.status === 'draft';
    if (payout.status === 'pending_approval' && typeof payout.financeApprovalId === 'string') {
      const approvalSnap = await db.collection('money_approvals').doc(payout.financeApprovalId).get();
      const approvalStatus = approvalSnap.exists ? String((approvalSnap.data() as Record<string, unknown>).status ?? '') : '';
      deletable = approvalStatus === 'rejected' || approvalStatus === 'expired';
    }
    if (!deletable) {
      return NextResponse.json(
        { error: 'Only a draft payout, or one whose approval was rejected, can be deleted', code: 'payout_not_deletable' },
        { status: 409 },
      );
    }

    const batch = db.batch();
    batch.delete(ref as never);
    await writeFinanceAudit(db, batch as never, {
      action: 'VENDOR_PAYOUT_DRAFT_DELETED',
      actorUid: caller.uid,
      targetUidOrResource: `vendor_payouts/${id}`,
      payload: { vendorId: payout.vendorId ?? null, status: payout.status ?? null },
    });
    await batch.commit();
    await mirrorVendorShopDelete('vendor_payouts', id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return financeErrorResponse(err);
  }
}
