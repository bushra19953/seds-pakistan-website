'use client';
// Route per ws-a section 5: /admin/urgent-decisions. President urgent
// decisions with both live countdowns: Board notification confirmation
// (24h, then Founder escalation) and ratification (30 days, then the
// decision voids RETROACTIVELY and everyone is told). Nothing here can
// delete a record.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import type { PermissionKey } from '@/config/permissions.config';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

type UrgentRow = {
  id: string; title: string; harmStatement: string; status: string;
  createdAtMs: number; notificationDueAtMs: number; ratificationDueAtMs: number;
  escalatedToFounderAtMs: number | null; decisionId: string;
  ratificationDecisionId: string | null; voidReason: string | null;
};

async function call(path: string, token: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}

function countdown(ms: number, now: number): string {
  const left = ms - now;
  if (left <= 0) return 'expired';
  const d = Math.floor(left / 86400000); const h = Math.floor((left % 86400000) / 3600000);
  return `${d}d ${h}h left`;
}

export default function AdminUrgentDecisionsPage() {
  return <AuthorizationGate permission={'canViewGovernance' as PermissionKey}><Inner /></AuthorizationGate>;
}

function Inner() {
  const { user } = useUser();
  const [rows, setRows] = useState<UrgentRow[]>([]);
  const [msg, setMsg] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const token = await user.getIdToken();
      const data = await call('/api/governance/urgent-decisions', token);
      setRows((data.decisions ?? []) as UrgentRow[]);
    } catch (e: any) { setMsg(e?.message ?? 'Could not load urgent decisions.'); }
  }, [user, tick]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(t); }, []);

  async function confirm(id: string) {
    if (!user) return; setMsg('');
    try {
      const token = await user.getIdToken();
      await call(`/api/governance/urgent-decisions/${id}/confirm-notification`, token, { method: 'POST', body: '{}' });
      setTick((v) => v + 1);
    } catch (e: any) { setMsg(e?.message ?? 'Confirmation failed.'); }
  }

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-semibold">Urgent Decisions</h1>
      <p className="text-sm text-muted-foreground">Taken by the National President alone under the urgent-decision rule. Each one must be ratified by its body within 30 days or it voids retroactively. Submitting a new urgent decision is done by the President account; a Reserved Matter can never be taken this way.</p>
      {msg ? <p className="text-sm text-red-600">{msg}</p> : null}
      <Card><CardHeader><CardTitle>Decisions ({rows.length})</CardTitle></CardHeader><CardContent>
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">None recorded.</p> : rows.map((r) => (
          <div key={r.id} className="space-y-1 border-b py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{r.title}</span>
              <Badge variant={r.status === 'void_retroactive' ? 'destructive' : 'outline'}>{r.status}</Badge>
              {r.escalatedToFounderAtMs ? <Badge className="bg-amber-500">Escalated to Founder</Badge> : null}
            </div>
            <p className="text-muted-foreground">Harm addressed: {r.harmStatement}</p>
            {r.status === 'notified_pending_confirmation' ? <p>Board notification confirmation: <strong>{countdown(r.notificationDueAtMs, now)}</strong> <Button size="sm" className="ml-2" onClick={() => void confirm(r.id)}>Confirm Board notified</Button></p> : null}
            {(r.status === 'notified_pending_confirmation' || r.status === 'active_pending_ratification') ? <p>Ratification deadline: <strong>{countdown(r.ratificationDueAtMs, now)}</strong></p> : null}
            {r.status === 'ratified' ? <p>Ratified. <Link className="underline" href={`/admin/governance?id=${r.decisionId}`}>Register entry</Link></p> : null}
            {r.status === 'void_retroactive' ? <p className="text-red-700">Void retroactively ({r.voidReason}). The register entry is marked void effective from {new Date(r.createdAtMs).toLocaleString()}.</p> : null}
          </div>
        ))}
      </CardContent></Card>
    </div>
  );
}
