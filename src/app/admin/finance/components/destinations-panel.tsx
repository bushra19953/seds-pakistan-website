'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { financeFetch, type FinanceUser } from './finance-api';

/**
 * Payment destinations view (spec Part C 5.5, CH-10). Shows, per store,
 * the ACTIVE destination (read from the live settings document), when it
 * last changed and who approved it (destinationMeta), and any pending
 * proposal IN FULL. There is no edit-in-place: proposing a change sends
 * the complete proposed value set to the approvals flow.
 */

interface Destination {
  store: 'payment_methods' | 'pages_donate';
  label: string;
  active: Record<string, unknown> | null;
  destinationMeta: { lastChangedBy?: string; approvedBy?: string; approvalId?: string } | null;
  pending: { id: string; makerUid: string; changePayload: Record<string, unknown> } | null;
}

export function DestinationsPanel({ user }: { user: FinanceUser }) {
  const { toast } = useToast();
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const data = await financeFetch<{ destinations: Destination[] }>(user, '/api/admin/finance/destinations');
      setDestinations(data.destinations ?? []);
      setDrafts((prev) => {
        const next = { ...prev };
        for (const d of data.destinations ?? []) {
          if (next[d.store] === undefined) {
            next[d.store] = JSON.stringify(d.active ?? {}, null, 2);
          }
        }
        return next;
      });
    } catch {
      /* best-effort */
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const propose = async (dest: Destination) => {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(drafts[dest.store] || '{}') as Record<string, unknown>;
    } catch {
      toast({ variant: 'destructive', title: 'Invalid JSON', description: 'The proposed value set must be valid JSON.' });
      return;
    }
    const reason = window.prompt('Reason for this destination change (required):');
    if (!reason?.trim()) return;
    try {
      await financeFetch(user, '/api/admin/finance/approvals', {
        method: 'POST',
        body: { targetType: 'destination_change', targetId: dest.store, changePayload: payload, reason: reason.trim() },
      });
      toast({ title: 'Change proposed', description: 'Nothing is live until a checker approves it.' });
      await load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Proposal failed', description: e instanceof Error ? e.message : undefined });
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Payment destinations are dual-record controlled. The ACTIVE values below are what buyers and donors see right now.
      </p>
      {destinations.map((d) => (
        <div key={d.store} className="border rounded-md p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{d.label}</h3>
            <Badge variant="outline">{d.store}</Badge>
          </div>
          {d.destinationMeta ? (
            <p className="text-xs text-muted-foreground">
              Last changed by {d.destinationMeta.lastChangedBy ?? 'unknown'}, approved by{' '}
              {d.destinationMeta.approvedBy ?? 'unknown'} (approval {d.destinationMeta.approvalId ?? 'n/a'}).
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">No approved change recorded yet for this destination.</p>
          )}
          <div>
            <Label>Active destination (live)</Label>
            <pre className="text-xs bg-muted/40 rounded p-2 overflow-x-auto max-h-48">{JSON.stringify(d.active ?? {}, null, 2)}</pre>
          </div>
          {d.pending ? (
            <div>
              <Label>Pending proposal by {d.pending.makerUid} (not live)</Label>
              <pre className="text-xs bg-amber-500/10 border border-amber-500/30 rounded p-2 overflow-x-auto max-h-48">
                {JSON.stringify(d.pending.changePayload, null, 2)}
              </pre>
            </div>
          ) : (
            <div className="space-y-2">
              <Label>Propose new value set (complete JSON)</Label>
              <textarea
                className="w-full min-h-32 bg-transparent border rounded p-2 text-xs font-mono"
                value={drafts[d.store] ?? ''}
                onChange={(e) => setDrafts((prev) => ({ ...prev, [d.store]: e.target.value }))}
              />
              <Button size="sm" onClick={() => propose(d)}>Propose change (approvals flow)</Button>
            </div>
          )}
        </div>
      ))}
      {destinations.length === 0 && <p className="text-sm text-muted-foreground">No destination data available.</p>}
    </div>
  );
}
