'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { MotionView, VoteChoice } from '@/lib/governance/meetings-ui';
import { SecretBallotPanel } from './secret-ballot-panel';
import { meetingsAdapter } from '@/lib/governance/meetings-adapter';
export function BallotPanel({ motion, authToken }: { motion: MotionView; authToken?: string | null }) {
  const [hasInterest, setHasInterest] = useState(false); const [description, setDescription] = useState(''); const [done, setDone] = useState(false); const [error, setError] = useState('');
  if (motion.status !== 'open') return <p className="text-sm">Voting is not open for this motion.</p>;
  if (motion.method === 'secret_ballot') return <SecretBallotPanel demands={motion.secretDemandedBy?.length ?? 0} onDemand={() => meetingsAdapter.demandSecret(motion.id, authToken)} onIssueToken={async () => (await meetingsAdapter.issueSecretToken(motion.id, authToken)).token} onCast={(t, c) => meetingsAdapter.castSecretBallot(motion.id, t, c, authToken)} />;
  async function cast(choice: VoteChoice) { setError(''); try { await meetingsAdapter.castOpenBallot(motion.id, choice, { hasInterest, description, relatedPartyName: null }, authToken); setDone(true); } catch (e: any) { setError(e?.message ?? 'Vote was not accepted.'); } }
  if (done) return <p className="text-sm">Your vote has been recorded.</p>;
  return (<div className="space-y-3"><div className="flex gap-2">{(['for', 'against', 'abstain'] as VoteChoice[]).map((c) => <Button key={c} size="sm" onClick={() => void cast(c)}>{c[0].toUpperCase() + c.slice(1)}</Button>)}</div>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={hasInterest} onChange={(e) => setHasInterest(e.target.checked)} /> I have an interest to disclose for this motion</label>
    {hasInterest ? <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe the interest. Disclosure is recorded and never blocks your vote." /> : null}
    <Button variant="outline" size="sm" onClick={() => void meetingsAdapter.demandSecret(motion.id, authToken)}>Demand secret ballot</Button>
    {error ? <p className="text-sm text-red-600">{error}</p> : null}</div>);
}
export default BallotPanel;
