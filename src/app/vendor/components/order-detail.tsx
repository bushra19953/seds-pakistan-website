'use client';

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { useVendorApi, type VendorApiError } from './use-vendor-api';
import { OrderStatusBadge } from './status-badge';

export interface VendorOrder {
  id: string;
  status: string;
  items: Array<{ productName: string | null; quantity: number | null; price: number | null; subtotal: number | null }>;
  subtotalPkr: number | null;
  deliveryPkr: number | null;
  totalPkr: number | null;
  buyerName: string | null;
  buyerPhone: string | null;
  shippingAddress: Record<string, string> | null;
  courierName: string | null;
  trackingNumber: string | null;
  promisedDeliveryDate: string | null;
  createdAt: string | null;
}

export function OrderDetail({
  orderId,
  onClose,
  onChanged,
}: {
  orderId: string | null;
  onClose: () => void;
  onChanged: (order: VendorOrder) => void;
}) {
  const { get, patch } = useVendorApi();
  const { toast } = useToast();
  const [order, setOrder] = useState<VendorOrder | null>(null);
  const [courier, setCourier] = useState('');
  const [tracking, setTracking] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!orderId) {
      setOrder(null);
      return;
    }
    get(`/api/vendor/orders/${orderId}`)
      .then((d: { order: VendorOrder }) => {
        setOrder(d.order);
        setCourier(d.order.courierName ?? '');
        setTracking(d.order.trackingNumber ?? '');
        onChanged(d.order);
      })
      .catch((e: VendorApiError) => toast({ variant: 'destructive', title: 'Could not open order', description: e.error }));
    // onChanged is a parent setState; intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, get]);

  if (!orderId) return null;

  const canEditTracking = order && ['verified', 'processing', 'shipped'].includes(order.status);
  const canShip = order && ['verified', 'processing'].includes(order.status);
  const canDeliver = order && order.status === 'shipped';

  async function submit(body: Record<string, unknown>, successTitle: string) {
    if (!order) return;
    setBusy(true);
    try {
      const d = await patch(`/api/vendor/orders/${order.id}`, body);
      setOrder(d.order);
      onChanged(d.order);
      toast({ title: successTitle });
    } catch (e) {
      const err = e as VendorApiError;
      toast({ variant: 'destructive', title: 'Update failed', description: err.error });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!orderId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Order {orderId.slice(0, 8)}</DialogTitle>
        </DialogHeader>
        {!order ? (
          <p className="text-sm text-muted-foreground">Loading</p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <OrderStatusBadge status={order.status} />
              {order.promisedDeliveryDate && (
                <span className="text-sm text-muted-foreground">Promised delivery: {order.promisedDeliveryDate}</span>
              )}
            </div>
            <div>
              <p className="font-semibold">{order.buyerName ?? 'Buyer'}</p>
              {order.buyerPhone && <p className="text-sm">{order.buyerPhone}</p>}
              {order.shippingAddress && (
                <p className="text-sm text-muted-foreground">
                  {[order.shippingAddress.address, order.shippingAddress.city, order.shippingAddress.postalCode, order.shippingAddress.country]
                    .filter(Boolean)
                    .join(', ')}
                </p>
              )}
            </div>
            <div className="space-y-1">
              {order.items.map((it, i) => (
                <p key={i} className="text-sm">
                  {it.productName ?? 'Item'} x{it.quantity ?? 1}
                  {it.subtotal != null ? ` · PKR ${it.subtotal.toLocaleString('en-PK')}` : ''}
                </p>
              ))}
              <p className="text-sm">Subtotal: PKR {(order.subtotalPkr ?? 0).toLocaleString('en-PK')}</p>
              <p className="text-sm">Delivery: PKR {(order.deliveryPkr ?? 0).toLocaleString('en-PK')}</p>
              <p className="text-sm font-bold">Total: PKR {(order.totalPkr ?? 0).toLocaleString('en-PK')}</p>
            </div>
            {canEditTracking && (
              <div className="space-y-3 border-t pt-4">
                <div>
                  <Label htmlFor="vendor-courier">Courier</Label>
                  <Input id="vendor-courier" value={courier} onChange={(e) => setCourier(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="vendor-tracking">Tracking number</Label>
                  <Input id="vendor-tracking" value={tracking} onChange={(e) => setTracking(e.target.value)} />
                </div>
                <div className="flex gap-2 flex-wrap">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => submit({ courierName: courier, trackingNumber: tracking }, 'Tracking saved')}
                  >
                    Save tracking
                  </Button>
                  {canShip && (
                    <Button
                      disabled={busy || !courier.trim() || !tracking.trim()}
                      onClick={() => submit({ courierName: courier, trackingNumber: tracking, status: 'shipped' }, 'Order marked shipped')}
                    >
                      Mark shipped
                    </Button>
                  )}
                  {canDeliver && (
                    <Button disabled={busy} onClick={() => submit({ status: 'delivered' }, 'Order marked delivered')}>
                      Mark delivered
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
