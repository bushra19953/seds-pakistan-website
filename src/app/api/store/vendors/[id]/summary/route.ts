import { NextRequest, NextResponse } from 'next/server';
import { requireStoreAdmin, isoOrNull } from '@/lib/server/store-admin';

/**
 * Per-vendor founder summary (GG): order count, payable and accrued
 * sums, and payout history joined read-time with each payout's finance
 * approval state. Under R-3 the approval is a ledger_post approval; an
 * approved_applied approval displays the payout as approved.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireStoreAdmin(request);
  if ('response' in auth) return auth.response;
  const { db } = auth;
  const { id } = await params;
  try {
    const ordersCountSnap = await db.collection('orders').where('vendorId', '==', id).count().get();

    const payableSnap = await db
      .collection('commission_ledger')
      .where('vendorId', '==', id)
      .where('state', '==', 'payable')
      .limit(500)
      .get();
    let payablePkr = 0;
    for (const d of payableSnap.docs) {
      const v = (d.data() as Record<string, unknown>).vendorDuePkr;
      if (typeof v === 'number') payablePkr += v;
    }

    const accruedSnap = await db
      .collection('commission_ledger')
      .where('vendorId', '==', id)
      .where('state', '==', 'accrued')
      .limit(500)
      .get();
    let accruedPkr = 0;
    for (const d of accruedSnap.docs) {
      const v = (d.data() as Record<string, unknown>).vendorDuePkr;
      if (typeof v === 'number') accruedPkr += v;
    }

    const payoutsSnap = await db
      .collection('vendor_payouts')
      .where('vendorId', '==', id)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();

    const payouts = [];
    for (const d of payoutsSnap.docs) {
      const p = d.data() as Record<string, unknown>;
      let approvalStatus: string | null = null;
      let displayStatus = String(p.status ?? '');
      if (typeof p.financeApprovalId === 'string' && p.financeApprovalId) {
        const aSnap = await db.collection('money_approvals').doc(p.financeApprovalId).get();
        if (aSnap.exists) {
          approvalStatus = String((aSnap.data() as Record<string, unknown>).status ?? '');
          if (displayStatus === 'pending_approval' && approvalStatus === 'approved_applied') displayStatus = 'approved';
          if (displayStatus === 'pending_approval' && (approvalStatus === 'rejected' || approvalStatus === 'expired')) {
            displayStatus = 'rejected';
          }
        }
      }
      payouts.push({
        id: d.id,
        vendorId: p.vendorId ?? id,
        periodStart: p.periodStart ?? null,
        periodEnd: p.periodEnd ?? null,
        entryIds: Array.isArray(p.entryIds) ? p.entryIds : [],
        grossPkr: p.grossPkr ?? null,
        commissionPkr: p.commissionPkr ?? null,
        netPkr: p.netPkr ?? null,
        status: p.status ?? null,
        displayStatus,
        approvalStatus,
        financeApprovalId: p.financeApprovalId ?? null,
        createdBy: p.createdBy ?? null,
        createdAt: isoOrNull(p.createdAt),
        transferredAt: isoOrNull(p.transferredAt),
      });
    }

    return NextResponse.json({
      ok: true,
      vendorId: id,
      ordersCount: ordersCountSnap.data().count,
      payablePkr,
      payableCount: payableSnap.docs.length,
      accruedPkr,
      payouts,
    });
  } catch (err) {
    console.error('[vendor summary] GET error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
