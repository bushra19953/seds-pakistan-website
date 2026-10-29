/**
 * @jest-environment node
 */
// Public organizations gate tests (spec Part C section 7, case 22, CH-20).
import { filterPublicOrganizations, orgPassesPublicGate } from '../public-org-gate';

const mockSupaListAllPartners = jest.fn(async (): Promise<any[] | null> => null);
const mockGetConsentView = jest.fn(async (): Promise<any> => ({
  exists: true,
  status: 'decided',
  decision: 'consent_given',
  decisionDate: '2026-09-15',
  amountPkr: 200000,
}));

jest.mock('@/lib/server/crm-supa', () => ({
  supaListAllPartners: () => mockSupaListAllPartners(),
}));
jest.mock('@/lib/finance/adapters', () => ({
  getConsentView: (...args: any[]) => mockGetConsentView(...(args as [])),
}));

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

describe('filterPublicOrganizations partner fetching (read-bleed bound)', () => {
  const activePartner = { status: 'Active', isRelatedParty: false };

  function fakeDb(partners: Record<string, any>) {
    const calls: Array<Record<string, any>> = [];
    const db = {
      collection: (name: string) => ({
        where: (_field: unknown, op: string, ids: string[]) => {
          calls.push({ name, op, ids });
          return {
            get: async () => {
              const docs = ids
                .filter((id) => id in partners)
                .map((id) => ({ id, data: () => partners[id] }));
              return { docs, forEach: (cb: (d: any) => void) => docs.forEach(cb) };
            },
          };
        },
        doc: (id: string) => ({
          get: async () => {
            calls.push({ name, docGet: id });
            return { exists: id in partners, data: () => partners[id] };
          },
        }),
      }),
    };
    return { db: db as any, calls };
  }

  beforeEach(() => {
    mockSupaListAllPartners.mockReset();
    mockSupaListAllPartners.mockResolvedValue(null);
    mockGetConsentView.mockClear();
  });

  it('fetches every linked partner in ONE query, preserving the gated set and order', async () => {
    const partners = {
      p1: activePartner,
      p2: { status: 'Negotiation', isRelatedParty: false },
      p3: activePartner,
      p4: activePartner,
      p5: { status: 'Active', isRelatedParty: false },
      // p6: logo not granted on the org side; p7: partner record missing.
    };
    const { db, calls } = fakeDb(partners);
    const orgs = [
      { id: 'o-unlinked', partnerId: null, logoUseGranted: false },
      { id: 'o2', partnerId: 'p2', logoUseGranted: true },
      { id: 'o1', partnerId: 'p1', logoUseGranted: true },
      { id: 'o7', partnerId: 'p7', logoUseGranted: true },
      { id: 'o3', partnerId: 'p3', logoUseGranted: true },
      { id: 'o6', partnerId: 'p5', logoUseGranted: false },
      { id: 'o4', partnerId: 'p4', logoUseGranted: true },
      { id: 'o1b', partnerId: 'p1', logoUseGranted: true },
    ];

    const out = await filterPublicOrganizations(db, orgs);

    // Same set, same order as the per-link gate produced.
    expect(out.map((o) => o.id)).toEqual(['o-unlinked', 'o1', 'o3', 'o4', 'o1b']);
    // Exactly one batched query over the unique linked ids; no per-doc gets.
    const queries = calls.filter((c) => c.op === 'in');
    expect(queries).toHaveLength(1);
    expect(queries[0].name).toBe('sponsors_partners');
    expect(new Set(queries[0].ids)).toEqual(new Set(['p1', 'p2', 'p3', 'p4', 'p5', 'p7']));
    expect(calls.filter((c) => c.docGet)).toEqual([]);
  });

  it('uses one seam list read when the CRM seam is serving, with no Firestore query', async () => {
    mockSupaListAllPartners.mockResolvedValue([
      { id: 'p1', status: 'Active', isRelatedParty: false },
    ]);
    const { db, calls } = fakeDb({});
    const orgs = [
      { id: 'o1', partnerId: 'p1', logoUseGranted: true },
      { id: 'o2', partnerId: 'p2', logoUseGranted: true },
    ];

    const out = await filterPublicOrganizations(db, orgs);

    expect(out.map((o) => o.id)).toEqual(['o1']);
    expect(mockSupaListAllPartners).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it('fetches a shared consent view once per consentRequestId', async () => {
    const rpPartner = {
      status: 'Active',
      isRelatedParty: true,
      financials: { pledgedAmount: 200000 },
      relatedParty: rpComplete,
    };
    const { db } = fakeDb({ p1: rpPartner, p2: rpPartner });
    const orgs = [
      { id: 'o1', partnerId: 'p1', logoUseGranted: true },
      { id: 'o2', partnerId: 'p2', logoUseGranted: true },
    ];

    const out = await filterPublicOrganizations(db, orgs);

    expect(out.map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(mockGetConsentView).toHaveBeenCalledTimes(1);
  });

  it('makes no partner fetch at all when no organisation is linked', async () => {
    const { db, calls } = fakeDb({});
    const orgs = [{ id: 'o1', partnerId: null }, { id: 'o2' }];

    const out = await filterPublicOrganizations(db, orgs);

    expect(out.map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(calls).toEqual([]);
    expect(mockSupaListAllPartners).not.toHaveBeenCalled();
  });
});
