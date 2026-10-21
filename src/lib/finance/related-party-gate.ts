import type { RelatedPartyData } from '@/lib/partners';
import { BENCHMARKING_TRIGGER_PKR } from '@/types/finance';

/**
 * Related-party Active gate (spec Part C 3.7 + 6.4, CH-19). PURE function:
 * shared by the client pre-check (UX only), the server related-party API
 * (authoritative), the money-approval apply step for crm_status_active,
 * and the public organizations gate (CH-20).
 *
 * A record with isRelatedParty true cannot reach status Active (and a
 * linked organization cannot be publicly displayed) unless: disclosure
 * fully recorded AND, when the trigger value exceeds PKR 100,000,
 * benchmarking recorded AND boardApprovalDate set AND consentRequestId
 * references a decided-approved Phase 2 consent. The trigger value is the
 * GREATER of financials.pledgedAmount and relatedParty.contractSumPkr, so
 * splitting values across fields cannot dodge the trigger.
 */

export interface ConsentViewLike {
  exists: boolean;
  decision: string | null;
  decisionDate: string | null;
  amountPkr: number | null;
}

export interface RelatedPartyGateInput {
  isRelatedParty?: boolean;
  financials?: { pledgedAmount?: number } | null;
  relatedParty?: RelatedPartyData | null;
}

export interface RelatedPartyGateResult {
  canActivate: boolean;
  missing: string[];
  /** Derived from the linked consent record; never a stored free date. */
  founderConsentDate: string | null;
  triggerValuePkr: number;
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

export function evaluateRelatedPartyGate(
  record: RelatedPartyGateInput,
  consentView: ConsentViewLike | null,
): RelatedPartyGateResult {
  const pledged = record.financials?.pledgedAmount ?? 0;
  const contractSum = record.relatedParty?.contractSumPkr ?? 0;
  const triggerValuePkr = Math.max(pledged, contractSum);

  if (!record.isRelatedParty) {
    return { canActivate: true, missing: [], founderConsentDate: null, triggerValuePkr };
  }

  const missing: string[] = [];
  const rp = record.relatedParty ?? null;

  // Disclosure (RP-04): all five fields, recipient must be the National General Secretary.
  const d = rp?.disclosure ?? null;
  if (!d) {
    missing.push('Written disclosure record (RP-04) is not recorded');
  } else {
    if (d.disclosedTo !== 'national_general_secretary') {
      missing.push('Disclosure must be made to the National General Secretary');
    }
    if (!nonEmpty(d.disclosureDate)) missing.push('Disclosure date is missing');
    if (!nonEmpty(d.natureSummary)) missing.push('Disclosure: nature of the interest is missing');
    if (!nonEmpty(d.extentSummary)) missing.push('Disclosure: extent of the interest is missing');
    if (!nonEmpty(d.valueSummary)) missing.push('Disclosure: commercial value summary is missing');
  }

  if (!rp || !nonEmpty(rp.agreementRef)) {
    missing.push('Agreement reference (Exhibit A) is missing');
  }

  // Benchmarking (RP-05): required when the trigger exceeds PKR 100,000.
  if (triggerValuePkr > BENCHMARKING_TRIGGER_PKR) {
    const b = rp?.benchmarking ?? null;
    if (!b) {
      missing.push('Benchmarking record is required above PKR 100,000 (RP-05)');
    } else if (b.method === 'two_quotes') {
      if (!Array.isArray(b.quoteDriveIds) || b.quoteDriveIds.filter(nonEmpty).length < 2) {
        missing.push('Benchmarking requires at least two independent quotes');
      }
    } else if (b.method === 'written_justification') {
      if (!nonEmpty(b.justification) || (b.justification as string).trim().length < 50) {
        missing.push('Benchmarking written justification must be at least 50 characters');
      }
    } else {
      missing.push('Benchmarking method is not set');
    }
    if (!b || !nonEmpty(b.boardReviewedAt)) {
      missing.push('Board review date for the benchmarking comparison is missing');
    }
    if (!rp || !nonEmpty(rp.boardApprovalDate)) {
      missing.push('Board approval date is missing');
    }
  }

  // Founder Consent (RP-07): linked record only; the date is derived.
  let founderConsentDate: string | null = null;
  if (!rp || !nonEmpty(rp.consentRequestId)) {
    missing.push('Founder Consent record is not linked');
  } else if (
    !consentView ||
    !consentView.exists ||
    (consentView.decision !== 'consent_given' && consentView.decision !== 'conditional_consent')
  ) {
    missing.push('Linked Founder Consent is not decided-approved');
  } else {
    founderConsentDate = consentView.decisionDate;
  }

  return { canActivate: missing.length === 0, missing, founderConsentDate, triggerValuePkr };
}

/** Ledger category consistency for a related-party channel (spec 3.2). */
export function categoryMatchesChannel(category: string, channel: number): boolean {
  switch (channel) {
    case 1:
      return true; // channel 1 (ED remuneration): any expense category, note required in description
    case 2:
      return category === 'platform_services';
    case 3:
      return category === 'facilities_equipment';
    case 4:
      return category === 'professional_fees';
    case 5:
      return category === 'ip_licensing';
    default:
      return false;
  }
}
