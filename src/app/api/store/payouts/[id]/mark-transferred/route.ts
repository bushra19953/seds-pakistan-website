import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { writeFinanceAudit } from '@/lib/server/finance-audit';
import { mirrorVendorShopUpdate } from '@/lib/supa/vendor-shop-mirror';

/**
 * Mark a payout transferred after the real bank transfer (spec 8.5).
 * The payout must be approved: its status is approved, or it is
 * pending_approval whose linked ledger_post approval is
 * approved_applied (R-3 read-time reconciliation). Every covered entry
 * must still be payable; if any entry moved (for example a return
 * claim flagged it held_dispute), the whole call 409s with
 * entries_changed and nothing moves.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  const db = caller.db;
  const { id } = await params;
  try {
    if (!(await hasServerPermissionForUser(db, caller.uid, 'canManageStore'))) return httpError(403, 'Forbidden');

    const result = await db.runTransaction(async (tx) => {
      const payoutRef = db.collection('vendor_payouts').doc(id);
      const payoutSnap = await tx.get(payoutRef as never);
      if (!(payoutSnap as { exists: boolean }).exists) {
        return { status: 404 as const, body: { error: 'Payout not found' } };
      }
      const payout = (payoutSnap as { data: () => Record<string, unknown> }).data();

      let approved = payout.status === 'approved';
      if (!approved && payout.status === 'pending_approval' && typeof payout.financeApprovalId === 'string') {
        const approvalSnap = await tx.get(db.collection('money_approvals').doc(payout.financeApprovalId) as never);
        if ((approvalSnap as { exists: boolean }).exists) {
          const approval = (approvalSnap as { data: () => Record<string, unknown> }).data();
          approved = approval.status === 'approved_applied';
        }
      }
      if (!approved) {
        return {
          status: 409 as const,
          body: { error: 'Only an approved payout can be marked transferred', code: 'payout_not_approved' },
        };
      }

      const entryIds = Array.isArray(payout.entryIds) ? (payout.entryIds as string[]) : [];
      const entryRefs = entryIds.map((eid) => db.collection('commission_ledger').doc(eid));
      const entrySnaps: Array<{ exists: boolean; data: () => Record<string, unknown> }> = [];
      for (const ref of entryRefs) {
        entrySnaps.push((await tx.get(ref as never)) as never);
      }
      for (let i = 0; i < entrySnaps.length; i++) {
        const s = entrySnaps[i];
        if (!s.exists || s.data().state !== 'payable' || s.data().vendorId !== payout.vendorId) {
          return {
            status: 409 as const,
            body: {
              error: 'A covered entry is no longer payable. Delete this payout and create a fresh draft.',
              code: 'entries_changed',
            },
          };
        }
      }

      tx.update(payoutRef as never, {
        status: 'transferred',
        transferredAt: FieldValue.serverTimestamp(),
      } as never);
      entrySnaps.forEach((s, i) => {
        const entry = s.data();
        tx.update(entryRefs[i] as never, {
          state: 'paid',
          payoutId: id,
          updatedAt: FieldValue.serverTimestamp(),
        } as never);
        if (typeof entry.orderId === 'string') {
          tx.update(db.collection('orders').doc(entry.orderId) as never, {
            payoutId: id,
            updatedAt: FieldValue.serverTimestamp(),
          } as never);
        }
      });
      await writeFinanceAudit(db, tx as never, {
        action: 'VENDOR_PAYOUT_TRANSFERRED',
        actorUid: caller.uid,
        targetUidOrResource: `vendor_payouts/${id}`,
        payload: { vendorId: payout.vendorId ?? null, netPkr: payout.netPkr ?? null, entryIds },
      });
      return { status: 200 as const, body: { ok: true, payoutId: id, entriesPaid: entryIds.length } };
    });

    if (result.status === 200) {
      await mirrorVendorShopUpdate('vendor_payouts', id, { status: 'transferred' }).catch(() => false);
    }
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    return financeErrorResponse(err);
  }
}
