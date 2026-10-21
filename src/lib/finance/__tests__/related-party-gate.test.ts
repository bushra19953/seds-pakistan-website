import { evaluateRelatedPartyGate } from '../related-party-gate';
import type { RelatedPartyData } from '@/lib/partners';

const fullDisclosure = {
  disclosedTo: 'national_general_secretary',
  disclosureDate: '2026-10-01',
  natureSummary: 'Founder holds equity in the vendor',
  extentSummary: 'Majority shareholder',
  valueSummary: 'Contract worth PKR 300,000 per year',
};

const approvedConsent = {
  exists: true,
  decision: 'consent_given',
  decisionDate: '2026-10-05',
  amountPkr: 300000,
};

function baseRp(overrides: Partial<RelatedPartyData> = {}): RelatedPartyData {
  return {
    channel: 2,
    disclosure: { ...fullDisclosure },
    benchmarking: null,
    boardApprovalDate: null,
    consentRequestId: 'consent-1',
    agreementRef: 'AGR-2026-001',
    contractSumPkr: 50000,
    paymentTerms: 'Net 30',
    scopeSummary: 'Platform maintenance',
    ...overrides,
  };
}

describe('evaluateRelatedPartyGate (spec Part C section 7, cases 19-21)', () => {
  it('non-related record passes with no missing items', () => {
    const r = evaluateRelatedPartyGate({ isRelatedParty: false }, null);
    expect(r.canActivate).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('case 19: active_blocked_without_disclosure', () => {
    const r = evaluateRelatedPartyGate(
      { isRelatedParty: true, relatedParty: baseRp({ disclosure: null }) },
      approvedConsent,
    );
    expect(r.canActivate).toBe(false);
    expect(r.missing.join(' ')).toMatch(/disclosure/i);
  });

  it('case 20: over_100k_blocked_without_benchmarking; trigger uses greater of pledged and contract sum', () => {
    const record = {
      isRelatedParty: true,
      financials: { pledgedAmount: 40000 },
      relatedParty: baseRp({ contractSumPkr: 150000 }),
    };
    const blocked = evaluateRelatedPartyGate(record, approvedConsent);
    expect(blocked.triggerValuePkr).toBe(150000);
    expect(blocked.canActivate).toBe(false);
    expect(blocked.missing.join(' ')).toMatch(/Benchmarking/);

    const oneQuote = evaluateRelatedPartyGate(
      {
        ...record,
        relatedParty: baseRp({
          contractSumPkr: 150000,
          benchmarking: { contractValuePkr: 150000, method: 'two_quotes', quoteDriveIds: ['q1'], boardReviewedAt: '2026-10-03' },
          boardApprovalDate: '2026-10-04',
        }),
      },
      approvedConsent,
    );
    expect(oneQuote.canActivate).toBe(false);

    const twoQuotes = evaluateRelatedPartyGate(
      {
        ...record,
        relatedParty: baseRp({
          contractSumPkr: 150000,
          benchmarking: { contractValuePkr: 150000, method: 'two_quotes', quoteDriveIds: ['q1', 'q2'], boardReviewedAt: '2026-10-03' },
          boardApprovalDate: '2026-10-04',
        }),
      },
      approvedConsent,
    );
    expect(twoQuotes.canActivate).toBe(true);

    const justification = evaluateRelatedPartyGate(
      {
        ...record,
        relatedParty: baseRp({
          contractSumPkr: 150000,
          benchmarking: {
            contractValuePkr: 150000,
            method: 'written_justification',
            justification: 'Specialised item with a single qualified supplier in the region.',
            boardReviewedAt: '2026-10-03',
          },
          boardApprovalDate: '2026-10-04',
        }),
      },
      approvedConsent,
    );
    expect(justification.canActivate).toBe(true);
  });

  it('case 21 (gate half): consent not decided-approved blocks and derives no date; approved derives the date', () => {
    const pending = evaluateRelatedPartyGate(
      { isRelatedParty: true, relatedParty: baseRp() },
      { exists: true, decision: null, decisionDate: null, amountPkr: null },
    );
    expect(pending.canActivate).toBe(false);
    expect(pending.founderConsentDate).toBeNull();

    const ok = evaluateRelatedPartyGate({ isRelatedParty: true, relatedParty: baseRp() }, approvedConsent);
    expect(ok.canActivate).toBe(true);
    expect(ok.founderConsentDate).toBe('2026-10-05');
  });

  it('under-threshold related record does not require benchmarking or board dates', () => {
    const r = evaluateRelatedPartyGate(
      { isRelatedParty: true, financials: { pledgedAmount: 90000 }, relatedParty: baseRp({ contractSumPkr: 90000 }) },
      approvedConsent,
    );
    expect(r.canActivate).toBe(true);
  });
});
