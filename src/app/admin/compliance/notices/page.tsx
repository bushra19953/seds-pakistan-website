"use client";

/**
 * Default notices (phase2_spec.md Sections G.6/G.7): the Audit Chair's
 * draft queue, the issued list with per-recipient receipt states, cure
 * review actions, and Founder interventions on escalated notices. Every
 * action posts to the notice routes, which re-check the caller's office
 * server-side (the Founder cannot issue; only the Founder can intervene).
 */

import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { Loader2 } from 'lucide-react';

interface NoticeRow {
  id: string;
  obligationId: string;
  templateKey: string;
  officeRole: string;
  issuedAt: string | null;
  issuedToUid: string | null;
  priorHolderUid: string | null;
  cureDeadline: string | null;
  cure: { evidenceRef: string; submittedBy: string } | null;
  cureReview: { outcome: string } | null;
  outcome: string;
  deliveryReceipts: { founder: { ok: boolean }; president: { ok: boolean } };
  intervention: { type: string } | null;
}

export default function NoticesPage() {
  const { user } = useUser();
  const { toast } = useToast();
  const [notices, setNotices] = useState<NoticeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [newDueDate, setNewDueDate] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/admin/compliance/notices', { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      setNotices(body.notices ?? []);
    } catch (err: any) {
      toast({ title: 'Failed to load notices', description: err?.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [user, toast]);

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

  const drafts = notices.filter((n) => n.issuedAt == null);
  const issued = notices.filter((n) => n.issuedAt != null);

  return (
    <AuthorizationGate requiredPermission="canAccessAdmin">
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-bold">Default notices</h1>
          <p className="text-sm text-muted-foreground">
            Only the Audit Chair issues. The cure clock runs 7 days from issue; a rejected cure does not restart it.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Draft queue ({drafts.length})</CardTitle>
                <CardDescription>Drafts are created by the engine at overdue + 7 days. Issuing re-resolves the current office holder.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {drafts.length === 0 && <p className="text-sm text-muted-foreground">No drafts awaiting issue.</p>}
                {drafts.map((n) => (
                  <div key={n.id} className="flex items-center justify-between gap-3 border-b pb-2">
                    <div className="text-sm">
                      <p className="font-medium">{n.templateKey}</p>
                      <p className="text-muted-foreground">Office: {n.officeRole} · Obligation: {n.obligationId}</p>
                    </div>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => act(`/api/admin/compliance/notices/${n.id}/issue`, {}, 'Notice issued - cure clock started')}
                    >
                      Issue notice
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Issued notices ({issued.length})</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {issued.length === 0 && <p className="text-sm text-muted-foreground">No notices issued yet.</p>}
                {issued.map((n) => (
                  <div key={n.id} className="space-y-2 border-b pb-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{n.templateKey}</span>
                      <Badge variant="outline">{n.outcome}</Badge>
                      <span className="text-muted-foreground">
                        Issued to {n.issuedToUid ?? 'vacant office'}
                        {n.priorHolderUid ? ` (prior holder ${n.priorHolderUid} recorded)` : ''} · Cure by{' '}
                        {n.cureDeadline?.slice(0, 10)}
                      </span>
                    </div>
                    <p className="text-muted-foreground">
                      Copies - Founder: {n.deliveryReceipts?.founder?.ok ? 'delivered' : 'NOT delivered (repair pass retries)'} ·
                      President: {n.deliveryReceipts?.president?.ok ? 'delivered' : 'NOT delivered (repair pass retries)'}
                    </p>
                    {n.cure && !n.cureReview && n.outcome === 'open' && (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => act(`/api/admin/compliance/notices/${n.id}/cure-review`, { outcome: 'accepted' }, 'Cure accepted')}
                        >
                          Accept cure
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={busy}
                          onClick={() => act(`/api/admin/compliance/notices/${n.id}/cure-review`, { outcome: 'rejected', note: 'Insufficient' }, 'Cure rejected - deadline unchanged')}
                        >
                          Reject cure
                        </Button>
                        <span className="self-center text-muted-foreground">Cure evidence: {n.cure.evidenceRef}</span>
                      </div>
                    )}
                    {n.outcome === 'escalated' && !n.intervention && (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => act(`/api/admin/compliance/notices/${n.id}/intervention`, { type: 'performed_directly', note: '' }, 'Intervention recorded')}
                        >
                          Founder: performed directly
                        </Button>
                        <Input
                          className="w-44"
                          placeholder="Interim due date (YYYY-MM-DD)"
                          value={newDueDate[n.id] ?? ''}
                          onChange={(e) => setNewDueDate((prev) => ({ ...prev, [n.id]: e.target.value }))}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || !newDueDate[n.id]}
                          onClick={() =>
                            act(
                              `/api/admin/compliance/notices/${n.id}/intervention`,
                              { type: 'interim_appointed', newDueDate: newDueDate[n.id] },
                              'Interim appointed - fresh obligation created',
                            )
                          }
                        >
                          Founder: appoint interim
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => act(`/api/admin/compliance/notices/${n.id}/intervention`, { type: 'officer_removed', note: '' }, 'Officer removed - record stands')}
                        >
                          Founder: officer removed
                        </Button>
                      </div>
                    )}
                    {n.intervention && <p className="text-muted-foreground">Intervention: {n.intervention.type}</p>}
                  </div>
                ))}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </AuthorizationGate>
  );
}
