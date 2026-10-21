'use client';

/**
 * Blocked-action surface for consent-gate 409s (Phase 2, Workstream B - spec
 * B.6). One dialog for every gated surface so the admin experience is
 * identical everywhere. There is deliberately NO "proceed anyway" action in
 * any mode: the only ways forward are filing a consent request or cancelling.
 */

import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { ConsentGateErrorBody } from '@/lib/client/consent-gate-error';

export const CONSENT_MATTER_LABELS: Record<string, string> = {
  catb_officer: 'Appointing or removing a national officer (Category B)',
  chapter_lifecycle: 'Admitting, suspending or expelling a chapter',
  role_catalog: 'Amending the role catalog',
  sponsor_partner_flagged:
    'Recording a conditional or related-party sponsor/partner arrangement',
};

export const CONSENT_REASON_LINES: Record<string, string> = {
  missing: 'No consent request was selected.',
  not_found: 'The selected consent request could not be found.',
  not_decided: 'The selected request has not been decided yet.',
  refused: 'Consent was refused for this act.',
  deemed_withheld: 'Consent was deemed withheld for this act.',
  conditional_unmet: 'Consent was given with conditions that have not been confirmed as met.',
  wrong_matter: 'The selected consent covers a different Reserved Matter.',
  wrong_subject: 'The selected consent covers a different person, chapter, or role.',
  expired: 'The selected consent has expired.',
  already_consumed: 'The selected consent has already been used for another act.',
};

interface ConsentRequiredDialogProps {
  open: boolean;
  body: ConsentGateErrorBody | null;
  onClose: () => void;
}

export function ConsentRequiredDialog({ open, body, onClose }: ConsentRequiredDialogProps) {
  const matterLabel = body ? (CONSENT_MATTER_LABELS[body.matter] ?? body.matter) : '';
  const reasonLine = body
    ? (CONSENT_REASON_LINES[body.reason] ?? 'Founder Consent is required for this act.')
    : '';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Founder Consent required</DialogTitle>
          <DialogDescription>
            {matterLabel}
            {matterLabel && reasonLine ? ' - ' : ''}
            {reasonLine}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {body?.fileRequestUrl ? (
            <Button type="button" asChild>
              <a href={body.fileRequestUrl} target="_blank" rel="noreferrer">
                File a consent request
              </a>
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
