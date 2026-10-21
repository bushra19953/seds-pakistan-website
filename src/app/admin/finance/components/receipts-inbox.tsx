'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { financeFetch, pkr, type FinanceUser } from './finance-api';

/**
 * Receipts inbox (spec Part C 5.5). Officers log their own expense
 * receipts; delivery to the Treasurer must happen within 14 days of the
 * transaction. Breaches are shown in red, never hidden. Delivery is
 * stamped by Finance, and the spending officer cannot stamp their own.
 */

interface Receipt {
  id: string;
  officerUid: string;
  kind: 'officer_expense' | 'inbound_payment';
  transactionDate: string;
  amountPkr: number;
  description: string;
  receiptDriveId: string;
  receiptUrl: string;
  deliveredToTreasurerAt: unknown;
  slaBreached: boolean;
  daysRemaining: number | null;
}

type Tab = 'all' | 'outstanding' | 'breached';

export function ReceiptsInbox({ user }: { user: FinanceUser }) {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('all');
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [form, setForm] = useState({ transactionDate: new Date().toISOString().slice(0, 10), amountPkr: 0, description: '', receiptDriveId: '' });

  const load = useCallback(async () => {
    try {
      const qs = tab === 'all' ? '' : `?sla=${tab}`;
      const data = await financeFetch<{ receipts: Receipt[] }>(user, `/api/admin/finance/receipts${qs}`);
      setReceipts(data.receipts ?? []);
    } catch {
      /* best-effort */
    }
  }, [user, tab]);

  useEffect(() => {
    load();
  }, [load]);

  const log = async () => {
    try {
      await financeFetch(user, '/api/admin/finance/receipts', {
        method: 'POST',
        body: { kind: 'officer_expense', ...form },
      });
      toast({ title: 'Receipt logged', description: 'Deliver it to the Treasurer within 14 days of the transaction.' });
      await load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Log failed', description: e instanceof Error ? e.message : undefined });
    }
  };

  const deliver = async (receipt: Receipt) => {
    try {
      await financeFetch(user, '/api/admin/finance/receipts/deliver', { method: 'POST', body: { id: receipt.id } });
      toast({ title: 'Delivery stamped' });
      await load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Stamp failed', description: e instanceof Error ? e.message : undefined });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {(['all', 'outstanding', 'breached'] as Tab[]).map((t) => (
          <Button key={t} size="sm" variant={tab === t ? 'default' : 'outline'} onClick={() => setTab(t)}>
            {t === 'all' ? 'All' : t === 'outstanding' ? 'Outstanding' : 'SLA breached'}
          </Button>
        ))}
      </div>

      <div className="border rounded-md p-3 space-y-3">
        <h3 className="font-semibold">Log an expense receipt</h3>
        <div className="flex flex-wrap gap-2 items-end">
          <div><Label>Transaction date</Label><Input type="date" value={form.transactionDate} onChange={(e) => setForm({ ...form, transactionDate: e.target.value })} /></div>
          <div><Label>Amount (PKR)</Label><Input type="number" value={form.amountPkr} onChange={(e) => setForm({ ...form, amountPkr: Number(e.target.value || 0) })} className="w-32" /></div>
          <div className="flex-1 min-w-48"><Label>Description</Label><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
          <div><Label>Receipt Drive ID</Label><Input value={form.receiptDriveId} onChange={(e) => setForm({ ...form, receiptDriveId: e.target.value })} /></div>
          <Button onClick={log}>Log receipt</Button>
        </div>
      </div>

      <div className="space-y-2">
        {receipts.map((r) => (
          <div key={r.id} className="border rounded-md p-3 flex flex-wrap items-center gap-2">
            <Badge variant="outline">{r.kind}</Badge>
            <span className="text-sm">{r.transactionDate}</span>
            <span className="text-sm">{pkr(r.amountPkr)}</span>
            <span className="text-sm text-muted-foreground">{r.description}</span>
            {r.deliveredToTreasurerAt ? (
              <Badge>Delivered</Badge>
            ) : r.slaBreached ? (
              <Badge variant="destructive">SLA breached ({Math.abs(r.daysRemaining ?? 0)} days over)</Badge>
            ) : (
              <Badge variant="secondary">{r.daysRemaining} days left to deliver</Badge>
            )}
            <span className="flex-1" />
            {!r.deliveredToTreasurerAt && (
              <Button size="sm" variant="outline" disabled={r.kind === 'officer_expense' && r.officerUid === user.uid} onClick={() => deliver(r)}>
                {r.kind === 'officer_expense' && r.officerUid === user.uid ? 'Your receipt - Finance stamps delivery' : 'Stamp delivered'}
              </Button>
            )}
          </div>
        ))}
        {receipts.length === 0 && <p className="text-sm text-muted-foreground">No receipts in this view.</p>}
      </div>
    </div>
  );
}
