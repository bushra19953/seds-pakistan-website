'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useVendorApi, VENDOR_GATE_MESSAGE, type VendorApiError } from '../components/use-vendor-api';
import { EmptyState } from '../components/empty-state';
import { PayoutStatusBadge } from '../components/status-badge';

interface Payout {
  id: string;
  periodStart: string;
  periodEnd: string;
  grossPkr: number;
  commissionPkr: number;
  netPkr: number;
  status: string;
  transferredAt: string | null;
}

interface Balance {
  accruedPkr: number;
  payablePkr: number;
  paidPkr: number;
  heldDisputePkr: number;
  heldDisputeCount: number;
  payouts: Payout[];
}

export default function VendorBalancePage() {
  const { get, user } = useVendorApi();
  const [balance, setBalance] = useState<Balance | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    get('/api/vendor/balance')
      .then(setBalance)
      .catch((e: VendorApiError) => setError(e.status === 403 ? VENDOR_GATE_MESSAGE : e.error));
  }, [get, user]);

  if (error) return <EmptyState title="Balance" body={error} />;
  if (!balance) return <p className="text-sm text-muted-foreground">Loading</p>;

  const cards = [
    { title: 'Accrued', value: balance.accruedPkr },
    { title: 'Payable', value: balance.payablePkr },
    { title: 'Paid', value: balance.paidPkr },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Balance</h1>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {cards.map((c) => (
          <Card key={c.title}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{c.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold tabular-nums">PKR {c.value.toLocaleString('en-PK')}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      {balance.heldDisputeCount > 0 && (
        <Card>
          <CardContent className="py-4 text-sm">
            On hold for a return claim: PKR {balance.heldDisputePkr.toLocaleString('en-PK')} across {balance.heldDisputeCount}{' '}
            order(s). Held amounts join a payout after the claim closes.
          </CardContent>
        </Card>
      )}
      <h2 className="text-lg font-semibold">Payout history</h2>
      {balance.payouts.length === 0 ? (
        <EmptyState title="No payouts yet" body="Your first weekly payout will appear here after it is drafted." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Period</TableHead>
              <TableHead className="text-right">Gross</TableHead>
              <TableHead className="text-right">Commission</TableHead>
              <TableHead className="text-right">Net</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Transferred</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {balance.payouts.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  {p.periodStart} to {p.periodEnd}
                </TableCell>
                <TableCell className="text-right tabular-nums">PKR {p.grossPkr.toLocaleString('en-PK')}</TableCell>
                <TableCell className="text-right tabular-nums">PKR {p.commissionPkr.toLocaleString('en-PK')}</TableCell>
                <TableCell className="text-right tabular-nums">PKR {p.netPkr.toLocaleString('en-PK')}</TableCell>
                <TableCell>
                  <PayoutStatusBadge status={p.status} />
                </TableCell>
                <TableCell>{p.transferredAt ? new Date(p.transferredAt).toLocaleDateString('en-GB') : ''}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
