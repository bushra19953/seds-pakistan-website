'use client';
// Route per ws-a section 5: /admin/minutes. Four queues: auto-drafted
// awaiting edit, circulated awaiting approval, circulation overdue
// (red), and signed/locked with the Drive link + retention date.
// Edits happen inline as supplementary notes only; the generated
// sec 3.5 fields are never editable here (the API refuses them).
import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import type { PermissionKey } from '@/config/permissions.config';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { meetingsAdapter } from '@/lib/governance/meetings-adapter';

type MinutesRow = {
  id: string; meetingId: string; bodyId: string; status: string;
  circulationDueAt?: string; circulationOverdue?: boolean;
  retentionUntil?: string | null;
  pdf?: { driveLink?: string; fileName?: string; sha256?: string } | null;
};

async function call(path: string, token: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}

export default function AdminMinutesPage() {
  return <AuthorizationGate permission={'canViewGovernance' as PermissionKey}><Inner /></AuthorizationGate>;
}

function Inner() {
  const { user } = useUser();
  const [rows, setRows] = useState<MinutesRow[]>([]);
  const [msg, setMsg] = useState('');
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const token = await user.getIdToken();
      const data = await call('/api/governance/minutes', token);
      setRows((data.minutes ?? []) as MinutesRow[]);
    } catch (e: any) { setMsg(e?.message ?? 'Could not load minutes.'); }
  }, [user, tick]);
  useEffect(() => { void load(); }, [load]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setMsg('');
    try { await fn(); setTick((v) => v + 1); setMsg(ok); } catch (e: any) { setMsg(e?.message ?? 'Action failed.'); }
  }

  const awaitingEdit = rows.filter((r) => r.status === 'auto_drafted' || r.status === 'in_edit');
  const awaitingApproval = rows.filter((r) => r.status === 'circulated');
  const overdue = rows.filter((r) => r.circulationOverdue && (r.status === 'auto_drafted' || r.status === 'in_edit'));
  const signed = rows.filter((r) => r.status === 'signed_locked');

  function Row({ r, children }: { r: MinutesRow; children?: React.ReactNode }) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 border-b py-2 text-sm">
        <div>
          <span className="font-medium">{r.meetingId}</span>{' '}
          <Badge variant="outline">{r.status}</Badge>
          {r.circulationOverdue ? <Badge className="ml-2 bg-red-600">Circulation overdue</Badge> : null}
          <div className="text-xs text-muted-foreground">Body {r.bodyId} · Minutes {r.id}</div>
        </div>
        <div className="flex gap-2">{children}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-semibold">Minutes</h1>
      {msg ? <p className="text-sm">{msg}</p> : null}

      <Card><CardHeader><CardTitle>Auto-drafted, awaiting edit ({awaitingEdit.length})</CardTitle></CardHeader>
        <CardContent>
          {awaitingEdit.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : awaitingEdit.map((r) => (
            <Row key={r.id} r={r}>
              <Button size="sm" onClick={() => user && void act(async () => { const t = await user.getIdToken(); return meetingsAdapter.circulateMinutes(r.id, t); }, 'Minutes circulated to attendees.')}>Circulate</Button>
            </Row>
          ))}
        </CardContent></Card>

      <Card><CardHeader><CardTitle>Circulated, awaiting approval at the next meeting ({awaitingApproval.length})</CardTitle></CardHeader>
        <CardContent>
          {awaitingApproval.length === 0 ? <p className="text-sm text-muted-foreground">None. Approval happens by a motion carrying this minutes id at the next sitting; it links automatically when that motion closes passed.</p> : awaitingApproval.map((r) => <Row key={r.id} r={r} />)}
        </CardContent></Card>

      <Card><CardHeader><CardTitle className="text-red-700">Circulation overdue ({overdue.length})</CardTitle></CardHeader>
        <CardContent>
          {overdue.length === 0 ? <p className="text-sm text-muted-foreground">None. Drafts must circulate within 7 days of the meeting closing.</p> : overdue.map((r) => <Row key={r.id} r={r} />)}
        </CardContent></Card>

      <Card><CardHeader><CardTitle>Signed and locked ({signed.length})</CardTitle></CardHeader>
        <CardContent>
          {signed.length === 0 ? <p className="text-sm text-muted-foreground">None yet.</p> : signed.map((r) => (
            <Row key={r.id} r={r}>
              {r.pdf?.driveLink ? <a className="text-sm underline" href={r.pdf.driveLink} target="_blank" rel="noreferrer">Open PDF</a> : null}
              <span className="text-xs text-muted-foreground">Retain until {r.retentionUntil ? new Date(r.retentionUntil).toLocaleDateString() : '-'}</span>
            </Row>
          ))}
        </CardContent></Card>

      <Card><CardHeader><CardTitle>Approved, awaiting signature</CardTitle></CardHeader>
        <CardContent>
          {rows.filter((r) => r.status === 'approved').length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : rows.filter((r) => r.status === 'approved').map((r) => (
            <Row key={r.id} r={r}>
              <Button size="sm" onClick={() => user && void act(async () => { const t = await user.getIdToken(); return meetingsAdapter.signMinutes(r.id, t); }, 'Minutes signed and locked.')}>Sign and lock</Button>
            </Row>
          ))}
        </CardContent></Card>
    </div>
  );
}
