'use client';

/**
 * Consent request picker (Phase 2, Workstream B - spec B.6).
 *
 * Lists DECIDED consent requests for exactly one matter + subject. It never
 * lists pending, refused, or deemed-withheld requests as selectable, never
 * fabricates or pre-creates a request, and performs no gate logic - the
 * server remains the authority (a stale list can cause a 409, never a false
 * pass).
 *
 * ADAPTER(W-A): the decided-requests read endpoint belongs to Workstream A.
 * This component fetches GET /api/admin/governance/consents/decided and codes
 * defensively (array or { requests } payload; any fetch failure renders the
 * empty state). If A exposes a different read shape, only this fetcher
 * changes.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useUser } from '@/firebase';
import {
  buildConsentFileUrl,
  type ConsentMatterKey,
  type ConsentSubjectRef,
} from '@/lib/server/consent-gate-types';

export interface DecidedConsentOption {
  id: string;
  requestNumber?: string;
  status: 'consented' | 'conditional';
  decisionLabel?: string;
  decidedAt?: string;
  proposedActDate?: string;
  expiresAt?: string;
  conditionsSatisfied?: boolean;
}

interface ConsentRequestPickerProps {
  matterKey: ConsentMatterKey;
  subjectRef: ConsentSubjectRef;
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}

function formatDate(value?: string): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB');
}

export function ConsentRequestPicker({
  matterKey,
  subjectRef,
  value,
  onChange,
  disabled,
}: ConsentRequestPickerProps) {
  const { user } = useUser();
  const [options, setOptions] = useState<DecidedConsentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const subjectJson = useMemo(() => JSON.stringify(subjectRef), [subjectRef]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        if (!user) throw new Error('no user');
        const token = await user.getIdToken();
        const url =
          `/api/admin/governance/consents/decided?matter=${encodeURIComponent(matterKey)}` +
          `&subjectType=${encodeURIComponent(subjectRef.type)}` +
          `&subject=${encodeURIComponent(subjectJson)}`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`decided consents fetch failed: ${res.status}`);
        const payload: unknown = await res.json();
        const list: unknown[] = Array.isArray(payload)
          ? payload
          : Array.isArray((payload as { requests?: unknown[] })?.requests)
            ? ((payload as { requests: unknown[] }).requests ?? [])
            : [];
        const decided = list.filter(
          (r): r is DecidedConsentOption =>
            !!r &&
            typeof r === 'object' &&
            ((r as DecidedConsentOption).status === 'consented' ||
              (r as DecidedConsentOption).status === 'conditional'),
        );
        if (!cancelled) setOptions(decided);
      } catch {
        // Endpoint not live yet (Workstream A pending) or network failure:
        // render the empty state rather than crashing the form.
        if (!cancelled) setOptions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, matterKey, subjectJson]);

  const fileUrl = buildConsentFileUrl(matterKey, subjectRef);
  const now = Date.now();

  if (!loading && options.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-3 text-sm" data-testid="consent-picker-empty">
        <p className="text-muted-foreground">No decided consent for this act yet.</p>
        <a
          href={fileUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block font-medium text-primary underline underline-offset-4"
        >
          File a consent request
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <select
        aria-label="Decided consent request"
        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        value={value ?? ''}
        disabled={disabled || loading}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      >
        <option value="">{loading ? 'Loading consents...' : 'Select a decided consent...'}</option>
        {options.map((opt) => {
          const expired = opt.expiresAt ? new Date(opt.expiresAt).getTime() < now : false;
          const conditionsUnmet = opt.status === 'conditional' && opt.conditionsSatisfied !== true;
          const suffix = expired
            ? ' - Expired'
            : conditionsUnmet
              ? ' - Conditions not yet confirmed'
              : '';
          const label =
            `${opt.requestNumber ?? opt.id.slice(0, 8)} - ` +
            `${opt.decisionLabel ?? (opt.status === 'conditional' ? 'Conditional Consent' : 'Consent given')}` +
            `${opt.decidedAt ? ` - decided ${formatDate(opt.decidedAt)}` : ''}` +
            `${opt.proposedActDate ? ` - act ${formatDate(opt.proposedActDate)}` : ''}` +
            `${opt.expiresAt ? ` - expires ${formatDate(opt.expiresAt)}` : ''}` +
            suffix;
          return (
            <option key={opt.id} value={opt.id} disabled={expired || conditionsUnmet}>
              {label}
            </option>
          );
        })}
      </select>
    </div>
  );
}
