"use client";

/**
 * "My office obligations" (phase2_spec.md Section G.7, officer UI).
 *
 * Plain-language state labels: an officer NEVER sees a bare alarming
 * state - every past-deadline state is shown next to the exact path that
 * resolves it (submit the cure evidence). Evidence submission is inline;
 * cure submission appears when a notice is in its cure window.
 */

import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@/firebase';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { Loader2 } from 'lucide-react';

interface MyObligation {
  id: string;
  title: string;
  officeRole: string;
  dueDate: string;
  status: string;
  evidence: { ref: string } | null;
  defaultNoticeId: string | null;
  seedHold?: boolean;
}

/** Plain-language label + the resolving path, per state. */
function stateLabel(status: string): { text: string; guidance: string } {
  switch (status) {
    case 'scheduled':
      return { text: 'Coming up', guidance: 'Nothing to do yet - you will be reminded before the deadline.' };
    case 'reminded_30':
    case 'reminded_14':
    case 'reminded_7':
      return { text: 'Due soon', guidance: 'Submit your evidence before the deadline below.' };
    case 'due':
      return { text: 'Due now', guidance: 'Submit your evidence today.' };
    case 'under_review':
      return { text: 'With the reviewer', guidance: 'Your evidence was submitted and is being checked.' };
    case 'overdue':
      return {
        text: 'Past the deadline',
        guidance: 'This is being followed up. If a formal notice arrives, it will give you a 7-day window to put things right - watch for it here.',
      };
    case 'default_draft':
    case 'default_issued':
      return {
        text: 'Formal notice being prepared',
        guidance: 'Once it is issued you will have 7 days to submit the missing item (the cure) from this page.',
      };
    case 'cure_period':
      return {
        text: 'Action needed - 7-day window open',
        guidance: 'Submit the missing item below (the cure) before the deadline on your notice. That closes this.',
      };
    case 'escalated':
      return {
        text: 'With the Founder',
        guidance: 'The cure window passed, so this sits with the Founder now. You do not need to do anything unless contacted.',
      };
    case 'completed':
      return { text: 'Done', guidance: 'Thank you - this duty is complete.' };
    case 'waived':
      return { text: 'Waived', guidance: 'This duty was formally waived. Nothing to do.' };
    default:
      return { text: status, guidance: '' };
  }
}

export default function MyCompliancePage() {
  const { user } = useUser();
  const { toast } = useToast();
  const [obligations, setObligations] = useState<MyObligation[]>([]);
  const [officeRole, setOfficeRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/compliance/mine', { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      setObligations(body.obligations ?? []);
      setOfficeRole(body.officeRole ?? null);
    } catch (err: any) {
      toast({ title: 'Failed to load your obligations', description: err?.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [user, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(
    async (path: string, body: Record<string, unknown>, successTitle: string) => {
      if (!user) return;
      setBusy(true);
      try {
        const token = await user.getIdToken();
        const res = await fetch(path, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.hint || data.error || `Request failed (${res.status})`);
        toast({ title: successTitle });
        await load();
      } catch (err: any) {
        toast({ title: 'Submission failed', description: err?.message, variant: 'destructive' });
      } finally {
        setBusy(false);
      }
    },
    [user, toast, load],
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">My office obligations</h1>
        <p className="text-sm text-muted-foreground">
          {officeRole
            ? `Duties attached to your office (${officeRole}). They belong to the office - if you hand the office over, they pass to the next holder.`
            : 'You do not currently hold an office with compliance duties.'}
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : obligations.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Nothing is assigned to your office right now.
          </CardContent>
        </Card>
      ) : (
        obligations.map((o) => {
          const label = stateLabel(o.status);
          const canEvidence = ['scheduled', 'reminded_30', 'reminded_14', 'reminded_7', 'due'].includes(o.status);
          return (
            <Card key={o.id}>
              <CardHeader className="pb-2">
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  {o.title}
                  <Badge variant="outline">{label.text}</Badge>
                </CardTitle>
                <CardDescription>
                  Due {o.dueDate?.slice(0, 10)}. {label.guidance}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {o.evidence && (
                  <p className="text-sm">
                    Evidence submitted:{' '}
                    <a className="text-blue-700 underline" href={o.evidence.ref} target="_blank" rel="noreferrer">
                      {o.evidence.ref}
                    </a>
                  </p>
                )}
                {canEvidence && (
                  <div className="flex gap-2">
                    <Input
                      placeholder="Link to your evidence (Drive or document URL)"
                      value={refs[o.id] ?? ''}
                      onChange={(e) => setRefs((prev) => ({ ...prev, [o.id]: e.target.value }))}
                    />
                    <Button
                      disabled={busy || !(refs[o.id] ?? '').trim()}
                      onClick={() =>
                        submit(`/api/compliance/obligations/${o.id}/evidence`, { type: 'document', ref: refs[o.id] }, 'Evidence submitted for review')
                      }
                    >
                      Submit evidence
                    </Button>
                  </div>
                )}
                {o.status === 'cure_period' && (
                  <div className="flex gap-2">
                    <Input
                      placeholder="Link to the missing item (your cure)"
                      value={refs[o.id] ?? ''}
                      onChange={(e) => setRefs((prev) => ({ ...prev, [o.id]: e.target.value }))}
                    />
                    <Button
                      disabled={busy || !(refs[o.id] ?? '').trim()}
                      onClick={() =>
                        submit(`/api/admin/compliance/obligations/${o.id}/cure`, { evidenceRef: refs[o.id] }, 'Cure submitted - it will be reviewed')
                      }
                    >
                      Submit cure
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}
