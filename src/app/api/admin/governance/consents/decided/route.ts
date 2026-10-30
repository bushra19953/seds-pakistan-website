/**
 * Decided consents for one gated act - the read the Consent Request
 * Picker has always fetched (matcher fix, 2026-10-26). This route did
 * not exist: the picker got a 404, swallowed it, and rendered "No
 * decided consent for this act yet." for every act, however many
 * decided consents were on file (FC-2026-0020 / 0047 / 0048 / 0049
 * all invisible). It returns only usable decided consents for the
 * exact matter + subject - across gate-shaped, stamped-filing, and
 * legacy user-filed representations (listDecidedConsentsForAct) -
 * with expired records excluded (the gate remains the authority: a
 * stale list can cause a 409, never a false pass).
 */

import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import {
  CONSENT_GATE_MATTER_KEYS,
  type ConsentMatterKey,
  type ConsentSubjectRef,
} from '@/lib/server/consent-gate-types';
import {
  ConsentLookupDegradedError,
  listDecidedConsentsForAct,
  type DecidedConsentDoc,
} from '@/lib/server/consent-lookup';
import { consentExpiryDate, toDate } from '@/lib/server/consent-gate';
import { getConsentMatterSettings } from '@/lib/server/governance-settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function iso(value: unknown): string | undefined {
  const d = toDate(value);
  return d ? d.toISOString() : undefined;
}

function serialize(doc: DecidedConsentDoc, validityDays: number) {
  const decidedAt =
    iso(doc.decidedAt) ??
    iso((doc as Record<string, unknown>).decisionDate) ??
    iso((doc as Record<string, unknown>).decidedAtSort);
  const expiry = consentExpiryDate(
    doc.decidedAt != null
      ? doc
      : ({
          ...doc,
          decidedAt:
            (doc as Record<string, unknown>).decisionDate ??
            (doc as Record<string, unknown>).decidedAtSort ??
            undefined,
        } as DecidedConsentDoc),
    validityDays,
  );
  return {
    expired: expiry ? expiry.getTime() < Date.now() : false,
    option: {
      id: doc.id,
      requestNumber:
        typeof doc.requestNumber === 'string' ? doc.requestNumber : undefined,
      status: doc.status,
      decisionLabel:
        doc.decision === 'consent_given'
          ? 'Consent given'
          : doc.decision === 'conditional_consent'
            ? 'Conditional Consent'
            : undefined,
      decidedAt,
      proposedActDate:
        typeof doc.proposedActDate === 'string' ? doc.proposedActDate : undefined,
      expiresAt: expiry ? expiry.toISOString() : undefined,
      conditionsSatisfied: doc.conditionsSatisfied === true,
    },
  };
}

export async function GET(request: NextRequest) {
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const role = (auth.user as { role?: string }).role || '';
  if (!(await hasServerPermission(role, 'canAccessAdmin'))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const matter = searchParams.get('matter') ?? '';
  const subjectType = searchParams.get('subjectType') ?? '';
  const subjectRaw = searchParams.get('subject') ?? '';
  if (!CONSENT_GATE_MATTER_KEYS.includes(matter as ConsentMatterKey)) {
    return NextResponse.json({ error: 'Unknown matter' }, { status: 400 });
  }
  let subjectRef: ConsentSubjectRef;
  try {
    subjectRef = JSON.parse(subjectRaw) as ConsentSubjectRef;
  } catch {
    return NextResponse.json({ error: 'Invalid subject' }, { status: 400 });
  }
  if (!subjectRef || typeof subjectRef !== 'object' || subjectRef.type !== subjectType) {
    return NextResponse.json({ error: 'Invalid subject' }, { status: 400 });
  }

  ensureAdminInitialized();
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  try {
    const matterKey = matter as ConsentMatterKey;
    const settings = await getConsentMatterSettings(db, matterKey);
    const docs = await listDecidedConsentsForAct(db, matterKey, subjectRef);
    const requests = docs
      .map((doc) => serialize(doc, settings.validityDays))
      .filter((row) => !row.expired)
      .map((row) => row.option);
    return NextResponse.json({ requests });
  } catch (err) {
    if (err instanceof ConsentLookupDegradedError) {
      // Degraded, not empty: at least one lookup arm failed or timed
      // out and nothing matched, so an empty list would be a false
      // claim ("No decided consent for this act yet"). 503 makes the
      // picker render its load-error state with Retry instead.
      console.error('[admin/governance/consents/decided] lookup degraded', err);
      return NextResponse.json({ error: 'Consent lookup degraded' }, { status: 503 });
    }
    console.error('[admin/governance/consents/decided] lookup failed', err);
    return NextResponse.json({ error: 'Consent lookup failed' }, { status: 500 });
  }
}
