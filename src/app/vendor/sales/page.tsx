'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useVendorApi, VENDOR_GATE_MESSAGE, type VendorApiError } from '../components/use-vendor-api';
import { EmptyState } from '../components/empty-state';
import { LedgerStateBadge } from '../components/status-badge';

interface SalesRow {
  id: string;
  orderId: string;
  productName: string | null;
  salePricePkr: number;
  commissionPkr: number;
  vendorDuePkr: number;
  commissionRate: number | null;
  state: string;
  createdAt: string | null;
}

export default function VendorSalesPage() {
  const { get, user } = useVendorApi();
  const [rows, setRows] = useState<SalesRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      const d = await get(`/api/vendor/sales${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      setRows((prev) => (cursor && prev ? [...prev, ...d.rows] : d.rows));
      setNextCursor(d.hasMore ? d.nextCursor : null);
    },
    [get],
  );

  useEffect(() => {
    if (!user) return;
    load().catch((e: VendorApiError) => setError(e.status === 403 ? VENDOR_GATE_MESSAGE : e.error));
  }, [load, user]);

  if (error) return <EmptyState title="Sales" body={error} />;
  if (!rows) return <p className="text-sm text-muted-foreground">Loading</p>;
  if (rows.length === 0) {
    return <EmptyState title="No sales yet" body="Once an order is verified, its sale and commission appear here." />;
  }

  const ratePct = rows[0].commissionRate != null ? Math.round(rows[0].commissionRate * 100) : null;

  return (
    <div className="space-y-3">
      <h1 className="text-xl font-bold">Sales</h1>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Product</TableHead>
            <TableHead className="text-right">Sale price</TableHead>
            <TableHead className="text-right">Commission</TableHead>
            <TableHead className="text-right">You receive</TableHead>
            <TableHead>State</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell>{r.createdAt ? new Date(r.createdAt).toLocaleDateString('en-GB') : ''}</TableCell>
              <TableCell>{r.productName ?? (r.orderId ? r.orderId.slice(0, 8) : '')}</TableCell>
              <TableCell className="text-right tabular-nums">PKR {(r.salePricePkr ?? 0).toLocaleString('en-PK')}</TableCell>
              <TableCell className="text-right tabular-nums">PKR {(r.commissionPkr ?? 0).toLocaleString('en-PK')}</TableCell>
              <TableCell className="text-right tabular-nums">PKR {(r.vendorDuePkr ?? 0).toLocaleString('en-PK')}</TableCell>
              <TableCell>
                <LedgerStateBadge state={r.state} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {ratePct != null && (
        <p className="text-sm text-muted-foreground">
          Commission is {ratePct}% of the product price. Delivery charges are not commissioned.
        </p>
      )}
      {nextCursor && (
        <Button variant="outline" onClick={() => load(nextCursor).catch(() => undefined)}>
          Load more
        </Button>
      )}
    </div>
  );
}
