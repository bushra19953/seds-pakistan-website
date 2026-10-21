"use client";

/**
 * Obligation detail (phase2_spec.md Section G.7): state timeline from the
 * governance audit entries, evidence and review actions via the owner
 * API, and the Founder waiver (the only waiver path - this form posts to
 * the waive route, which re-checks the caller's identity server-side and
 * requires a recorded instrument).
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { Loader2 } from 'lucide-react';

export default function ObligationDetailPage() {
  const { user } = useUser();
  const params = useParams();
  const { toast } = useToast();
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewNote, setReviewNote] = useState('');
  const [instrumentRef, setInstrumentRef] = useState('');
  const [waiveNote, setWaiveNote] = useState('');

  const load = useCallback(async () => {
    if (!user || !params?.id) return;
    setLoading(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/compliance/obligations/${params.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      setDetail(body);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load obligation');
    } finally {
      setLoading(false);
    }
  }, [user, params?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
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
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        toast({ title: successTitle });
        await load();
      } catch (err: any) {
        toast({ title: 'Action failed', description: err?.message, variant: 'destructive' });
      } finally {
        setBusy(false);
      }
    },
    [user, toast, load],
  );

  const obligation = detail?.obligation;

  return (
    <AuthorizationGate permission="canAccessAdmin">
      <div className="space-y-6 p-6">
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : (
          <>
            <div>
              <h1 className="text-2xl font-bold">{obligation.title}</h1>
              <p className="text-sm text-muted-foreground">
                {obligation.templateKey} · office {obligation.officeRole} · due {obligation.dueDate?.slice(0, 10)} ·{' '}
                <Badge variant="outline">{obligation.status}</Badge>
              </p>
              <p className="text-sm text-muted-foreground">
                Current holder: {detail.currentHolderUid ?? 'vacant (duty routed to Founder + NGS)'} · Snapshot at last
                pass: {obligation.ownerUidSnapshot ?? 'vacant'}
              </p>
            </div>

            {obligation.evidence && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Evidence</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-sm">
                  <p>
                    Type: {obligation.evidence.type} · Submitted by {obligation.evidence.submittedBy} at{' '}
                    {obligation.evidence.submittedAt?.slice(0, 10)}
                  </p>
                  <p>
                    <a className="text-blue-700 underline" href={obligation.evidence.ref} target="_blank" rel="noreferrer">
                      {obligation.evidence.ref}
                    </a>
                  </p>
                  {obligation.evidence.note && <p>{obligation.evidence.note}</p>}
                </CardContent>
              </Card>
            )}

            {obligation.status === 'under_review' && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Review ({detail.template?.reviewerRole})</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Textarea
                    placeholder="Review note (mandatory for a rejection)"
                    value={reviewNote}
                    onChange={(e) => setReviewNote(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button
                      disabled={busy}
                      onClick={() =>
                        act(`/api/compliance/obligations/${obligation.id}/review`, { outcome: 'accepted', note: reviewNote }, 'Accepted - obligation completed')
                      }
                    >
                      Accept evidence
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={busy}
                      onClick={() =>
                        act(`/api/compliance/obligations/${obligation.id}/review`, { outcome: 'rejected', note: reviewNote }, 'Rejected - back to due, deadline unchanged')
                      }
                    >
                      Reject (deadline stands)
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {!['completed', 'waived'].includes(obligation.status) && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Waive (Founder only)</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    A waiver needs a recorded instrument: a Founder Act or a Board resolution. This is the only waiver
                    path in the system.
                  </p>
                  <Input
                    placeholder="Instrument reference (e.g. Board Res 2026-14)"
                    value={instrumentRef}
                    onChange={(e) => setInstrumentRef(e.target.value)}
                  />
                  <Textarea placeholder="Note" value={waiveNote} onChange={(e) => setWaiveNote(e.target.value)} />
                  <Button
                    variant="outline"
                    disabled={busy || !instrumentRef.trim()}
                    onClick={() =>
                      act(
                        `/api/admin/compliance/obligations/${obligation.id}/waive`,
                        { instrumentType: 'founder_act', instrumentRef, note: waiveNote },
                        'Obligation waived',
                      )
                    }
                  >
                    Waive obligation
                  </Button>
                </CardContent>
              </Card>
            )}

            {detail.notice && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Default notice</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-sm">
                  <p>
                    Issued: {detail.notice.issuedAt?.slice(0, 10) ?? 'draft - not yet issued'} · Cure deadline:{' '}
                    {detail.notice.cureDeadline?.slice(0, 10) ?? '-'} · Outcome: {detail.notice.outcome}
                  </p>
                  <p>
                    Receipts - Founder: {detail.notice.deliveryReceipts?.founder?.ok ? 'delivered' : 'NOT delivered'} ·
                    President: {detail.notice.deliveryReceipts?.president?.ok ? 'delivered' : 'NOT delivered'}
                  </p>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">State timeline</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {(detail.auditTrail ?? []).length === 0 && (
                  <p className="text-muted-foreground">No governance audit entries yet.</p>
                )}
                {(detail.auditTrail ?? []).map((entry: any) => (
                  <p key={entry.id}>
                    <span className="text-muted-foreground">{entry.createdAt?.slice(0, 16).replace('T', ' ')}</span> ·{' '}
                    {entry.action} · by {entry.actor}
                  </p>
                ))}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </AuthorizationGate>
  );
}
