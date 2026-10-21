'use client';

import AuthorizationGate from '@/components/admin/AuthorizationGate';
import StarryBackground from '@/components/ui/starry-background';
import Footer from '@/components/layout/footer';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useCollection, useFirestore, useUser } from '@/firebase';
import { useMemoFirebase } from '@/lib/use-memo-firebase';
import { collection, query, orderBy } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import { normalizeOrder, type CanonicalOrder } from '@/lib/finance/order-canonical';
import { logAuditEntry } from '@/lib/audit-logging';

/**
 * Certificate orders admin (CH-13 retrofit). This page used to write the
 * legacy statuses paid/printed directly to Firestore with no audit
 * (audit finding TBD-03). Now:
 *  - reads go through the canonical compat reader (normalizeOrder),
 *  - "Mark Paid" creates a maker-checker request (order_mark_paid),
 *  - "Printed" folds into canonical processing + a fulfilment note via
 *    the orders API (non-money PATCH) WITH an audit entry,
 *  - "Shipped" stays a direct non-money PATCH + audit entry.
 */
export default function AdminOrdersPage() {
  const firestore = useFirestore();
  const { user } = useUser();
  const { toast } = useToast();
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [pendingApprovalIds, setPendingApprovalIds] = useState<Set<string>>(new Set());

  const ordersQuery = useMemoFirebase(() => {
    try {
      return query(collection(firestore, 'orders'), orderBy('createdAt', 'desc'));
    } catch {
      return collection(firestore, 'orders');
    }
  }, [firestore]);
  const { data: orders, loading } = useCollection(ordersQuery);

  useEffect(() => {
    (async () => {
      if (!user) return;
      try {
        const token = await user.getIdToken();
        const res = await fetch('/api/admin/finance/approvals?scope=mine', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        const ids = new Set<string>(
          (data.approvals ?? [])
            .filter((a: { status: string }) => a.status === 'pending')
            .map((a: { targetId: string }) => a.targetId),
        );
        setPendingApprovalIds(ids);
      } catch {
        /* pending state is best-effort */
      }
    })();
  }, [user]);

  const requestMarkPaid = async (order: CanonicalOrder) => {
    if (!user) return;
    try {
      setUpdatingId(order.id);
      const token = await user.getIdToken();
      const res = await fetch('/api/admin/finance/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          targetType: 'order_mark_paid',
          targetId: order.id,
          changePayload: { fromStatus: order.status, toStatus: 'verified' },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Request failed');
      setPendingApprovalIds((prev) => new Set(prev).add(order.id));
      toast({ title: 'Verification requested', description: 'A checker must approve this payment before it takes effect.' });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Request failed', description: err instanceof Error ? err.message : 'Could not request verification.' });
    } finally {
      setUpdatingId(null);
    }
  };

  const patchFulfilment = async (order: CanonicalOrder, status: 'processing' | 'shipped', note?: string) => {
    if (!user) return;
    try {
      setUpdatingId(order.id);
      const token = await user.getIdToken();
      const res = await fetch('/api/store/orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orderId: order.id, updates: { status, ...(note ? { fulfilmentNote: note } : {}) } }),
      });
      if (!res.ok) throw new Error('Update failed');
      await logAuditEntry(firestore, 'ORDER_STATUS_CHANGED', user.uid, `orders/${order.id}`, {
        fromStatus: order.status,
        toStatus: status,
        fulfilmentNote: note ?? null,
      }).catch(() => undefined);
      toast({ title: 'Order updated', description: `Status set to ${status}.` });
    } catch (err) {
      console.error(err);
      toast({ variant: 'destructive', title: 'Update failed', description: 'Could not update order status.' });
    } finally {
      setUpdatingId(null);
    }
  };

  return (
    <AuthorizationGate permission="canManageStore">
      <div className="relative min-h-screen flex flex-col">
        <StarryBackground />
        <main className="flex-1 py-10">
          <div className="container mx-auto px-4 md:px-6">
            <Card className="bg-card/80 backdrop-blur-sm border-accent/20 shadow-xl">
              <CardHeader>
                <CardTitle className="text-2xl">Orders</CardTitle>
                <CardDescription>Manage payment confirmations and fulfillment for printed certificates. Payment confirmation runs through maker-checker approval.</CardDescription>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <div className="text-muted-foreground">Loading…</div>
                ) : Array.isArray(orders) && orders.length > 0 ? (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Order ID</TableHead>
                          <TableHead>Certificate Code</TableHead>
                          <TableHead>Buyer</TableHead>
                          <TableHead>Amount</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Receipt</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {orders.map((o: Record<string, unknown>) => {
                          const order = normalizeOrder(o, o.id as string);
                          const buyerName = order.buyer?.fullName || '—';
                          const amt =
                            order.totalPkr != null
                              ? `PKR ${order.totalPkr.toLocaleString('en-PK')}`
                              : order.declaredAmountPkr != null
                                ? `PKR ${order.declaredAmountPkr.toLocaleString('en-PK')} (declared)`
                                : '—';
                          const isPending = pendingApprovalIds.has(order.id);
                          return (
                            <TableRow key={order.id}>
                              <TableCell className="font-mono">{order.id}</TableCell>
                              <TableCell className="font-mono">{order.certificateCode || '—'}</TableCell>
                              <TableCell>{buyerName}</TableCell>
                              <TableCell>{amt}</TableCell>
                              <TableCell>
                                <Badge variant={order.status === 'pending_verification' ? 'secondary' : 'default'}>
                                  {order.status}
                                </Badge>
                                {order.paymentStatus && (
                                  <span className="ml-2 text-xs text-muted-foreground">{order.paymentStatus}</span>
                                )}
                              </TableCell>
                              <TableCell>
                                {order.receiptUrl ? (
                                  <a href={order.receiptUrl} target="_blank" rel="noreferrer" className="underline text-sm">View</a>
                                ) : (
                                  <span className="text-muted-foreground text-sm">None</span>
                                )}
                              </TableCell>
                              <TableCell className="text-right space-x-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={updatingId === order.id || isPending || order.paymentStatus === 'completed'}
                                  onClick={() => requestMarkPaid(order)}
                                >
                                  {isPending ? 'Verification Pending' : 'Mark Paid'}
                                </Button>
                                <Button variant="outline" size="sm" disabled={updatingId === order.id} onClick={() => patchFulfilment(order, 'processing', 'Certificate printed')}>Mark Printed</Button>
                                <Button variant="default" size="sm" disabled={updatingId === order.id} onClick={() => patchFulfilment(order, 'shipped')}>Mark Shipped</Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <div className="text-muted-foreground">No orders yet.</div>
                )}
              </CardContent>
            </Card>
          </div>
        </main>
        <Footer />
      </div>
    </AuthorizationGate>
  );
}
