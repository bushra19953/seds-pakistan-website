'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2 } from 'lucide-react';
import { RESERVED_MATTERS } from '@/lib/consents/reserved-matters';
import type { ConsentAttachment } from '@/types/consent';
import ConsentAttachmentField from './consent-attachment-field';

export interface ConsentFormValues {
  matterKey: string;
  /** Dialog-link context (matcher fix): set when the form was arrived
   *  at from a gated surface's file-request link; persisted on the
   *  record so the gate can match the decided consent exactly. */
  subjectRef?: Record<string, unknown> | null;
  gateMatterKey?: string | null;
  proposedAct: string;
  materialFacts: string;
  amountPkr: number | null;
  counterparty: string;
  proposedActDate: string;
  isUrgent: boolean;
  urgencyReason: string;
  relatedPartyName: string;
  relatedPartyInterest: string;
  attachments: ConsentAttachment[];
}

interface Props {
  initial?: Partial<ConsentFormValues>;
  /** Server-side field errors from the last submit attempt. */
  serverErrors?: Record<string, string>;
  submitting?: boolean;
  onSaveDraft: (values: ConsentFormValues) => void;
  onSubmitRequest: (values: ConsentFormValues) => void;
}

const EMPTY: ConsentFormValues = {
  matterKey: '',
  proposedAct: '',
  materialFacts: '',
  amountPkr: null,
  counterparty: '',
  proposedActDate: '',
  isUrgent: false,
  urgencyReason: '',
  relatedPartyName: '',
  relatedPartyInterest: '',
  attachments: [],
};

/**
 * The Exhibit A filing form. Field order follows the Constitution's
 * Founder Consent Exhibit exactly. Client validation mirrors the server
 * validator; the server remains authoritative and its field errors are
 * shown inline when a submit is rejected.
 */
export default function ConsentRequestForm({
  initial,
  serverErrors,
  submitting = false,
  onSaveDraft,
  onSubmitRequest,
}: Props) {
  const [values, setValues] = useState<ConsentFormValues>({ ...EMPTY, ...initial });
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});

  const set = <K extends keyof ConsentFormValues>(key: K, value: ConsentFormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const errors = { ...localErrors, ...(serverErrors ?? {}) };
  const isRelatedParty = values.matterKey === 'related_party_contract';
  const err = (key: string) =>
    errors[key] ? <p className="text-sm text-destructive">{errors[key]}</p> : null;

  const validateLocal = (): boolean => {
    const next: Record<string, string> = {};
    if (values.proposedAct.trim().length > 0 && values.proposedAct.trim().length < 20) {
      next.proposedAct = 'Describe the Act in at least 20 characters.';
    }
    if (values.materialFacts.trim().length > 0 && values.materialFacts.trim().length < 20) {
      next.materialFacts = 'State the material facts in at least 20 characters.';
    }
    setLocalErrors(next);
    return Object.keys(next).length === 0;
  };

  return (
    <div className="space-y-6">
      <Alert>
        <AlertDescription>
          The Founder has 30 days from filing to decide. If no decision is
          recorded within 30 days, the request is deemed withheld. Filing
          complete and accurate information matters: if the Founder asks for
          further information, the 30-day clock restarts when you reply.
        </AlertDescription>
      </Alert>

      <div className="space-y-2">
        <Label htmlFor="matterKey">Reserved Matter (Reserved Powers Schedule)</Label>
        <Select value={values.matterKey} onValueChange={(v) => set('matterKey', v)}>
          <SelectTrigger id="matterKey">
            <SelectValue placeholder="Select the Reserved Matter" />
          </SelectTrigger>
          <SelectContent>
            {RESERVED_MATTERS.map((m) => (
              <SelectItem key={m.matterKey} value={m.matterKey}>
                {m.scheduleSection} - {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {err('matterKey')}
      </div>

      <div className="space-y-2">
        <Label htmlFor="proposedAct">The Act proposed</Label>
        <Textarea
          id="proposedAct"
          rows={3}
          value={values.proposedAct}
          onChange={(e) => set('proposedAct', e.target.value)}
          placeholder="What exactly is proposed? One Act per request."
        />
        {err('proposedAct')}
      </div>

      <div className="space-y-2">
        <Label htmlFor="materialFacts">All material facts</Label>
        <Textarea
          id="materialFacts"
          rows={5}
          value={values.materialFacts}
          onChange={(e) => set('materialFacts', e.target.value)}
          placeholder="Everything the Founder needs to decide: background, alternatives considered, risks, and anything adverse."
        />
        {err('materialFacts')}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="amountPkr">Amount involved (PKR), if any</Label>
          <Input
            id="amountPkr"
            type="number"
            min={0}
            step={1}
            value={values.amountPkr === null ? '' : String(values.amountPkr)}
            onChange={(e) => {
              const raw = e.target.value.trim();
              set('amountPkr', raw === '' ? null : Number(raw));
            }}
            placeholder="Leave blank if no amount"
          />
          {err('amountPkr')}
        </div>
        <div className="space-y-2">
          <Label htmlFor="proposedActDate">Date the Act is proposed to take effect</Label>
          <Input
            id="proposedActDate"
            type="date"
            value={values.proposedActDate}
            onChange={(e) => set('proposedActDate', e.target.value)}
          />
          {err('proposedActDate')}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="counterparty">Counterparty, if any</Label>
        <Input
          id="counterparty"
          value={values.counterparty}
          onChange={(e) => set('counterparty', e.target.value)}
          placeholder="Who is on the other side of this Act?"
        />
        {err('counterparty')}
      </div>

      {isRelatedParty && (
        <div className="grid gap-4 rounded-md border p-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="relatedPartyName">Related party name (required)</Label>
            <Input
              id="relatedPartyName"
              value={values.relatedPartyName}
              onChange={(e) => set('relatedPartyName', e.target.value)}
            />
            {err('relatedPartyName')}
          </div>
          <div className="space-y-2">
            <Label htmlFor="relatedPartyInterest">Nature of the interest (required)</Label>
            <Input
              id="relatedPartyInterest"
              value={values.relatedPartyInterest}
              onChange={(e) => set('relatedPartyInterest', e.target.value)}
            />
            {err('relatedPartyInterest')}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id="isUrgent"
            checked={values.isUrgent}
            onCheckedChange={(checked) => set('isUrgent', checked === true)}
          />
          <Label htmlFor="isUrgent">This request is urgent</Label>
        </div>
        {values.isUrgent && (
          <div className="space-y-2">
            <Label htmlFor="urgencyReason">Why is it urgent?</Label>
            <Textarea
              id="urgencyReason"
              rows={2}
              value={values.urgencyReason}
              onChange={(e) => set('urgencyReason', e.target.value)}
            />
            {err('urgencyReason')}
          </div>
        )}
        {err('isUrgent')}
      </div>

      <div className="space-y-2">
        <Label>Attachments</Label>
        <ConsentAttachmentField
          value={values.attachments}
          onChange={(next) => set('attachments', next)}
        />
        {err('attachments')}
      </div>

      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={submitting}
          onClick={() => onSaveDraft(values)}
        >
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save draft
        </Button>
        <Button
          type="button"
          disabled={submitting}
          onClick={() => {
            if (validateLocal()) onSubmitRequest(values);
          }}
        >
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          File request
        </Button>
      </div>
    </div>
  );
}
