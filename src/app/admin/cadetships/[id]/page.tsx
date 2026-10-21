"use client";

/**
 * Cadetship detail (phase2_spec.md Section F.8).
 *
 * Every mutation goes through the cadetship API routes (attest /
 * evaluations / decision); the API re-resolves the caller's eligibility
 * server-side, so panels render for convenience and the API's verdict is
 * the one that counts - its error code is surfaced verbatim.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface CadetshipDetail {
  cadetship: any;
  checklist: { complete: boolean; doneCount: number };
  evaluations: any[];
}

const EXIT_REASONS = ['evaluation_failed', 'withdrew', 'no_engagement', 'dues_unresolved', 'conduct'];

export default function CadetshipDetailPage() {
  const params = useParams<{ id: string }>();
  const { user } = useUser();
  const { toast } = useToast();
  const [detail, setDetail] = useState<CadetshipDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [eventRef, setEventRef] = useState('');
  const [evalRole, setEvalRole] = useState('chapter_president');
  const [evalRec, setEvalRec] = useState('confirm');
  const [evalNote, setEvalNote] = useState('');
  const [decisionNote, setDecisionNote] = useState('');
  const [memberNote, setMemberNote] = useState('');
  const [exitReason, setExitReason] = useState('evaluation_failed');
  const [chosen, setChosen] = useState('confirm');

  const load = useCallback(async () => {
    if (!user || !params?.id) return;
    setLoading(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/cadetships/${params.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      setDetail(await res.json());
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load cadetship');
    } finally {
      setLoading(false);
    }
  }, [user, params?.id]);

  useEffect(() => {
    load();
  }, [load]);

  const act = useCallback(
    async (path: string, body: Record<string, unknown>, successTitle: string) => {
      if (!user || !params?.id) return;
      setBusy(true);
      try {
        const token = await user.getIdToken();
        const res = await fetch(path, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        toast({ title: successTitle });
        await load();
      } catch (err: any) {
        toast({ title: 'Action rejected', description: err?.message, variant: 'destructive' });
      } finally {
        setBusy(false);
      }
    },
    [user, params?.id, toast, load],
  );

  const c = detail?.cadetship;

  return (
    <AuthorizationGate permission="canManageCadetships">
      <div className="space-y-6 p-6">
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading cadetship...
          </p>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : c ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle>{c.personUid}</CardTitle>
                <CardDescription>
                  {c.cohortId} - {c.chapterId} - started {String(c.startedAt).slice(0, 10)} - probation
                  ends {String(c.probationEnd).slice(0, 10)}
                  {c.extendedTo ? ` - extended to ${String(c.extendedTo).slice(0, 10)}` : ''}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary">{c.effectiveStatus}</Badge>
                  {c.reviewDue && <Badge>review due</Badge>}
                  <Badge variant="outline">week {c.week}</Badge>
                  <Badge variant="outline">
                    checklist {detail.checklist.doneCount}/4 {detail.checklist.complete ? '(complete)' : ''}
                  </Badge>
                  <Badge variant="outline">dues gate: {c.duesGate?.status ?? 'not_checked'}</Badge>
                  {c.membershipClassWritePending && <Badge variant="outline">class write pending</Badge>}
                </div>
                <ul className="text-sm space-y-1">
                  <li>Orientation: {c.items.orientation.done ? `attested by ${c.items.orientation.attestedBy}` : 'pending'}</li>
                  <li>Workshops: {c.items.workshops.count}/2</li>
                  <li>Sprint task: {c.items.sprintTask.taskId ?? 'not detected yet'}</li>
                  <li>Conduct acknowledged: {c.conduct.acknowledged ? 'yes' : 'no'}</li>
                  <li>Decision: {c.decision?.outcome ?? 'open'} (round {c.decision?.round ?? 1})</li>
                </ul>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Attest (chapter officers / Membership Director)</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-3">
                <Button disabled={busy} onClick={() => act(`/api/cadetships/${params.id}/attest`, { item: 'orientation' }, 'Orientation attested')}>
                  Attest orientation
                </Button>
                <Input placeholder="Workshop event reference" value={eventRef} onChange={(e) => setEventRef(e.target.value)} className="w-64" />
                <Button disabled={busy} variant="outline" onClick={() => act(`/api/cadetships/${params.id}/attest`, { item: 'workshop', eventRef: eventRef || undefined }, 'Workshop attested')}>
                  Attest workshop
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Evaluations ({detail.evaluations.length}/2 submitted)</CardTitle>
                <CardDescription>
                  Extend/exit recommendations need a note of at least 40 characters. Eligibility is
                  resolved by the API from the role store.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {detail.evaluations.map((e: any) => (
                  <p key={e.evaluatorRole} className="text-sm">
                    <strong>{e.evaluatorRole}</strong>: {e.recommendation} - by {e.evaluatorUid}
                    {e.singleEvaluatorReason ? ` (single evaluator: ${e.singleEvaluatorReason})` : ''}
                  </p>
                ))}
                <div className="flex flex-wrap gap-3">
                  <Select value={evalRole} onValueChange={setEvalRole}>
                    <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="chapter_president">Chapter President</SelectItem>
                      <SelectItem value="team_lead">Team Lead</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={evalRec} onValueChange={setEvalRec}>
                    <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="confirm">Confirm</SelectItem>
                      <SelectItem value="extend">Extend</SelectItem>
                      <SelectItem value="exit">Exit</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Textarea placeholder="Evaluation note" value={evalNote} onChange={(e) => setEvalNote(e.target.value)} />
                <Button disabled={busy} onClick={() => act(`/api/cadetships/${params.id}/evaluations`, { evaluatorRole: evalRole, recommendation: evalRec, note: evalNote }, 'Evaluation submitted')}>
                  Submit evaluation
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Decision</CardTitle>
                <CardDescription>
                  Confirm and exit: Membership Director only. Extend: Chapter President, round 1, on
                  evaluator consensus. A disagreement is resolved by the Membership Director choosing
                  one of the submitted recommendations.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea placeholder="Decision note (mandatory for extension)" value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} />
                <Textarea placeholder="Member-facing note (optional; the only note the cadet ever sees)" value={memberNote} onChange={(e) => setMemberNote(e.target.value)} />
                <div className="flex flex-wrap gap-3 items-center">
                  <Select value={exitReason} onValueChange={setExitReason}>
                    <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {EXIT_REASONS.map((r) => (
                        <SelectItem key={r} value={r}>{r}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={chosen} onValueChange={setChosen}>
                    <SelectTrigger className="w-52"><SelectValue placeholder="Disagreement choice" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="confirm">Resolve: confirm</SelectItem>
                      <SelectItem value="extend">Resolve: extend</SelectItem>
                      <SelectItem value="exit">Resolve: exit</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-wrap gap-3">
                  <Button disabled={busy} onClick={() => act(`/api/cadetships/${params.id}/decision`, { outcome: 'confirm', note: decisionNote, memberNote: memberNote || undefined }, 'Cadetship confirmed')}>
                    Confirm (NMD)
                  </Button>
                  <Button disabled={busy} variant="outline" onClick={() => act(`/api/cadetships/${params.id}/decision`, { outcome: 'extend', note: decisionNote, memberNote: memberNote || undefined }, 'Cadetship extended')}>
                    Extend (CP)
                  </Button>
                  <Button disabled={busy} variant="destructive" onClick={() => act(`/api/cadetships/${params.id}/decision`, { outcome: 'exit', exitReason, note: decisionNote, memberNote: memberNote || undefined }, 'Cadetship exited')}>
                    Exit (NMD)
                  </Button>
                  <Button disabled={busy} variant="secondary" onClick={() => act(`/api/cadetships/${params.id}/decision`, { outcome: chosen === 'confirm' ? 'confirm' : chosen === 'extend' ? 'extend' : 'exit', exitReason: chosen === 'exit' ? exitReason : undefined, note: decisionNote, memberNote: memberNote || undefined, resolutionOf: 'disagreement', chosenRecommendation: chosen }, 'Disagreement resolved')}>
                    Resolve disagreement as {chosen}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </>
        ) : null}
      </div>
    </AuthorizationGate>
  );
}
