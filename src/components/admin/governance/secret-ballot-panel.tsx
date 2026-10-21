'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { VoteChoice } from '@/lib/governance/meetings-ui';
// Secret ballot: request a one-time token, then submit choice with that token only.
// This component never sends uid, email, or display name with the cast call.
export function SecretBallotPanel({ onIssueToken, onCast, onDemand, demands }: { onIssueToken: () => Promise<string>; onCast: (token: string, choice: VoteChoice) => Promise<void>; onDemand?: () => Promise<void>; demands?: number }) {
  const [token, setToken] = useState<string | null>(null); const [done, setDone] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function issue() { setBusy(true); setError(''); try { setToken(await onIssueToken()); } catch (e: any) { setError(e?.message ?? 'Could not issue a ballot token.'); } finally { setBusy(false); } }
  async function cast(choice: VoteChoice) { if (!token) return; setBusy(true); setError(''); try { await onCast(token, choice); setDone(true); setToken(null); } catch (e: any) { setError(e?.message ?? 'Vote was not accepted.'); } finally { setBusy(false); } }
  if (done) return <p className="text-sm">Your secret ballot has been cast. No record links this choice to you.</p>;
  return (<div className="space-y-3"><p className="text-sm">Secret ballot. Your choice is submitted with a one-time token only and is never linked to your identity.</p>
    {onDemand ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void onDemand()}>Demand secret ballot{demands != null ? ` (${demands}/2)` : ''}</Button> : null}
    {!token ? <Button size="sm" disabled={busy} onClick={() => void issue()}>Request ballot token</Button> : (<div className="flex gap-2">{(['for', 'against', 'abstain'] as VoteChoice[]).map((c) => <Button key={c} size="sm" disabled={busy} onClick={() => void cast(c)}>{c[0].toUpperCase() + c.slice(1)}</Button>)}</div>)}
    {error ? <p className="text-sm text-red-600">{error}</p> : null}</div>);
}
export default SecretBallotPanel;
