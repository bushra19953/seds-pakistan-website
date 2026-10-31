import { NextRequest, NextResponse } from 'next/server';
import {
  requireVendorContext,
  vendorErrorResponse,
  vendorOrdersQuery,
  toVendorOrderView,
  parseLimit,
  VendorAccessError,
  VENDOR_VISIBLE_STATUSES,
} from '@/lib/server/vendor-views';

export async function GET(request: NextRequest) {
  try {
    const ctx = await requireVendorContext(request);
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get('limit'), 20);
    const cursor = url.searchParams.get('cursor');
    const status = url.searchParams.get('status');

    let q;
    if (status) {
      if (!(VENDOR_VISIBLE_STATUSES as readonly string[]).includes(status)) {
        throw new VendorAccessError(400, 'bad_request', 'status is invalid');
      }
      q = ctx.db
        .collection('orders')
        .where('vendorId', '==', ctx.vendor.id)
        .where('status', '==', status)
        .orderBy('createdAt', 'desc');
    } else {
      q = vendorOrdersQuery(ctx.db, ctx.vendor.id);
    }
    if (cursor) {
      const cursorDoc = await ctx.db.collection('orders').doc(cursor).get();
      if (cursorDoc.exists) q = q.startAfter(cursorDoc);
    }
    const snap = await q.limit(limit + 1).get();
    const hasMore = snap.docs.length > limit;
    const page = hasMore ? snap.docs.slice(0, limit) : snap.docs;
    const orders = page.map((d) => toVendorOrderView({ id: d.id, data: d.data() as Record<string, unknown> }));
    const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].id : null;
    return NextResponse.json({
      ok: true,
      orders,
      count: orders.length,
      hasMore,
      nextCursor,
      pagination: { limit, cursor, hasMore, nextCursor },
    });
  } catch (err) {
    return vendorErrorResponse(err);
  }
}
