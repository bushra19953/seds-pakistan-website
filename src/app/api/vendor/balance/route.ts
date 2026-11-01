import { NextRequest, NextResponse } from 'next/server';
import {
  requireVendorContext,
  vendorErrorResponse,
  vendorLedgerQuery,
  vendorPayoutsQuery,
  toVendorPayoutView,
  sumLedgerByState,
  nextPayoutDate,
} from '@/lib/server/vendor-views';

export async function GET(request: NextRequest) {
  try {
    const ctx = await requireVendorContext(request);

    const ledgerSnap = await vendorLedgerQuery(ctx.db, ctx.vendor.id).limit(500).get();
    const rows = ledgerSnap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      return { state: String(data.state ?? ''), vendorDuePkr: typeof data.vendorDuePkr === 'number' ? data.vendorDuePkr : 0 };
    });
    const sums = sumLedgerByState(rows);

    const payoutSnap = await vendorPayoutsQuery(ctx.db, ctx.vendor.id).limit(20).get();
    const payouts = payoutSnap.docs.map((d) => toVendorPayoutView({ id: d.id, data: d.data() as Record<string, unknown> }));

    const base = ctx.db.collection('orders').where('vendorId', '==', ctx.vendor.id);
    const toDispatchSnap = await base.where('status', 'in', ['verified', 'processing']).count().get();
    const awaitingSnap = await base.where('status', '==', 'shipped').count().get();

    return NextResponse.json({
      ok: true,
      businessName: ctx.vendor.businessName,
      accruedPkr: sums.accruedPkr,
      payablePkr: sums.payablePkr,
      paidPkr: sums.paidPkr,
      heldDisputePkr: sums.heldDisputePkr,
      heldDisputeCount: sums.heldDisputeCount,
      toDispatchCount: toDispatchSnap.data().count,
      awaitingDeliveryCount: awaitingSnap.data().count,
      nextPayoutDate: nextPayoutDate(),
      payouts,
      sumsTruncated: ledgerSnap.docs.length >= 500,
    });
  } catch (err) {
    return vendorErrorResponse(err);
  }
}
