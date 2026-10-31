'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useVendorApi, VENDOR_GATE_MESSAGE, type VendorApiError } from './components/use-vendor-api';
import { EmptyState } from './components/empty-state';

interface Balance {
  toDispatchCount: number;
  awaitingDeliveryCount: number;
  payablePkr: number;
  nextPayoutDate: string;
}

function formatNextPayout(iso: string): string {
  const d = new Date(`${iso}T00:00:00+05:00`);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Karachi',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(d);
}

export default function VendorHomePage() {
  const { get, user } = useVendorApi();
  const [balance, setBalance] = useState<Balance | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    get('/api/vendor/balance')
      .then(setBalance)
      .catch((e: VendorApiError) => setError(e.status === 403 ? VENDOR_GATE_MESSAGE : e.error));
  }, [get, user]);

  if (error) return <EmptyState title="Vendor account" body={error} />;
  if (!balance) return <p className="text-sm text-muted-foreground">Loading</p>;

  const cards = [
    { title: 'Orders to dispatch', value: String(balance.toDispatchCount) },
    { title: 'Awaiting delivery', value: String(balance.awaitingDeliveryCount) },
    { title: 'Payable balance', value: `PKR ${balance.payablePkr.toLocaleString('en-PK')}` },
    { title: 'Next payout day', value: formatNextPayout(balance.nextPayoutDate) },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {cards.map((c) => (
        <Card key={c.title}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{c.title}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold tabular-nums">{c.value}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
