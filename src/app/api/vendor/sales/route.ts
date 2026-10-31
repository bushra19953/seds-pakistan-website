import { NextRequest, NextResponse } from 'next/server';
import {
  requireVendorContext,
  vendorErrorResponse,
  vendorLedgerQuery,
  toVendorLedgerView,
  parseLimit,
} from '@/lib/server/vendor-views';

export async function GET(request: NextRequest) {
  try {
    const ctx = await requireVendorContext(request);
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get('limit'), 20);
    const cursor = url.searchParams.get('cursor');

    let q = vendorLedgerQuery(ctx.db, ctx.vendor.id);
    if (cursor) {
      const cursorDoc = await ctx.db.collection('commission_ledger').doc(cursor).get();
      if (cursorDoc.exists) q = q.startAfter(cursorDoc);
    }
    const snap = await q.limit(limit + 1).get();
    const hasMore = snap.docs.length > limit;
    const page = hasMore ? snap.docs.slice(0, limit) : snap.docs;

    const orderRefs = page.map((d) => {
      const data = d.data() as Record<string, unknown>;
      return ctx.db.collection('orders').doc(String(data.orderId ?? d.id));
    });
    const orderSnaps = orderRefs.length > 0 ? await ctx.db.getAll(...(orderRefs as never[])) : [];

    const rows = page.map((d, i) => {
      const view = toVendorLedgerView({ id: d.id, data: d.data() as Record<string, unknown> });
      const orderSnap = orderSnaps[i] as unknown as { exists: boolean; data: () => Record<string, unknown> | undefined };
      const order = orderSnap && orderSnap.exists ? (orderSnap.data() ?? {}) : null;
      let productName: string | null = null;
      let itemsSummary = '';
      if (order && Array.isArray(order.items) && order.items.length > 0) {
        const first = order.items[0] as Record<string, unknown>;
        productName = typeof first.productName === 'string' ? first.productName : typeof first.title === 'string' ? first.title : null;
        if (productName) itemsSummary = `${productName} x${typeof first.quantity === 'number' ? first.quantity : 1}`;
      }
      return {
        ...view,
        productName,
        orderStatus: order ? ((order.status as string) ?? null) : null,
        itemsSummary,
      };
    });

    const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].id : null;
    return NextResponse.json({
      ok: true,
      rows,
      count: rows.length,
      hasMore,
      nextCursor,
      pagination: { limit, cursor, hasMore, nextCursor },
    });
  } catch (err) {
    return vendorErrorResponse(err);
  }
}
