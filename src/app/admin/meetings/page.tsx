'use client';
// Route per ws-a section 5: /admin/meetings. ADAPTER: gate key canManageMeetings is
// added by the permissions slice; cast keeps this page compiling until it lands.
// SUPA-BLOCKED: live listener, no adapter equivalent — stays Firestore until realtime contract lands
// (the `motions` useCollection({listen:true}) read below is deliberately NOT migrated;
// plan cluster_meetings_PLAN.md §1-G1 client-read ruling (a).)
import { useMemo, useState } from 'react';
import { collection, query, orderBy } from 'firebase/firestore';
import { useFirestore, useCollection, useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import type { PermissionKey } from '@/config/permissions.config';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MotionCard } from '@/components/admin/governance/motion-card';
import { BallotPanel } from '@/components/admin/governance/ballot-panel';
import { meetingsAdapter } from '@/lib/governance/meetings-adapter';
import type { MotionView } from '@/lib/governance/meetings-ui';

export default function AdminMeetingsPage() {
  return <AuthorizationGate permission={'canManageMeetings' as PermissionKey}><Inner /></AuthorizationGate>;
}
function Inner() {
  const db = useFirestore(); const { user } = useUser();
  const [meetingId, setMeetingId] = useState(''); const [text, setText] = useState(''); const [classId, setClassId] = useState(''); const [method, setMethod] = useState('electronic_poll'); const [msg, setMsg] = useState('');
  const [tick, setTick] = useState(0);
  const q = useMemo(() => (db ? query(collection(db, 'motions'), orderBy('openedAt', 'desc')) : null), [db, tick]);
  const { data, loading } = useCollection<any>(q as any, { listen: true });
  const motions = (data ?? []) as MotionView[];
  async function create() { if (!user) return; setMsg(''); try { const token = await user.getIdToken(); await meetingsAdapter.createMotion(meetingId.trim(), { text, decisionClassId: classId.trim(), proposerUid: user.uid, method }, token); setText(''); setTick((v) => v + 1); setMsg('Motion opened.'); } catch (e: any) { setMsg(e?.message ?? 'Could not open the motion.'); } }
  async function close(id: string) { if (!user) return; try { const token = await user.getIdToken(); await meetingsAdapter.closeMotion(id, token); setTick((v) => v + 1); } catch (e: any) { setMsg(e?.message ?? 'Could not close the motion.'); } }
  return (<div className="space-y-6 p-6"><h1 className="text-2xl font-semibold">Meetings: Motions and Voting</h1>
    <Card><CardHeader><CardTitle>Open a motion</CardTitle></CardHeader><CardContent className="space-y-3">
      <Input value={meetingId} onChange={(e) => setMeetingId(e.target.value)} placeholder="Meeting ID" />
      <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Exact motion text" />
      <Input value={classId} onChange={(e) => setClassId(e.target.value)} placeholder="Decision class ID" />
      <select className="w-full rounded-md border p-2" value={method} onChange={(e) => setMethod(e.target.value)}><option value="electronic_poll">Electronic poll</option><option value="show_of_hands">Show of hands</option></select>
      <p className="text-sm text-muted-foreground">Decision class sets the threshold, consent requirement, Reserved Matter flag, and filing flag. Disclose any interest when you vote. A disclosure is recorded and never blocks a vote.</p>
      <Button disabled={!meetingId.trim() || !text.trim() || !classId.trim()} onClick={() => void create()}>Open motion and voting</Button>{msg ? <p className="text-sm">{msg}</p> : null}
    </CardContent></Card>
    {loading ? <p>Loading motions...</p> : motions.length === 0 ? <p>No motions yet. Open the first motion above.</p> : motions.map((m) => (<div key={m.id} className="space-y-2"><MotionCard motion={{ ...m, id: (m as any).id }} canClose onClose={(id) => void close(id)} /><BallotPanel motion={{ ...m, id: (m as any).id }} /></div>))}
  </div>);
}
