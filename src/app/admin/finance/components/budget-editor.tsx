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
 * Budget editor (spec Part C 5.5). Drafts are created and edited here;
 * approval is a maker-checker request (budget_approve). Actuals shown are
 * computed server-side from posted ledger entries only.
 */

interface BudgetLine {
  lineId: string;
  category: string;
  label: string;
  allocatedPkr: number;
}

interface Budget {
  id: string;
  fyLabel: string;
  status: string;
  revision: number;
  totalAllocatedPkr: number;
  consentPending?: boolean;
  lines: BudgetLine[];
  computedActuals?: Record<string, { incomePkr: number; expensePkr: number }>;
}

interface Account {
  label: string;
  slug: string;
  type: 'bank' | 'wallet';
  openingBalancePkr?: number;
}

export function BudgetEditor({ user }: { user: FinanceUser }) {
  const { toast } = useToast();
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [fyLabel, setFyLabel] = useState('fy2026-27');
  const [lines, setLines] = useState<BudgetLine[]>([
    { lineId: 'line-1', category: 'operations', label: '', allocatedPkr: 0 },
  ]);
  const [accountDraft, setAccountDraft] = useState('');

  const load = useCallback(async () => {
    try {
      const [b, a] = await Promise.all([
        financeFetch<{ budgets: Budget[] }>(user, '/api/admin/finance/budgets'),
        financeFetch<{ accounts: Account[] }>(user, '/api/admin/finance/budgets?resource=accounts'),
      ]);
      setBudgets(b.budgets ?? []);
      setAccounts(a.accounts ?? []);
    } catch {
      /* best-effort */
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const createDraft = async () => {
    try {
      const fyStartYear = Number(fyLabel.slice(2, 6));
      await financeFetch(user, '/api/admin/finance/budgets', {
        method: 'POST',
        body: {
          fyLabel,
          fyStart: `${fyStartYear}-07-01`,
          fyEnd: `${fyStartYear + 1}-06-30`,
          lines: lines.filter((l) => l.label.trim()),
        },
      });
      toast({ title: 'Draft budget created' });
      await load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Create failed', description: e instanceof Error ? e.message : undefined });
    }
  };

  const requestApproval = async (budget: Budget) => {
    try {
      await financeFetch(user, '/api/admin/finance/approvals', {
        method: 'POST',
        body: {
          targetType: 'budget_approve',
          targetId: budget.id,
          changePayload: { fromStatus: 'draft', toStatus: 'approved', revision: budget.revision },
        },
      });
      toast({ title: 'Approval requested', description: 'A checker approves the budget in the approvals queue.' });
    } catch (e) {
      toast({ variant: 'destructive', title: 'Request failed', description: e instanceof Error ? e.message : undefined });
    }
  };

  const saveAccounts = async () => {
    try {
      const parsed = JSON.parse(accountDraft) as Account[];
      await financeFetch(user, '/api/admin/finance/budgets?resource=accounts', { method: 'PUT', body: { accounts: parsed } });
      toast({ title: 'Accounts saved' });
      await load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Save failed', description: e instanceof Error ? e.message : 'Accounts must be a JSON array of {label, slug, type, openingBalancePkr}' });
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3 border rounded-md p-3">
        <h3 className="font-semibold">New draft budget</h3>
        <div className="flex items-end gap-2">
          <div>
            <Label>Financial year</Label>
            <Input value={fyLabel} onChange={(e) => setFyLabel(e.target.value)} className="w-32" />
          </div>
          <Button onClick={createDraft}>Create draft</Button>
        </div>
        <div className="space-y-2">
          {lines.map((line, i) => (
            <div key={line.lineId} className="flex flex-wrap items-end gap-2">
              <div>
                <Label>Line id</Label>
                <Input
                  value={line.lineId}
                  onChange={(e) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, lineId: e.target.value } : l)))}
                  className="w-36"
                />
              </div>
              <div>
                <Label>Category</Label>
                <Select
                  value={line.category}
                  onValueChange={(v) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, category: v } : l)))}
                >
                  <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {FINANCE_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex-1 min-w-40">
                <Label>Label</Label>
                <Input
                  value={line.label}
                  onChange={(e) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, label: e.target.value } : l)))}
                />
              </div>
              <div>
                <Label>Allocated (PKR)</Label>
                <Input
                  type="number"
                  value={line.allocatedPkr}
                  onChange={(e) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, allocatedPkr: Number(e.target.value || 0) } : l)))}
                  className="w-36"
                />
              </div>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLines((ls) => [...ls, { lineId: `line-${ls.length + 1}`, category: 'operations', label: '', allocatedPkr: 0 }])}
          >
            Add line
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        {budgets.map((b) => (
          <div key={b.id} className="border rounded-md p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm">{b.id}</span>
              <Badge variant="outline">{b.status}</Badge>
              <span className="text-sm">Total allocated: {pkr(b.totalAllocatedPkr)}</span>
              {b.consentPending && (
                <Badge variant="destructive">Interim approval - Founder Consent pending</Badge>
              )}
              {b.status === 'draft' && (
                <Button size="sm" onClick={() => requestApproval(b)}>Request approval</Button>
              )}
            </div>
            <div className="text-xs space-y-1">
              {b.lines.map((l) => {
                const actual = b.computedActuals?.[l.lineId];
                const actualTotal = actual ? actual.incomePkr + actual.expensePkr : 0;
                return (
                  <div key={l.lineId} className="flex justify-between gap-4">
                    <span>{l.label} ({l.category})</span>
                    <span>
                      {pkr(l.allocatedPkr)} allocated - {pkr(actualTotal)} actual (posted only)
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-2 border rounded-md p-3">
        <h3 className="font-semibold">Bank and wallet accounts (labels)</h3>
        <p className="text-xs text-muted-foreground">
          Current: {accounts.map((a) => `${a.label} (${a.type})`).join(', ') || 'none recorded'}.
          Accounts are labels for reconciliation, not payment destinations.
        </p>
        <textarea
          className="w-full min-h-24 bg-transparent border rounded p-2 text-sm font-mono"
          placeholder='[{"label":"Main Bank","slug":"main-bank","type":"bank","openingBalancePkr":0}]'
          value={accountDraft}
          onChange={(e) => setAccountDraft(e.target.value)}
        />
        <Button variant="outline" onClick={saveAccounts}>Save accounts</Button>
      </div>
    </div>
  );
}
