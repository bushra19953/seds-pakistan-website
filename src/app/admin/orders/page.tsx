'use client';

import AuthorizationGate from '@/components/admin/AuthorizationGate';
import StarryBackground from '@/components/ui/starry-background';
import Footer from '@/components/layout/footer';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useCollection, useFirestore } from '@/firebase';
import { useMemoFirebase } from '@/lib/use-memo-firebase';
import { collection, query, orderBy, doc, serverTimestamp } from 'firebase/firestore';
;
import { useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import { updateDoc } from '@/lib/client/firestore-wrapper';

type OrderItem = { type: string; title: string; quantity: number };
type Order = {
  id: string;
  status: 'pending_payment' | 'paid' | 'printed' | 'shipped' | string;
  certificateCode?: string;
  holderUserId?: string | null;
  buyerUserId?: string | null;
  buyer?: {
    fullName?: string;
    email?: string;
    phone?: string;
    address1?: string;
    address2?: string;
    city?: string;
    postalCode?: string;
    country?: string;
    notes?: string;
  };
  amount?: number | null;
  currency?: string | null;
  paymentProvider?: string | null;
  paymentInstructions?: string | null;
  createdAt?: any;
  updatedAt?: any;
  items?: OrderItem[];
  receiptUrl?: string | null;
};

export default function AdminOrdersPage() {
  const firestore = useFirestore();
  const { toast } = useToast();
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const ordersQuery = useMemoFirebase(() => {
    try {
      return query(collection(firestore, 'orders'), orderBy('createdAt', 'desc'));
    } catch {
      return collection(firestore, 'orders');
    }
  }, [firestore]);
  const { data: orders, loading } = useCollection(ordersQuery);

  const handleStatus = async (orderId: string, status: Order['status']) => {
    try {
      setUpdatingId(orderId);
      await updateDoc(doc(firestore, 'orders', orderId), {
        status,
        updatedAt: serverTimestamp(),
      });
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
                <CardDescription>Manage payment confirmations and fulfillment for printed certificates.</CardDescription>
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
                        {orders.map((o: any) => {
                          const order: Order = { id: o.id, ...o };
                          const buyerName = order?.buyer?.fullName || '—';
                          const amt = order.amount != null ? `${order.amount} ${order.currency || ''}` : '—';
                          return (
                            <TableRow key={order.id}>
                              <TableCell className="font-mono">{order.id}</TableCell>
                              <TableCell className="font-mono">{order.certificateCode || '—'}</TableCell>
                              <TableCell>{buyerName}</TableCell>
                              <TableCell>{amt}</TableCell>
                              <TableCell>
                                <Badge variant={order.status === 'pending_payment' ? 'secondary' : 'default'}>
                                  {order.status}
                                </Badge>
                              </TableCell>
                              <TableCell>
                                {order.receiptUrl ? (
                                  <a href={order.receiptUrl} target="_blank" rel="noreferrer" className="underline text-sm">View</a>
                                ) : (
                                  <span className="text-muted-foreground text-sm">None</span>
                                )}
                              </TableCell>
                              <TableCell className="text-right space-x-2">
                                <Button variant="outline" size="sm" disabled={updatingId === order.id} onClick={() => handleStatus(order.id, 'paid')}>Mark Paid</Button>
                                <Button variant="outline" size="sm" disabled={updatingId === order.id} onClick={() => handleStatus(order.id, 'printed')}>Mark Printed</Button>
                                <Button variant="default" size="sm" disabled={updatingId === order.id} onClick={() => handleStatus(order.id, 'shipped')}>Mark Shipped</Button>
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

