/**
 * @jest-environment node
 */
// Public organizations gate tests (spec Part C section 7, case 22, CH-20).
import { orgPassesPublicGate } from '../public-org-gate';

const rpComplete = {
  channel: 2 as const,
  agreementRef: 'drv-agreement',
  contractSumPkr: null,
  boardApprovalDate: '2026-09-20',
  consentRequestId: 'consent-1',
  paymentTerms: '',
  scopeSummary: '',
  disclosure: {
    disclosedTo: 'national_general_secretary',
    disclosureDate: '2026-09-10',
    natureSummary: 'Founder owns the supplier',
    extentSummary: 'Sole supplier',
    valueSummary: 'PKR 200,000 per year',
  },
  benchmarking: {
    contractValuePkr: 200000,
    method: 'two_quotes' as const,
    quoteDriveIds: ['q1', 'q2'],
    boardReviewedAt: '2026-09-18',
  },
};
const consentOk = { exists: true, decision: 'consent_given', decisionDate: '2026-09-15', amountPkr: 200000 };

describe('public organizations gate (case 22)', () => {
  it('related party + Active + gate satisfied + logo granted = shown', () => {
    expect(
      orgPassesPublicGate(
        { partnerId: 'p1', logoUseGranted: true },
        { status: 'Active', isRelatedParty: true, financials: { pledgedAmount: 200000 }, relatedParty: rpComplete },
        consentOk,
      ),
    ).toBe(true);
  });

  it('related party + Active + gate NOT satisfied = hidden', () => {
    expect(
      orgPassesPublicGate(
        { partnerId: 'p1', logoUseGranted: true },
        {
          status: 'Active',
          isRelatedParty: true,
          financials: { pledgedAmount: 200000 },
          relatedParty: { ...rpComplete, disclosure: null },
        },
        consentOk,
      ),
    ).toBe(false);
  });

  it('non-related party + Active + logo granted = shown; non-Active or ungranted = hidden', () => {
    expect(
      orgPassesPublicGate({ partnerId: 'p1', logoUseGranted: true }, { status: 'Active', isRelatedParty: false }, null),
    ).toBe(true);
    expect(
      orgPassesPublicGate({ partnerId: 'p1', logoUseGranted: true }, { status: 'Negotiation', isRelatedParty: false }, null),
    ).toBe(false);
    expect(
      orgPassesPublicGate({ partnerId: 'p1', logoUseGranted: false }, { status: 'Active', isRelatedParty: false }, null),
    ).toBe(false);
  });

  it('organization with no partner link is unaffected', () => {
    expect(orgPassesPublicGate({ partnerId: null }, null, null)).toBe(true);
    expect(orgPassesPublicGate({}, null, null)).toBe(true);
  });
});
