'use client';

import { useState } from 'react';
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';

export type ConsentDecisionAction =
  | 'consent_given'
  | 'consent_refused'
  | 'conditional_consent'
  | 'request_further_information'
  | 'waive';

interface Props {
  onDecide: (payload: Record<string, unknown>) => Promise<void>;
}

interface ActionSpec {
  action: ConsentDecisionAction;
  label: string;
  confirmTitle: string;
  confirmBody: string;
  variant?: 'default' | 'destructive' | 'outline';
}

const ACTIONS: ActionSpec[] = [
  {
    action: 'consent_given',
    label: 'Consent',
    confirmTitle: 'Record consent?',
    confirmBody:
      'Consent is recorded against this request and entered in the Register of Consents. This cannot be undone from the platform.',
  },
  {
    action: 'consent_refused',
    label: 'Refuse',
    variant: 'destructive',
    confirmTitle: 'Refuse consent?',
    confirmBody:
      'Refusal is final for this request. The requester must file a new request if the Act is proposed again. A reason is required.',
  },
  {
    action: 'conditional_consent',
    label: 'Conditional consent',
    variant: 'outline',
    confirmTitle: 'Record conditional consent?',
    confirmBody:
      'Consent takes effect only on the conditions or the narrowed scope recorded here. At least one of conditions or consented scope is required.',
  },
  {
    action: 'request_further_information',
    label: 'Request further information',
    variant: 'outline',
    confirmTitle: 'Request further information?',
    confirmBody:
      'The 30-day clock suspends now and restarts in full when the requester replies (Schedule s.4.4). Say exactly what is needed.',
  },
  {
    action: 'waive',
    label: 'Waive the requirement',
    variant: 'outline',
    confirmTitle: 'Waive the consent requirement?',
    confirmBody:
      'Waiver records that consent is not required for this Act (for example, wrong matter or a duplicate filing). The request closes as waived.',
  },
];

/**
 * The Founder decision panel. Every decision goes through a confirm
 * dialog stating its consequence; refusal requires a note, conditional
 * consent requires conditions and/or a consented scope, and a further
 * information request requires the question text.
 */
export default function ConsentDecisionPanel({ onDecide }: Props) {
  const [openAction, setOpenAction] = useState<ActionSpec | null>(null);
  const [note, setNote] = useState('');
  const [conditions, setConditions] = useState('');
  const [consentedScope, setConsentedScope] = useState('');
  const [refusedScope, setRefusedScope] = useState('');
  const [infoRequest, setInfoRequest] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setNote('');
    setConditions('');
    setConsentedScope('');
    setRefusedScope('');
    setInfoRequest('');
    setError(null);
  };

  const canConfirm = (() => {
    if (!openAction) return false;
    switch (openAction.action) {
      case 'consent_refused':
        return note.trim().length > 0;
      case 'conditional_consent':
        return conditions.trim().length > 0 || consentedScope.trim().length > 0;
      case 'request_further_information':
        return infoRequest.trim().length > 0;
      default:
        return true;
    }
  })();

  const confirm = async () => {
    if (!openAction) return;
    const payload: Record<string, unknown> = { action: openAction.action };
    if (openAction.action === 'consent_given' || openAction.action === 'consent_refused') {
      if (note.trim()) payload.decisionNote = note.trim();
    }
    if (openAction.action === 'conditional_consent') {
      if (conditions.trim()) payload.conditions = conditions.trim();
      if (consentedScope.trim()) payload.consentedScope = consentedScope.trim();
      if (refusedScope.trim()) payload.refusedScope = refusedScope.trim();
      if (note.trim()) payload.decisionNote = note.trim();
    }
    if (openAction.action === 'request_further_information') {
      payload.furtherInformationRequest = infoRequest.trim();
    }
    if (openAction.action === 'waive') {
      if (note.trim()) payload.decisionNote = note.trim();
    }
    setBusy(true);
    setError(null);
    try {
      await onDecide(payload);
      setOpenAction(null);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Decision failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Founder decision</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {ACTIONS.map((spec) => (
            <Button
              key={spec.action}
              variant={spec.variant ?? 'default'}
              onClick={() => {
                reset();
                setOpenAction(spec);
              }}
            >
              {spec.label}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Recording a decision attaches the Founder signature marker: a
          recorded attestation marker tied to the authenticated Founder
          session. It is not a cryptographic signature.
        </p>

        <Dialog
          open={openAction !== null}
          onOpenChange={(open) => {
            if (!open) setOpenAction(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{openAction?.confirmTitle}</DialogTitle>
              <DialogDescription>{openAction?.confirmBody}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              {openAction?.action === 'request_further_information' ? (
                <div className="space-y-2">
                  <Label htmlFor="infoRequest">What information is required?</Label>
                  <Textarea
                    id="infoRequest"
                    rows={4}
                    value={infoRequest}
                    onChange={(e) => setInfoRequest(e.target.value)}
                  />
                </div>
              ) : openAction?.action === 'conditional_consent' ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="conditions">Conditions</Label>
                    <Textarea
                      id="conditions"
                      rows={3}
                      value={conditions}
                      onChange={(e) => setConditions(e.target.value)}
                      placeholder="Consent is effective only if..."
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="consentedScope">Consented scope (narrowed Act)</Label>
                    <Textarea
                      id="consentedScope"
                      rows={3}
                      value={consentedScope}
                      onChange={(e) => setConsentedScope(e.target.value)}
                      placeholder="The part of the Act that is consented to"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="refusedScope">Refused scope (the part not consented to)</Label>
                    <Textarea
                      id="refusedScope"
                      rows={3}
                      value={refusedScope}
                      onChange={(e) => setRefusedScope(e.target.value)}
                      placeholder="State in full the part of the Act that is refused, if any"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="decisionNote">Decision note (optional)</Label>
                    <Textarea
                      id="decisionNote"
                      rows={2}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                  </div>
                </>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="decisionNote">
                    {openAction?.action === 'consent_refused'
                      ? 'Reason for refusal (required)'
                      : openAction?.action === 'waive'
                        ? 'Waiver note (optional)'
                        : 'Decision note (optional)'}
                  </Label>
                  <Textarea
                    id="decisionNote"
                    rows={3}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </div>
              )}
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpenAction(null)} disabled={busy}>
                Back
              </Button>
              <Button onClick={() => void confirm()} disabled={busy || !canConfirm}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Confirm
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
