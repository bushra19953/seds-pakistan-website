'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { financeFetch, pkr, type FinanceUser } from './finance-api';

/**
 * Monthly bank reconciliation (spec Part C 5.5). The form shows a LIVE
 * preview of the ledger balance (posted entries in the month) so the
 * difference is visible before completing. Completion is the checker
 * step: it is done by a DIFFERENT officer than the one who prepared the
 * record (checkedBy != reconciledBy), and the server recomputes the
 * ledger balance at completion regardless of the preview.
 */

interface Reconciliation {
  id: string;
  accountLabel: string;
  periodMonth: string;
  openingBalancePkr: number;
  closingBalancePkr: number | null;
  ledgerBalancePkr: number | null;
  differencePkr: number | null;
  differenceExplanation: string | null;
  statementDriveId: string | null;
  status: 'draft' | 'completed';
  reconciledBy: string;
  checkedBy: string | null;
}

interface LedgerEntryLite {
  accountLabel: string;
  date: string;
  type: 'income' | 'expense';
  amountPkr: number;
  status: string;
}

export function ReconciliationForm({ user }: { user: FinanceUser }) {
  const { toast } = useToast();
  const [recs, setRecs] = useState<Reconciliation[]>([]);
  const [entries, setEntries] = useState<LedgerEntryLite[]>([]);
  const [form, setForm] = useState({
    accountLabel: '',
    periodMonth: new Date().toISOString().slice(0, 7),
    openingBalancePkr: 0,
    closingBalancePkr: 0,
  });

  const load = useCallback(async () => {
    try {
      const [r, l] = await Promise.all([
        financeFetch<{ reconciliations: Reconciliation[] }>(user, '/api/admin/finance/reconciliations'),
        financeFetch<{ entries: LedgerEntryLite[] }>(user, '/api/admin/finance/ledger?status=posted'),
      ]);
      setRecs(r.reconciliations ?? []);
      setEntries(l.entries ?? []);
    } catch {
      /* best-effort */
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const previewBalance = useMemo(() => {
    let bal = form.openingBalancePkr;
    for (const e of entries) {
      if (e.accountLabel !== form.accountLabel) continue;
      if (!e.date.startsWith(form.periodMonth)) continue;
      bal += e.type === 'income' ? e.amountPkr : -e.amountPkr;
    }
    return bal;
  }, [entries, form]);

  const create = async () => {
    try {
      const created = await financeFetch<{ id: string }>(user, '/api/admin/finance/reconciliations', {
        method: 'POST',
        body: { accountLabel: form.accountLabel, periodMonth: form.periodMonth, openingBalancePkr: form.openingBalancePkr },
      });
      // The closing (statement) balance is a statement-side field set on the draft.
      if (form.closingBalancePkr) {
        await financeFetch(user, '/api/admin/finance/reconciliations', {
          method: 'PUT',
          body: { id: created.id, closingBalancePkr: form.closingBalancePkr },
        });
      }
      toast({ title: 'Reconciliation draft created' });
      await load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Create failed', description: e instanceof Error ? e.message : undefined });
    }
  };

  const update = async (rec: Reconciliation, fields: Partial<Reconciliation>) => {
    try {
      await financeFetch(user, '/api/admin/finance/reconciliations', { method: 'PUT', body: { id: rec.id, ...fields } });
      await load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Update failed', description: e instanceof Error ? e.message : undefined });
    }
  };

  const complete = async (rec: Reconciliation) => {
    try {
      const data = await financeFetch<{ differencePkr: number }>(user, '/api/admin/finance/reconciliations/complete', {
        method: 'POST',
        body: { id: rec.id },
      });
      toast({ title: 'Reconciliation completed', description: `Difference: ${pkr(data.differencePkr)}` });
      await load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Completion failed', description: e instanceof Error ? e.message : undefined });
    }
  };

  return (
    <div className="space-y-6">
      <div className="border rounded-md p-3 space-y-3">
        <h3 className="font-semibold">New monthly reconciliation</h3>
        <div className="flex flex-wrap gap-2 items-end">
          <div><Label>Account label</Label><Input value={form.accountLabel} onChange={(e) => setForm({ ...form, accountLabel: e.target.value })} /></div>
          <div><Label>Month</Label><Input type="month" value={form.periodMonth} onChange={(e) => setForm({ ...form, periodMonth: e.target.value })} /></div>
          <div><Label>Opening balance (PKR)</Label><Input type="number" value={form.openingBalancePkr} onChange={(e) => setForm({ ...form, openingBalancePkr: Number(e.target.value || 0) })} className="w-36" /></div>
          <div><Label>Closing balance per statement (PKR)</Label><Input type="number" value={form.closingBalancePkr} onChange={(e) => setForm({ ...form, closingBalancePkr: Number(e.target.value || 0) })} className="w-36" /></div>
          <Button onClick={create}>Create draft</Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Live preview - ledger balance for this account and month: <strong>{pkr(previewBalance)}</strong>
          {' '}(difference vs statement: {pkr(form.closingBalancePkr - previewBalance)})
        </p>
      </div>

      <div className="space-y-2">
        {recs.map((rec) => (
          <div key={rec.id} className="border rounded-md p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm">{rec.id}</span>
              <Badge variant="outline">{rec.status}</Badge>
              <span className="text-sm">Closing (statement): {rec.closingBalancePkr != null ? pkr(rec.closingBalancePkr) : 'not set'}</span>
              {rec.ledgerBalancePkr != null && <span className="text-sm">Ledger: {pkr(rec.ledgerBalancePkr)}</span>}
              {rec.differencePkr != null && (
                <span className="text-sm">Difference: {pkr(rec.differencePkr)}</span>
              )}
              {rec.checkedBy && <span className="text-xs text-muted-foreground">Checked by {rec.checkedBy}</span>}
            </div>
            {rec.status === 'draft' && (
              <div className="flex flex-wrap gap-2 items-end">
                <div>
                  <Label>Closing balance (PKR)</Label>
                  <Input type="number" defaultValue={rec.closingBalancePkr ?? 0} onBlur={(e) => update(rec, { closingBalancePkr: Number(e.target.value || 0) })} />
                </div>
                <div>
                  <Label>Statement Drive ID</Label>
                  <Input defaultValue={rec.statementDriveId ?? ''} onBlur={(e) => update(rec, { statementDriveId: e.target.value })} />
                </div>
                <div className="flex-1 min-w-48">
                  <Label>Difference explanation (required when difference is nonzero)</Label>
                  <Input defaultValue={rec.differenceExplanation ?? ''} onBlur={(e) => update(rec, { differenceExplanation: e.target.value })} />
                </div>
                <Button size="sm" disabled={rec.reconciledBy === user.uid} onClick={() => complete(rec)}>
                  {rec.reconciledBy === user.uid ? 'Prepared by you - another officer completes it' : 'Complete reconciliation'}
                </Button>
              </div>
            )}
          </div>
        ))}
        {recs.length === 0 && <p className="text-sm text-muted-foreground">No reconciliations yet.</p>}
      </div>
    </div>
  );
}
