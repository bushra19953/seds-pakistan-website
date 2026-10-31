import { NextRequest, NextResponse } from 'next/server';
import {
  requireVendorContext,
  vendorErrorResponse,
  vendorProductsQuery,
  toVendorProductView,
} from '@/lib/server/vendor-views';

export async function GET(request: NextRequest) {
  try {
    const ctx = await requireVendorContext(request);
    const snap = await vendorProductsQuery(ctx.db, ctx.vendor.id).get();
    const products = snap.docs.map((d) => toVendorProductView({ id: d.id, data: d.data() as Record<string, unknown> }));
    return NextResponse.json({ ok: true, products, count: products.length });
  } catch (err) {
    return vendorErrorResponse(err);
  }
}
