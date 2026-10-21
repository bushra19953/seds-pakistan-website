'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { FINANCE_CATEGORIES } from '@/types/finance';
import { financeFetch, pkr, type FinanceUser } from './finance-api';

/**
 * Ledger workspace (spec Part C 5.5). Drafts are created and edited here.
 * Posting is a maker-checker request (ledger_post): hooks H1 (unbudgeted)
 * and H2 (over PKR 250,000) are shown on the row and require a decided
 * Founder Consent on the entry before a posting request will be accepted.
 * Posted entries expose only "Create reversal".
 */

interface Entry {
  id: string;
  date: string;
  type: 'income' | 'expense';
  category: string;
  amountPkr: number;
  counterparty: string;
  description: string;
  accountLabel: string;
  status: 'draft' | 'posted';
  unbudgeted: boolean;
  overThreshold: boolean;
  consentId: string | null;
  reversalOf: string | null;
  reversedBy: string | null;
}

const PAYMENT_METHODS = ['bank_transfer', 'raast', 'easypaisa', 'jazzcash', 'sadapay', 'cash', 'other'];

export function LedgerTable({ user }: { user: FinanceUser }) {
  const { toast } = useToast();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [form, setForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    type: 'expense' as 'income' | 'expense',
    category: 'operations',
    amountPkr: 0,
    counterparty: '',
    description: '',
    budgetLineId: '',
    consentId: '',
    paymentMethod: 'bank_transfer',
    accountLabel: '',
  });

  const load = useCallback(async () => {
    try {
      const data = await financeFetch<{ entries: Entry[] }>(user, '/api/admin/finance/ledger');
      setEntries(data.entries ?? []);
    } catch {
      /* best-effort */
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const createDraft = async () => {
    try {
      await financeFetch(user, '/api/admin/finance/ledger', {
        method: 'POST',
        body: {
          ...form,
          budgetLineId: form.budgetLineId || null,
          consentId: form.consentId || null,
        },
      });
      toast({ title: 'Draft entry created' });
      await load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Create failed', description: e instanceof Error ? e.message : undefined });
    }
  };

  const requestPosting = async (entry: Entry) => {
    try {
      await financeFetch(user, '/api/admin/finance/approvals', {
        method: 'POST',
        body: { targetType: 'ledger_post', targetId: entry.id, changePayload: { fromStatus: 'draft', toStatus: 'posted' } },
      });
      toast({ title: 'Posting requested', description: 'A checker posts the entry from the approvals queue.' });
    } catch (e) {
      toast({ variant: 'destructive', title: 'Request failed', description: e instanceof Error ? e.message : undefined });
    }
  };

  const createReversal = async (entry: Entry) => {
    const reason = window.prompt('Reason for reversing this posted entry (required):');
    if (!reason?.trim()) return;
    try {
      await financeFetch(user, '/api/admin/finance/ledger/reverse', {
        method: 'POST',
        body: { entryId: entry.id, reason: reason.trim(), date: new Date().toISOString().slice(0, 10) },
      });
      toast({ title: 'Reversal draft created', description: 'Post it through the approvals queue like any entry.' });
      await load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Reversal failed', description: e instanceof Error ? e.message : undefined });
    }
  };

  const deleteDraft = async (entry: Entry) => {
    try {
      await financeFetch(user, '/api/admin/finance/ledger', { method: 'DELETE', body: { id: entry.id } });
      toast({ title: 'Draft deleted' });
      await load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Delete failed', description: e instanceof Error ? e.message : undefined });
    }
  };

  return (
    <div className="space-y-6">
      <div className="border rounded-md p-3 space-y-3">
        <h3 className="font-semibold">New draft entry</h3>
        <div className="flex flex-wrap gap-2 items-end">
          <div><Label>Date</Label><Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></div>
          <div>
            <Label>Type</Label>
            <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v as 'income' | 'expense' })}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="income">Income</SelectItem>
                <SelectItem value="expense">Expense</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Category</Label>
            <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                {FINANCE_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div><Label>Amount (PKR)</Label><Input type="number" value={form.amountPkr} onChange={(e) => setForm({ ...form, amountPkr: Number(e.target.value || 0) })} className="w-32" /></div>
          <div><Label>Counterparty</Label><Input value={form.counterparty} onChange={(e) => setForm({ ...form, counterparty: e.target.value })} /></div>
          <div><Label>Account label</Label><Input value={form.accountLabel} onChange={(e) => setForm({ ...form, accountLabel: e.target.value })} /></div>
          <div><Label>Budget line id</Label><Input value={form.budgetLineId} onChange={(e) => setForm({ ...form, budgetLineId: e.target.value })} /></div>
          <div><Label>Consent id (H1/H2)</Label><Input value={form.consentId} onChange={(e) => setForm({ ...form, consentId: e.target.value })} /></div>
          <div>
            <Label>Payment method</Label>
            <Select value={form.paymentMethod} onValueChange={(v) => setForm({ ...form, paymentMethod: v })}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PAYMENT_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1 min-w-48"><Label>Description</Label><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
          <Button onClick={createDraft}>Create draft</Button>
        </div>
      </div>

      <div className="space-y-2">
        {entries.map((e) => (
          <div key={e.id} className="border rounded-md p-3 flex flex-wrap items-center gap-2">
            <Badge variant="outline">{e.status}</Badge>
            <span className="text-sm">{e.date}</span>
            <span className="text-sm">{e.type === 'income' ? '+' : '-'}{pkr(e.amountPkr)}</span>
            <span className="text-sm text-muted-foreground">{e.category} - {e.counterparty} - {e.description}</span>
            {e.unbudgeted && <Badge variant="destructive">Unbudgeted (H1)</Badge>}
            {e.overThreshold && <Badge variant="destructive">Over PKR 250,000 (H2)</Badge>}
            {(e.unbudgeted || e.overThreshold) && (
              <span className="text-xs text-muted-foreground">
                {e.consentId ? `Consent: ${e.consentId}` : 'No consent linked - posting will be refused'}
              </span>
            )}
            {e.reversalOf && <Badge variant="secondary">Reversal of {e.reversalOf.slice(0, 8)}</Badge>}
            {e.reversedBy && <Badge variant="secondary">Reversed</Badge>}
            <span className="flex-1" />
            {e.status === 'draft' && (
              <>
                <Button size="sm" onClick={() => requestPosting(e)}>Request posting</Button>
                <Button size="sm" variant="ghost" onClick={() => deleteDraft(e)}>Delete draft</Button>
              </>
            )}
            {e.status === 'posted' && !e.reversedBy && !e.reversalOf && (
              <Button size="sm" variant="outline" onClick={() => createReversal(e)}>Create reversal</Button>
            )}
          </div>
        ))}
        {entries.length === 0 && <p className="text-sm text-muted-foreground">No entries yet.</p>}
      </div>
    </div>
  );
}
