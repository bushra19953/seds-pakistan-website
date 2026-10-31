import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import {
  requireVendorContext,
  vendorErrorResponse,
  assertVendorOwns,
  toVendorOrderView,
  validateFulfilmentPatch,
  VendorAccessError,
  VENDOR_VISIBLE_STATUSES,
} from '@/lib/server/vendor-views';
import { buildMoneyAuditDoc } from '@/lib/server/money-audit';
import { notificationService } from '@/lib/server/notification-service';
import { deliverVendorOrder } from '@/lib/server/vendor-delivery';

type Ctx = { params: Promise<{ id: string }> };

async function loadVisibleOrder(ctx: Awaited<ReturnType<typeof requireVendorContext>>, id: string) {
  const snap = await ctx.db.collection('orders').doc(id).get();
  if (!snap.exists) throw new VendorAccessError(404, 'not_found', 'Not found');
  const data = snap.data() as Record<string, unknown>;
  assertVendorOwns(ctx, data.vendorId);
  if (!(VENDOR_VISIBLE_STATUSES as readonly string[]).includes(String(data.status))) {
    throw new VendorAccessError(404, 'not_found', 'Not found');
  }
  return { snap, data };
}

export async function GET(request: NextRequest, { params }: Ctx) {
  try {
    const ctx = await requireVendorContext(request);
    const { id } = await params;
    const { data } = await loadVisibleOrder(ctx, id);
    let current = data;

    // Opening a verified order is the relay-open (transition 4): the
    // order moves to processing and relayedAt is stamped, first writer
    // wins against the admin Relay sent action.
    if (data.status === 'verified') {
      const ref = ctx.db.collection('orders').doc(id);
      await ctx.db.runTransaction(async (tx) => {
        const fresh = await tx.get(ref as never);
        const freshData = (fresh as { data: () => Record<string, unknown> }).data() as Record<string, unknown>;
        if (freshData.status !== 'verified') return;
        assertVendorOwns(ctx, freshData.vendorId);
        const update: Record<string, unknown> = {
          status: 'processing',
          updatedAt: FieldValue.serverTimestamp(),
        };
        if (freshData.relayedAt == null) {
          update.relayedAt = FieldValue.serverTimestamp();
          update.relayedBy = 'vendor_open';
        }
        tx.update(ref as never, update as never);
        current = { ...freshData, ...update, status: 'processing' };
      });
    }

    return NextResponse.json({ ok: true, order: toVendorOrderView({ id, data: current }) });
  } catch (err) {
    return vendorErrorResponse(err);
  }
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  try {
    const ctx = await requireVendorContext(request);
    const { id } = await params;
    const { data } = await loadVisibleOrder(ctx, id);
    const body = await request.json().catch(() => null);
    const patch = validateFulfilmentPatch(body, {
      status: String(data.status),
      courierName: typeof data.courierName === 'string' ? data.courierName : null,
      trackingNumber: typeof data.trackingNumber === 'string' ? data.trackingNumber : null,
    });

    // The delivered transition runs GF's helper, which owns every
    // delivery side effect. The vendor route never writes delivered
    // itself.
    if (patch.toStatus === 'delivered') {
      if (patch.courierName || patch.trackingNumber) {
        await ctx.db.collection('orders').doc(id).update({
          ...(patch.courierName ? { courierName: patch.courierName } : {}),
          ...(patch.trackingNumber ? { trackingNumber: patch.trackingNumber } : {}),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      try {
        await deliverVendorOrder(ctx.db, { orderId: id, actorUid: ctx.uid });
      } catch (e) {
        const err = e as { status?: number; code?: string; message?: string };
        if (typeof err?.status === 'number') {
          throw new VendorAccessError(err.status, err.code ?? 'delivery_failed', err.message ?? 'Delivery failed');
        }
        throw e;
      }
      const after = await ctx.db.collection('orders').doc(id).get();
      const afterData = (after.data() ?? {}) as Record<string, unknown>;
      await ctx.db.collection('audit_logs').add(
        buildMoneyAuditDoc({
          action: 'VENDOR_ORDER_DELIVERED',
          actorUid: ctx.uid,
          targetType: 'order',
          targetId: id,
          orderId: id,
          before: { status: data.status },
          after: { status: 'delivered' },
          changedFields: ['status'],
          source: 'vendor_orders_api',
        }),
      );
      notifyBuyer(afterData, 'delivered');
      return NextResponse.json({ ok: true, order: toVendorOrderView({ id, data: afterData }) });
    }

    const ref = ctx.db.collection('orders').doc(id);
    let afterData: Record<string, unknown> = data;
    await ctx.db.runTransaction(async (tx) => {
      const fresh = await tx.get(ref as never);
      const freshData = (fresh as { data: () => Record<string, unknown> }).data() as Record<string, unknown>;
      assertVendorOwns(ctx, freshData.vendorId);
      if (String(freshData.status) !== String(data.status)) {
        throw new VendorAccessError(409, 'invalid_transition', 'The order changed while you were editing it. Reopen it and try again.');
      }
      const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
      if (patch.courierName) update.courierName = patch.courierName;
      if (patch.trackingNumber) update.trackingNumber = patch.trackingNumber;
      if (patch.toStatus === 'shipped') {
        update.status = 'shipped';
        update.dispatchedAt = FieldValue.serverTimestamp();
      }
      tx.update(ref as never, update as never);
      const auditRef = ctx.db.collection('audit_logs').doc();
      tx.set(auditRef as never, buildMoneyAuditDoc({
        action: patch.toStatus === 'shipped' ? 'VENDOR_ORDER_SHIPPED' : 'VENDOR_ORDER_TRACKING_UPDATED',
        actorUid: ctx.uid,
        targetType: 'order',
        targetId: id,
        orderId: id,
        before: { status: freshData.status },
        after: { status: update.status ?? freshData.status },
        changedFields: Object.keys(update).filter((k) => k !== 'updatedAt'),
        source: 'vendor_orders_api',
      }) as never);
      afterData = { ...freshData, ...update };
    });

    if (patch.toStatus === 'shipped') notifyBuyer(afterData, 'shipped');
    return NextResponse.json({ ok: true, order: toVendorOrderView({ id, data: afterData }) });
  } catch (err) {
    return vendorErrorResponse(err);
  }
}

function notifyBuyer(order: Record<string, unknown>, status: 'shipped' | 'delivered') {
  const buyerUserId = typeof order.buyerUserId === 'string' ? order.buyerUserId : typeof order.userId === 'string' ? order.userId : null;
  if (!buyerUserId) return;
  const body =
    status === 'shipped' ? 'Your order has been shipped!' : 'Your order has been delivered. Enjoy!';
  notificationService
    .send(buyerUserId, { title: 'Order Update', body, type: 'order', link: '/user/profile?tab=orders' }, 'P1')
    .catch((err: unknown) => console.error('[vendor orders] buyer notification failed:', err));
}
