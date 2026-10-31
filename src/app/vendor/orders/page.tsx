'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useVendorApi, VENDOR_GATE_MESSAGE, type VendorApiError } from '../components/use-vendor-api';
import { EmptyState } from '../components/empty-state';
import { OrderStatusBadge } from '../components/status-badge';
import { OrderDetail, type VendorOrder } from '../components/order-detail';

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'verified', label: 'Verified' },
  { value: 'processing', label: 'Processing' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'refunded', label: 'Refunded' },
];

export default function VendorOrdersPage() {
  const { get, user } = useVendorApi();
  const [orders, setOrders] = useState<VendorOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (cursor) params.set('cursor', cursor);
      const qs = params.toString();
      const d = await get(`/api/vendor/orders${qs ? `?${qs}` : ''}`);
      setOrders((prev) => (cursor && prev ? [...prev, ...d.orders] : d.orders));
      setNextCursor(d.hasMore ? d.nextCursor : null);
    },
    [get, status],
  );

  useEffect(() => {
    if (!user) return;
    setOrders(null);
    load().catch((e: VendorApiError) => setError(e.status === 403 ? VENDOR_GATE_MESSAGE : e.error));
  }, [load, user]);

  if (error) return <EmptyState title="Orders" body={error} />;

  return (
    <div className="space-y-3">
      <h1 className="text-xl font-bold">Orders</h1>
      <div className="flex gap-2 flex-wrap">
        {FILTERS.map((f) => (
          <Button key={f.value} size="sm" variant={status === f.value ? 'default' : 'outline'} onClick={() => setStatus(f.value)}>
            {f.label}
          </Button>
        ))}
      </div>
      {!orders ? (
        <p className="text-sm text-muted-foreground">Loading</p>
      ) : orders.length === 0 ? (
        <EmptyState title="No orders yet" body="Verified orders for your products will appear here." />
      ) : (
        <>
          {orders.map((o) => (
            <Card key={o.id} className="cursor-pointer" onClick={() => setSelectedId(o.id)}>
              <CardContent className="py-4 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold truncate">
                    {o.items[0]?.productName ?? 'Order'} {o.items[0]?.quantity ? `x${o.items[0].quantity}` : ''}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {o.buyerName ?? ''} · {o.createdAt ? new Date(o.createdAt).toLocaleDateString('en-GB') : ''} · {o.id.slice(0, 8)}
                  </p>
                </div>
                <p className="font-bold tabular-nums">PKR {(o.totalPkr ?? 0).toLocaleString('en-PK')}</p>
                <OrderStatusBadge status={o.status} />
              </CardContent>
            </Card>
          ))}
          {nextCursor && (
            <Button variant="outline" onClick={() => load(nextCursor).catch(() => undefined)}>
              Load more
            </Button>
          )}
        </>
      )}
      <OrderDetail
        orderId={selectedId}
        onClose={() => setSelectedId(null)}
        onChanged={(updated) => setOrders((prev) => (prev ? prev.map((o) => (o.id === updated.id ? { ...o, ...updated } : o)) : prev))}
      />
    </div>
  );
}
