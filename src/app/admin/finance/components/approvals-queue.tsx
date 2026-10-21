'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { financeFetch, type FinanceUser } from './finance-api';

/**
 * Maker-checker approvals queue (spec Part C 5.5). Lists requests the
 * signed-in user can check and requests they made. The Approve button is
 * disabled on the user's OWN requests with the explanation rendered -
 * maker != checker is a property of the queue, not a 422 discovered
 * after the fact (the API enforces it regardless). Rejection requires a
 * note. The full changePayload is shown for destination changes.
 */

interface Approval {
  id: string;
  targetType: string;
  targetId: string;
  status: string;
  makerUid: string;
  reason?: string | null;
  changePayload?: Record<string, unknown>;
  createdAt?: unknown;
  expiresAt?: unknown;
}

export function ApprovalsQueue({ user }: { user: FinanceUser }) {
  const { toast } = useToast();
  const [checkable, setCheckable] = useState<Approval[]>([]);
  const [mine, setMine] = useState<Approval[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([
        financeFetch<{ approvals: Approval[] }>(user, '/api/admin/finance/approvals?scope=checkable'),
        financeFetch<{ approvals: Approval[] }>(user, '/api/admin/finance/approvals?scope=mine'),
      ]);
      setCheckable(a.approvals ?? []);
      setMine(b.approvals ?? []);
    } catch {
      /* queue is best-effort refreshed */
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const decide = async (approval: Approval, decision: 'approve' | 'reject') => {
    let note: string | undefined;
    if (decision === 'reject') {
      const entered = window.prompt('Rejection note (required):');
      if (!entered || !entered.trim()) {
        toast({ variant: 'destructive', title: 'Note required', description: 'Rejections must carry a note for the maker.' });
        return;
      }
      note = entered.trim();
    }
    setBusy(approval.id);
    try {
      await financeFetch(user, '/api/admin/finance/approvals/decide', {
        method: 'POST',
        body: { approvalId: approval.id, decision, note },
      });
      toast({ title: decision === 'approve' ? 'Approved and applied' : 'Rejected' });
      await load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Decision failed', description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(null);
    }
  };

  const renderRow = (a: Approval, showActions: boolean) => {
    const isOwn = a.makerUid === user.uid;
    return (
      <div key={a.id} className="border rounded-md p-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{a.targetType}</Badge>
          <span className="font-mono text-xs">{a.targetId}</span>
          <Badge variant={a.status === 'pending' ? 'secondary' : 'default'}>{a.status}</Badge>
          {a.reason && <span className="text-xs text-muted-foreground">Reason: {a.reason}</span>}
        </div>
        {a.targetType === 'destination_change' && a.changePayload && (
          <pre className="text-xs bg-muted/40 rounded p-2 overflow-x-auto max-h-40">
            {JSON.stringify(a.changePayload, null, 2)}
          </pre>
        )}
        {showActions && a.status === 'pending' && (
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={busy === a.id || isOwn} onClick={() => decide(a, 'approve')}>
              Approve
            </Button>
            <Button size="sm" variant="outline" disabled={busy === a.id || isOwn} onClick={() => decide(a, 'reject')}>
              Reject
            </Button>
            {isOwn && <span className="text-xs text-muted-foreground">You made this request - a checker must decide it.</span>}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold mb-2">Awaiting your check</h3>
        {checkable.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing waiting.</p>
        ) : (
          <div className="space-y-2">{checkable.map((a) => renderRow(a, true))}</div>
        )}
      </div>
      <div>
        <h3 className="font-semibold mb-2">Your requests</h3>
        {mine.length === 0 ? (
          <p className="text-sm text-muted-foreground">You have no requests yet.</p>
        ) : (
          <div className="space-y-2">{mine.map((a) => renderRow(a, true))}</div>
        )}
      </div>
    </div>
  );
}
