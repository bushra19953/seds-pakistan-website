'use client';
// Route per ws-a section 5: /admin/circular-resolutions. Draft, then
// circulate (7-day window), then Governors sign from the detail page.
// The consent picker lists ONLY decided consents (granted/conditional)
// because an undecided consent blocks circulation anyway.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import type { PermissionKey } from '@/config/permissions.config';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { meetingsAdapter } from '@/lib/governance/meetings-adapter';
import type { CircularView } from '@/lib/governance/meetings-ui';

async function call(path: string, token: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}

export default function AdminCircularResolutionsPage() {
  return <AuthorizationGate permission={'canViewGovernance' as PermissionKey}><Inner /></AuthorizationGate>;
}

function Inner() {
  const { user } = useUser();
  const [rows, setRows] = useState<CircularView[]>([]);
  const [consents, setConsents] = useState<Array<{ id: string; matter: string; status: string }>>([]);
  const [bodyId, setBodyId] = useState('');
  const [classId, setClassId] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [consentId, setConsentId] = useState('');
  const [msg, setMsg] = useState('');
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const token = await user.getIdToken();
      const data = await meetingsAdapter.listCirculars(token);
      setRows(data.resolutions ?? []);
      const c = await call('/api/governance/consents/decided', token).catch(() => ({ consents: [] }));
      setConsents(c.consents ?? []);
    } catch (e: any) { setMsg(e?.message ?? 'Could not load resolutions.'); }
  }, [user, tick]);
  useEffect(() => { void load(); }, [load]);

  async function create() {
    if (!user) return; setMsg('');
    try {
      const token = await user.getIdToken();
      await meetingsAdapter.createCircular({ bodyId: bodyId.trim(), title: title.trim(), decisionClassId: classId.trim(), text, consentId: consentId || undefined }, token);
      setText(''); setTitle(''); setTick((v) => v + 1); setMsg('Draft created. Circulate it when the text is final.');
    } catch (e: any) { setMsg(e?.message ?? 'Could not create the draft.'); }
  }

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-semibold">Circular Resolutions</h1>
      {msg ? <p className="text-sm">{msg}</p> : null}
      <Card><CardHeader><CardTitle>New draft (Board, v1)</CardTitle></CardHeader><CardContent className="space-y-3">
        <Input value={bodyId} onChange={(e) => setBodyId(e.target.value)} placeholder="Body ID (the Board body)" />
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short title" />
        <Input value={classId} onChange={(e) => setClassId(e.target.value)} placeholder="Decision class ID" />
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Exact resolution text" />
        <label className="block text-sm">Founder Consent (only decided consents can be linked)
          <select className="mt-1 block w-full rounded border p-2" value={consentId} onChange={(e) => setConsentId(e.target.value)}>
            <option value="">No consent linked</option>
            {consents.map((c) => <option key={c.id} value={c.id}>{c.matter} ({c.status})</option>)}
          </select>
        </label>
        <Button onClick={() => void create()}>Create draft</Button>
      </CardContent></Card>

      <Card><CardHeader><CardTitle>Resolutions ({rows.length})</CardTitle></CardHeader><CardContent>
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">None yet.</p> : rows.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 border-b py-2 text-sm">
            <div>
              <Link className="font-medium underline" href={`/admin/circular-resolutions/${r.id}`}>{r.text.slice(0, 90)}</Link>{' '}
              <Badge variant="outline">{r.status}</Badge>
              <div className="text-xs text-muted-foreground">Signed {r.signedCount} · closes {r.closesAt ? new Date(r.closesAt).toLocaleString() : 'not circulated'}</div>
            </div>
            {r.status === 'draft' ? <Button size="sm" onClick={() => user && void (async () => { const t = await user.getIdToken(); await meetingsAdapter.circulateCircular(r.id, t).catch((e: any) => setMsg(e?.message ?? 'Circulation failed.')); setTick((v) => v + 1); })()}>Circulate</Button> : null}
          </div>
        ))}
      </CardContent></Card>
    </div>
  );
}
