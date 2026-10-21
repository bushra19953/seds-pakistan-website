'use client';
// Route per ws-a section 5: /admin/governance. The decision register
// read surface: one append-only entry per decision, void entries
// struck through with their retroactive effective date visible.
// Nothing on this page can create, edit, or delete an entry.
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import type { PermissionKey } from '@/config/permissions.config';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

type Entry = {
  id: string; bodyId: string; decisionClassId: string; source: string; sourceId: string;
  text: string; outcome: string; status: string; decidedAt: string | null;
  voidEffectiveFrom: string | null;
  votingSummary?: { votesFor: number; votesAgainst: number; abstentions: number } | null;
};

async function call(path: string, token: string): Promise<any> {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}

export default function AdminGovernanceRegisterPage() {
  return <AuthorizationGate permission={'canViewGovernance' as PermissionKey}><Inner /></AuthorizationGate>;
}

function Inner() {
  const { user } = useUser();
  const search = useSearchParams();
  const focusId = search?.get('id') ?? '';
  const [rows, setRows] = useState<Entry[]>([]);
  const [bodyFilter, setBodyFilter] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const token = await user.getIdToken();
      const q = bodyFilter ? `?bodyId=${encodeURIComponent(bodyFilter)}` : '';
      const data = await call(`/api/governance/decisions${q}`, token);
      setRows((data.decisions ?? []) as Entry[]);
    } catch (e: any) { setMsg(e?.message ?? 'Could not load the register.'); }
  }, [user, bodyFilter]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-semibold">Decision Register</h1>
      <p className="text-sm text-muted-foreground">Every decision the platform records: motions, circular resolutions, urgent decisions, consents, overrides and reversals. Entries are never edited or deleted; a voided entry stays visible with its retroactive date.</p>
      {msg ? <p className="text-sm text-red-600">{msg}</p> : null}
      <Input value={bodyFilter} onChange={(e) => setBodyFilter(e.target.value)} placeholder="Filter by body ID" />
      <Card><CardHeader><CardTitle>Entries ({rows.length})</CardTitle></CardHeader><CardContent>
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">No entries.</p> : rows.map((e) => (
          <div key={e.id} className={`space-y-1 border-b py-3 text-sm ${focusId === e.id ? 'bg-amber-50 px-2' : ''} ${e.status === 'void' ? 'opacity-70' : ''}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`font-medium ${e.status === 'void' ? 'line-through' : ''}`}>{e.text}</span>
              <Badge variant="outline">{e.source}</Badge>
              <Badge variant="outline">{e.outcome}</Badge>
              <Badge variant={e.status === 'void' ? 'destructive' : 'outline'}>{e.status}</Badge>
            </div>
            <div className="text-xs text-muted-foreground">
              Body {e.bodyId} · Class {e.decisionClassId} · Decided {e.decidedAt ? new Date(e.decidedAt).toLocaleString() : '-'}
              {e.votingSummary ? ` · For ${e.votingSummary.votesFor}, against ${e.votingSummary.votesAgainst}, abstentions ${e.votingSummary.abstentions}` : ''}
              {e.status === 'void' && e.voidEffectiveFrom ? ` · Void effective from ${new Date(e.voidEffectiveFrom).toLocaleString()}` : ''}
            </div>
          </div>
        ))}
      </CardContent></Card>
    </div>
  );
}
