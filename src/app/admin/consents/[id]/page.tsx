'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { FOUNDER_UID } from '@/lib/roles';
import { ConsentStatusBadge, UrgentBadge } from '@/components/admin/consents/consent-status-badge';
import ConsentDecisionPanel from '@/components/admin/consents/consent-decision-panel';
import ConsentRequestForm, {
  type ConsentFormValues,
} from '@/components/admin/consents/consent-request-form';
import ConsentAttachmentField from '@/components/admin/consents/consent-attachment-field';
import {
  consentApi,
  consentDecisionOf,
  consentHistoryOf,
  daysLeft,
  fmtDate,
} from '@/components/admin/consents/consent-api';
import type { ConsentAttachment } from '@/types/consent';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="text-sm">{children ?? '-'}</div>
    </div>
  );
}

export default function ConsentRequestDetailPage() {
  const { user } = useUser();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { toast } = useToast();
  const id = params.id;

  const [record, setRecord] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});

  const [infoResponse, setInfoResponse] = useState('');
  const [extraAttachments, setExtraAttachments] = useState<ConsentAttachment[]>([]);

  const [executeOpen, setExecuteOpen] = useState(false);
  const [executionNote, setExecutionNote] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const data = await consentApi(() => user.getIdToken(), `/api/consents/${id}`);
      setRecord(data);
      setLoadFailed(false);
    } catch (err) {
      // A failed load (e.g. the API 500s during a Firestore outage) is
      // NOT evidence the request does not exist; the render below keeps
      // the two states distinct (2026-10-30: FC-2026-0054's page showed
      // "Request not found." while the record sat consented on file).
      setLoadFailed(true);
      toast({
        title: 'Could not load this request',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [user, id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (!record) {
    if (loadFailed) {
      return (
        <div className="py-10 text-center text-sm">
          <p className="text-muted-foreground">
            Could not load this request. It may still exist — the server could not be reached.
          </p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => {
              setLoading(true);
              void load();
            }}
          >
            Try again
          </Button>
        </div>
      );
    }
    return <p className="py-10 text-center text-sm text-muted-foreground">Request not found.</p>;
  }

  const isFounder = user?.uid === FOUNDER_UID;
  const isOwn = user?.uid === record.requestedByUid;
  const remaining = daysLeft(record.decisionDeadlineAt);
  // The API record stores the decision FLAT and history entries as
  // { event, createdAt, actorUid, ... }; normalize before rendering so a
  // real record can never throw or render blank in this view.
  const decision = consentDecisionOf(record);
  const history = consentHistoryOf(record);
  const decidedStatuses = ['consented', 'refused', 'conditional', 'waived', 'deemed_withheld', 'executed'];
  const isDecided = decidedStatuses.includes(record.status);

  const post = async (path: string, body: Record<string, unknown>) => {
    await consentApi(() => user!.getIdToken(), path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  };

  const handleDecide = async (payload: Record<string, unknown>) => {
    await post(`/api/consents/${id}/decide`, payload);
    toast({ title: 'Decision recorded' });
    await load();
  };

  const handleSupplyInfo = async () => {
    setBusy(true);
    try {
      await post(`/api/consents/${id}/information`, {
        response: infoResponse,
        attachments: extraAttachments,
      });
      toast({ title: 'Information sent. The 30-day clock has restarted.' });
      setInfoResponse('');
      setExtraAttachments([]);
      await load();
    } catch (err) {
      toast({
        title: 'Could not send the information',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleExecute = async () => {
    setBusy(true);
    try {
      await post(`/api/consents/${id}/execute`, { executionNote });
      toast({ title: 'Marked as executed' });
      setExecuteOpen(false);
      await load();
    } catch (err) {
      toast({
        title: 'Could not mark executed',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    setBusy(true);
    try {
      await post(`/api/consents/${id}/cancel`, { cancellationReason: cancelReason });
      toast({ title: 'Request cancelled' });
      setCancelOpen(false);
      await load();
    } catch (err) {
      toast({
        title: 'Could not cancel',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  };

  const draftInitial: Partial<ConsentFormValues> = {
    matterKey: record.matterKey ?? '',
    proposedAct: record.proposedAct ?? '',
    materialFacts: record.materialFacts ?? '',
    amountPkr: record.amountPkr ?? null,
    counterparty: record.counterparty ?? '',
    proposedActDate: record.proposedActDate ?? '',
    isUrgent: record.isUrgent ?? false,
    urgencyReason: record.urgencyReason ?? '',
    relatedPartyName: record.relatedPartyName ?? '',
    relatedPartyInterest: record.relatedPartyInterest ?? '',
    attachments: record.attachments ?? [],
  };

  const saveDraft = async (values: ConsentFormValues, thenSubmit: boolean) => {
    setBusy(true);
    setServerErrors({});
    try {
      await consentApi(() => user!.getIdToken(), `/api/consents/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(values),
      });
      if (thenSubmit) {
        await post(`/api/consents/${id}/submit`, {});
        toast({ title: 'Consent request filed' });
      } else {
        toast({ title: 'Draft saved' });
      }
      await load();
    } catch (err: any) {
      if (err?.fields) setServerErrors(err.fields);
      toast({
        title: 'Could not save',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthorizationGate permission="canAccessAdmin">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">
              {record.requestNumber ?? 'Draft Consent Request'}
            </h1>
            <p className="text-sm text-muted-foreground">
              {record.scheduleSection} - {record.matterLabel}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {record.isUrgent && <UrgentBadge />}
            <ConsentStatusBadge status={record.status} />
          </div>
        </div>

        {record.status === 'pending' && (
          <Card>
            <CardContent className="py-4">
              <p className={`text-sm ${remaining !== null && remaining <= 7 ? 'font-semibold text-destructive' : ''}`}>
                Decision deadline: {fmtDate(record.decisionDeadlineAt)}
                {remaining !== null &&
                  (remaining < 0
                    ? ` (${Math.abs(remaining)} day(s) overdue)`
                    : ` (${remaining} day(s) left)`)}
                . Silence at the deadline means deemed withheld.
              </p>
              {record.isUrgent && (
                <p className="mt-1 text-sm">
                  This request is urgent: it carries a 48-hour handling expectation.
                  That is an expectation only - the 30-day clock above still governs.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {isOwn && record.status === 'draft' ? (
          <Card>
            <CardHeader>
              <CardTitle>Edit draft</CardTitle>
            </CardHeader>
            <CardContent>
              <ConsentRequestForm
                initial={draftInitial}
                submitting={busy}
                serverErrors={serverErrors}
                onSaveDraft={(v) => void saveDraft(v, false)}
                onSubmitRequest={(v) => void saveDraft(v, true)}
              />
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>The filing (Exhibit A)</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-5 sm:grid-cols-2">
              <Field label="Requesting person">{record.requesterName}</Field>
              <Field label="Role">{record.requesterRoleKey}</Field>
              <Field label="Chapter">{record.requesterChapterId ?? 'National'}</Field>
              <Field label="Date of request">{fmtDate(record.submittedAt ?? record.createdAt)}</Field>
              <div className="sm:col-span-2">
                <Field label="The Act proposed">
                  <span className="whitespace-pre-wrap">{record.proposedAct}</span>
                </Field>
              </div>
              <div className="sm:col-span-2">
                <Field label="All material facts">
                  <span className="whitespace-pre-wrap">{record.materialFacts}</span>
                </Field>
              </div>
              <Field label="Amount involved (PKR)">
                {record.amountPkr === null || record.amountPkr === undefined
                  ? 'None stated'
                  : record.amountPkr.toLocaleString('en-PK')}
              </Field>
              <Field label="Date the Act takes effect">{record.proposedActDate}</Field>
              <Field label="Counterparty">{record.counterparty || 'None'}</Field>
              <Field label="Urgency">
                {record.isUrgent ? `Urgent - ${record.urgencyReason ?? ''}` : 'Not urgent'}
              </Field>
              {record.matterKey === 'related_party_contract' && (
                <>
                  <Field label="Related party">{record.relatedPartyName}</Field>
                  <Field label="Nature of the interest">{record.relatedPartyInterest}</Field>
                </>
              )}
              <div className="sm:col-span-2">
                <Field label="Attachments">
                  <ConsentAttachmentField value={record.attachments ?? []} onChange={() => {}} readOnly />
                </Field>
              </div>
            </CardContent>
          </Card>
        )}

        {record.furtherInformationRequest && (
          <Card>
            <CardHeader>
              <CardTitle>Further information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field label="The Founder asked">
                <span className="whitespace-pre-wrap">{record.furtherInformationRequest}</span>
              </Field>
              {record.furtherInformationResponse ? (
                <Field label="Requester replied">
                  <span className="whitespace-pre-wrap">{record.furtherInformationResponse}</span>
                </Field>
              ) : isOwn && record.status === 'further_information_requested' ? (
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="infoResponse">Your reply</Label>
                    <Textarea
                      id="infoResponse"
                      rows={4}
                      value={infoResponse}
                      onChange={(e) => setInfoResponse(e.target.value)}
                      placeholder="Answer fully. The 30-day clock restarts when you send this."
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Additional attachments (you may add, never remove)</Label>
                    <ConsentAttachmentField value={extraAttachments} onChange={setExtraAttachments} />
                  </div>
                  <Button onClick={() => void handleSupplyInfo()} disabled={busy || infoResponse.trim().length === 0}>
                    {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Send information
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        )}

        {decision && (
          <Card>
            <CardHeader>
              <CardTitle>Decision of the Founder</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-5 sm:grid-cols-2">
              <Field label="Decision">
                {decision.decision === 'consent_given' && 'Consent given'}
                {decision.decision === 'consent_refused' && 'Consent refused'}
                {decision.decision === 'conditional_consent' && 'Conditional consent'}
              </Field>
              <Field label="Date of decision">{fmtDate(decision.decisionDate)}</Field>
              {decision.conditions && (
                <div className="sm:col-span-2">
                  <Field label="Conditions">
                    <span className="whitespace-pre-wrap">{decision.conditions}</span>
                  </Field>
                </div>
              )}
              {decision.consentedScope && (
                <div className="sm:col-span-2">
                  <Field label="Consented scope">
                    <span className="whitespace-pre-wrap">{decision.consentedScope}</span>
                  </Field>
                </div>
              )}
              {decision.refusedScope && (
                <div className="sm:col-span-2">
                  <Field label="Refused scope">
                    <span className="whitespace-pre-wrap">{decision.refusedScope}</span>
                  </Field>
                </div>
              )}
              {record.proposedActDate &&
                decision.decisionDate &&
                String(decision.decisionDate).slice(0, 10) > String(record.proposedActDate).slice(0, 10) && (
                  <div className="sm:col-span-2">
                    <p className="text-sm font-semibold">
                      Retroactive consent: the Act&apos;s proposed effective date
                      precedes this decision.
                    </p>
                  </div>
                )}
              {decision.decisionNote && (
                <div className="sm:col-span-2">
                  <Field label="Decision note">
                    <span className="whitespace-pre-wrap">{decision.decisionNote}</span>
                  </Field>
                </div>
              )}
              <div className="sm:col-span-2">
                <Field label="Founder signature marker">
                  <span className="break-all font-mono text-xs">{decision.founderSignatureMarker}</span>
                  <span className="block text-xs text-muted-foreground">
                    A recorded attestation marker tied to the authenticated Founder
                    session. It is not a cryptographic signature.
                  </span>
                </Field>
              </div>
            </CardContent>
          </Card>
        )}

        {record.status === 'waived' && (
          <Card>
            <CardHeader>
              <CardTitle>Waiver</CardTitle>
            </CardHeader>
            <CardContent>
              <Field label="Waiver note">
                <span className="whitespace-pre-wrap">{record.waiverNote || 'The consent requirement was waived for this request.'}</span>
              </Field>
            </CardContent>
          </Card>
        )}

        {record.status === 'deemed_withheld' && (
          <Card>
            <CardContent className="py-4">
              <p className="text-sm">
                No decision was recorded within 30 days, so this request is deemed
                withheld (stamped {fmtDate(record.deemedWithheldAt)}). File a new
                request if the Act is still proposed.
              </p>
            </CardContent>
          </Card>
        )}

        {record.status === 'executed' && (
          <Card>
            <CardContent className="py-4">
              <p className="text-sm">
                Executed on {fmtDate(record.executedAt)}.
                {record.executionNote ? ` Note: ${record.executionNote}` : ''}
              </p>
            </CardContent>
          </Card>
        )}

        {isFounder && record.status === 'pending' && (
          <ConsentDecisionPanel onDecide={handleDecide} />
        )}

        {isOwn && ['consented', 'conditional', 'waived'].includes(record.status) && (
          <Card>
            <CardContent className="flex flex-wrap items-center gap-3 py-4">
              <p className="text-sm">Once the Act has been carried out, mark it executed.</p>
              <Button onClick={() => setExecuteOpen(true)}>Mark executed</Button>
            </CardContent>
          </Card>
        )}

        {isOwn && ['draft', 'pending', 'further_information_requested'].includes(record.status) && record.status !== 'draft' && (
          <Card>
            <CardContent className="flex flex-wrap items-center gap-3 py-4">
              <p className="text-sm">Withdraw this request.</p>
              <Button variant="outline" onClick={() => setCancelOpen(true)}>
                Cancel request
              </Button>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
          </CardHeader>
          <CardContent>
            {history.length === 0 ? (
              <p className="text-sm text-muted-foreground">No history yet.</p>
            ) : (
              <ol className="space-y-3">
                {history.map((h, i) => (
                  <li key={i} className="border-l-2 pl-4">
                    <p className="text-sm font-medium">{h.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {fmtDate(h.at)} - {h.actor}
                    </p>
                    {h.note && <p className="whitespace-pre-wrap text-sm">{h.note}</p>}
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>

        <Dialog open={executeOpen} onOpenChange={setExecuteOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Mark as executed?</DialogTitle>
              <DialogDescription>
                Record that the consented Act has been carried out. This closes the
                request and is entered in the Register of Consents.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="executionNote">Execution note (optional)</Label>
              <Textarea
                id="executionNote"
                rows={3}
                value={executionNote}
                onChange={(e) => setExecutionNote(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setExecuteOpen(false)}>
                Back
              </Button>
              <Button onClick={() => void handleExecute()} disabled={busy}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Mark executed
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Cancel this request?</DialogTitle>
              <DialogDescription>
                The request closes as cancelled. This cannot be undone; file a new
                request if the Act is proposed again.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="cancelReason">Reason (optional)</Label>
              <Textarea
                id="cancelReason"
                rows={3}
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCancelOpen(false)}>
                Back
              </Button>
              <Button variant="destructive" onClick={() => void handleCancel()} disabled={busy}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Cancel request
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Button variant="ghost" onClick={() => router.push('/admin/consents')}>
          Back to my requests
        </Button>
      </div>
    </AuthorizationGate>
  );
}
