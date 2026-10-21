'use client';
// Circular resolution detail (ws-a section 5): the Governor checklist,
// live signed count against the COPIED threshold, the closing
// countdown, and the passed/lapsed outcome with its register and
// filing-task links. Signing is a "for" vote carrying the fixed
// approval statement; against/abstain use the same endpoint.
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import type { PermissionKey } from '@/config/permissions.config';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { meetingsAdapter } from '@/lib/governance/meetings-adapter';

type Resolution = {
  id: string; bodyId: string; text: string; decisionClassId: string; consentId: string | null;
  status: string; circulatedAtMs: number | null; closesAt: number | null;
  governorUidsSnapshot: string[];
  threshold: { majorityType: string; requiredCount: number | null };
  signatures: Array<{ uid: string; statement: string; atMs: number }>;
  votes: Array<{ uid: string; choice: string; atMs: number }>;
  decisionId: string | null; filingTaskId: string | null;
};

async function call(path: string, token: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}

export default function CircularResolutionDetailPage() {
  return <AuthorizationGate permission={'canViewGovernance' as PermissionKey}><Inner /></AuthorizationGate>;
}

function Inner() {
  const { user } = useUser();
  const params = useParams<{ resolutionId: string }>();
  const [r, setR] = useState<Resolution | null>(null);
  const [msg, setMsg] = useState('');
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    if (!user || !params?.resolutionId) return;
    try {
      const token = await user.getIdToken();
      const data = await call(`/api/governance/circular-resolutions/${params.resolutionId}`, token);
      setR(data.resolution as Resolution);
    } catch (e: any) { setMsg(e?.message ?? 'Could not load the resolution.'); }
  }, [user, params, tick]);
  useEffect(() => { void load(); }, [load]);

  if (!r) return <div className="p-6 text-sm">{msg || 'Loading...'}</div>;

  const total = r.governorUidsSnapshot.length;
  const signedUids = new Set(r.signatures.map((s) => s.uid));
  const forCount = r.votes.filter((v) => v.choice === 'for').length;
  const needed = r.threshold.requiredCount ?? Math.floor(total / 2) + 1;
  const remaining = r.closesAt ? Math.max(0, r.closesAt - Date.now()) : null;
  const days = remaining != null ? Math.floor(remaining / 86400000) : 0;
  const hours = remaining != null ? Math.floor((remaining % 86400000) / 3600000) : 0;

  async function vote(choice: 'for' | 'against' | 'abstain') {
    if (!user) return; setMsg('');
    try {
      const token = await user.getIdToken();
      if (choice === 'for') await meetingsAdapter.signCircular(r!.id, token);
      else await call(`/api/governance/circular-resolutions/${r!.id}/sign`, token, { method: 'POST', body: JSON.stringify({ choice }) });
      setTick((v) => v + 1);
    } catch (e: any) { setMsg(e?.message ?? 'Vote was not accepted.'); }
  }

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-semibold">Circular Resolution</h1>
      {msg ? <p className="text-sm text-red-600">{msg}</p> : null}
      <Card><CardHeader><CardTitle className="text-base">{r.text}</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-2">
          <Badge>{r.status}</Badge>
          <Badge variant="outline">{r.decisionClassId}</Badge>
          {r.consentId ? <Badge variant="outline">Consent {r.consentId}</Badge> : null}
        </div>
        {r.status === 'open' ? <p>Signed {forCount} of {needed} needed ({total} Governors). Closes in {days}d {hours}h ({r.closesAt ? new Date(r.closesAt).toLocaleString() : ''}).</p> : null}
        {r.status === 'passed' ? <p className="font-medium text-green-700">Passed. {r.decisionId ? <Link className="underline" href={`/admin/governance?id=${r.decisionId}`}>View the register entry</Link> : null} {r.filingTaskId ? <span>· Filing task {r.filingTaskId}</span> : null}</p> : null}
        {r.status === 'lapsed' ? <p className="font-medium text-red-700">Lapsed at the close of the 7-day window without reaching the threshold. No register entry was written.</p> : null}
        {r.status === 'failed' ? <p className="font-medium text-red-700">Failed at the close of the window.</p> : null}

        <h2 className="pt-2 font-medium">Governors</h2>
        <ul className="space-y-1">
          {r.governorUidsSnapshot.map((uid) => (
            <li key={uid} className="flex items-center justify-between border-b py-1">
              <span>{uid}</span>
              <span>{signedUids.has(uid) ? 'Signed: I approve this resolution' : r.votes.find((v) => v.uid === uid) ? `Voted ${r.votes.find((v) => v.uid === uid)?.choice}` : 'Not yet voted'}</span>
            </li>
          ))}
        </ul>

        {r.status === 'open' && user && r.governorUidsSnapshot.includes(user.uid) && !r.votes.some((v) => v.uid === user.uid) ? (
          <div className="flex gap-2 pt-2">
            <Button size="sm" onClick={() => void vote('for')}>Sign: I approve this resolution</Button>
            <Button size="sm" variant="outline" onClick={() => void vote('against')}>Vote against</Button>
            <Button size="sm" variant="outline" onClick={() => void vote('abstain')}>Abstain</Button>
          </div>
        ) : null}
      </CardContent></Card>
    </div>
  );
}
