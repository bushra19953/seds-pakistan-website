/**
 * @jest-environment node
 */
// Related-party API tests (spec Part C 4.7): the consent date is derived,
// never accepted from the client; money changes route to approvals.
import { createFakeFirestore, type FakeFirestore } from '@/lib/finance/__tests__/fake-firestore';

const holder: { db: FakeFirestore | null } = { db: null };
const uidRoles: Record<string, string> = { crm1: 'crm_admin' };
const rolePerms: Record<string, Set<string>> = { crm_admin: new Set(['canManageSponsorsPartners']) };

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: { auth: () => ({ verifyIdToken: async (token: string) => ({ uid: token.replace('token-', '') }) }) },
}));
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => holder.db,
  admin: { auth: () => ({ verifyIdToken: async (token: string) => ({ uid: token.replace('token-', '') }) }) },
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }), arrayUnion: (v: unknown) => ({ __arrayUnion: v }) },
}));
const customGrants: Record<string, { perms: Set<string>; expired: boolean }> = {
  'custom-holder': { perms: new Set(['canManageSponsorsPartners']), expired: false },
  'expired-holder': { perms: new Set(['canManageSponsorsPartners']), expired: true },
};
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async (role: string, perm: string) => rolePerms[role]?.has(perm) ?? false),
  hasServerPermissionForUser: jest.fn(
    async (_db: unknown, uid: string, perm: string) =>
      (rolePerms[uidRoles[uid] ?? 'member']?.has(perm) ?? false) ||
      (!!customGrants[uid] && !customGrants[uid].expired && customGrants[uid].perms.has(perm)),
  ),
  resolveCanonicalRole: jest.fn(async (_db: unknown, uid: string) => uidRoles[uid] ?? 'member'),
}));

import { GET, PUT } from '../route';

function req(uid: string, body?: unknown, url = 'http://localhost/api/admin/partners/related-party?id=rp-1') {
  return {
    method: 'PUT',
    url,
    headers: { get: (h: string) => (h.toLowerCase() === 'authorization' ? `Bearer token-${uid}` : null) },
    json: async () => body ?? {},
  } as never;
}

describe('related-party API', () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = createFakeFirestore() as never;
    holder.db = db;
    db.__seed('sponsors_partners', 'rp-1', {
      organizationName: 'Founder Co',
      status: 'Negotiation',
      isRelatedParty: true,
      isFounderCommercialEntity: true,
      relatedParty: {
        channel: 2, consentRequestId: 'consent-1', agreementRef: 'drv-agreement',
        contractSumPkr: null, boardApprovalDate: '2026-09-20',
        disclosure: {
          disclosedTo: 'national_general_secretary', disclosureDate: '2026-09-10',
          natureSummary: 'Founder owns the supplier', extentSummary: 'Sole supplier of platform services',
          valueSummary: 'PKR 200,000 per year',
        },
        benchmarking: {
          contractValuePkr: 200000, method: 'two_quotes',
          quoteDriveIds: ['q1', 'q2'], boardReviewedAt: '2026-09-18',
        },
      },
      financials: { pledgedAmount: 200000, amountReceived: 0, currency: 'PKR' },
    });
    db.__seed('consent_requests', 'consent-1', {
      decision: 'consent_given', decisionDate: '2026-09-15', amountPkr: 200000, status: 'decided',
    });
  });

  it('GET derives the founder consent date from the consent record and passes the gate', async () => {
    const res = await GET(req('crm1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.founderConsentDate).toBe('2026-09-15');
    expect(body.gate.canActivate).toBe(true);
    expect(body.gate.triggerValuePkr).toBe(200000);
  });

  it('PUT with a bare founderConsentDate is 422', async () => {
    const res = await PUT(req('crm1', { id: 'rp-1', founderConsentDate: '2026-01-01' }));
    expect(res.status).toBe(422);
  });

  it('PUT with a differing money field is 409 requiresApproval crm_financial_edit', async () => {
    const res = await PUT(req('crm1', { id: 'rp-1', financials: { pledgedAmount: 300000 } }));
    expect(res.status).toBe(409);
    expect((await res.json()).requiresApproval).toBe('crm_financial_edit');
    expect(db.__doc('sponsors_partners', 'rp-1')?.financials).toMatchObject({ pledgedAmount: 200000 });
  });

  it('PUT applies non-money register fields directly and audits', async () => {
    const res = await PUT(req('crm1', { id: 'rp-1', changes: { 'relatedParty.agreementRef': 'drv-new' } }));
    expect(res.status).toBe(200);
    const rec = db.__doc('sponsors_partners', 'rp-1')!;
    expect((rec.relatedParty as { agreementRef: string }).agreementRef).toBe('drv-new');
    const logs = [...(db.__store.get('audit_logs')?.values() ?? [])];
    expect(logs.some((l) => l.action === 'CRM_RELATED_PARTY_UPDATED')).toBe(true);
  });
});

describe('related-party parity: custom-role holder (Family C, C20/C21)', () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = createFakeFirestore() as never;
    holder.db = db;
    db.__seed('sponsors_partners', 'rp-1', {
      organizationName: 'Founder Co',
      status: 'Negotiation',
      isRelatedParty: true,
      isFounderCommercialEntity: true,
      relatedParty: {
        channel: 2, consentRequestId: 'consent-1', agreementRef: 'drv-agreement',
        contractSumPkr: null, boardApprovalDate: '2026-09-20',
        disclosure: {
          disclosedTo: 'national_general_secretary', disclosureDate: '2026-09-10',
          natureSummary: 'Founder owns the supplier', extentSummary: 'Sole supplier of platform services',
          valueSummary: 'PKR 200,000 per year',
        },
        benchmarking: {
          contractValuePkr: 200000, method: 'two_quotes',
          quoteDriveIds: ['q1', 'q2'], boardReviewedAt: '2026-09-18',
        },
      },
      financials: { pledgedAmount: 200000, amountReceived: 0, currency: 'PKR' },
    });
    db.__seed('consent_requests', 'consent-1', {
      decision: 'consent_given', decisionDate: '2026-09-15', amountPkr: 200000, status: 'decided',
    });
  });

  it('primary member + unexpired custom canManageSponsorsPartners grant passes GET (C20)', async () => {
    const res = await GET(req('custom-holder'));
    expect(res.status).toBe(200);
  });

  it('expired custom grant falls back to the original denial (403)', async () => {
    const res = await GET(req('expired-holder'));
    expect(res.status).toBe(403);
  });

  it('primary member with no grant is denied unchanged (403)', async () => {
    const res = await GET(req('plain-member'));
    expect(res.status).toBe(403);
  });
});
