/**
 * @jest-environment node
 *
 * Heap-guard tests for src/app/api/admin/partners/export/route.ts
 * (fix/partners-export-streaming-v2): the route built the full CSV
 * string in memory (rows array + one joined string) before serving. It
 * now streams lines out. The input shape is deliberately the pinned
 * seam-contract shape: the fallback is exactly one collection .get()
 * (no orderBy/limit/startAfter chaining, no new imports) — the v1
 * paging idea is withdrawn because the G4 handle contract does not
 * allow query chaining, and these tests use a { get }-only mock db so
 * a reintroduction of chaining fails here the way it failed the
 * pinned crm-seam-first and supa-flag-on suites. Test 1 pins the CSV
 * bytes for a small fixture (field order, escaping, defaults); test 2
 * proves the fallback streams 600 docs off a single .get() with the
 * exact audit count.
 */
import { NextRequest } from 'next/server';

const mockAudit = jest.fn();
const mockBatchCommit = jest.fn();
const mockGet = jest.fn();
let currentDb: any = null;

function doc(id: string, data: any) {
  return { id, data: () => data };
}

function ts(iso: string) {
  return { toDate: () => new Date(iso) };
}

function mockDbFor() {
  return {
    // Contract shape: collection() exposes .get() only. No orderBy,
    // limit, or startAfter exists on this object by design.
    collection: () => ({ get: mockGet }),
    batch: () => ({ commit: mockBatchCommit }),
  };
}

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({ authenticated: true, user: { userId: 'admin-1' } }),
}));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: async () => true,
}));
jest.mock('@/lib/server/backup-exports/g4-data', () => ({
  getG4Db: () => currentDb,
  getG4Handle: () => null,
  rehydratePartnerTimestamps: (d: any) => d,
}));
jest.mock('@/lib/server/crm-supa', () => ({
  supaListAllPartners: async () => null,
}));
jest.mock('@/lib/server/finance-audit', () => ({
  writeFinanceAudit: mockAudit,
}));

import { GET } from './route';

function exportRequest() {
  return new NextRequest('http://localhost/api/admin/partners/export');
}

const HEADERS = [
  'organizationName', 'status', 'relationshipType', 'sponsorshipTier',
  'primaryContact.name', 'primaryContact.email', 'primaryContact.phone', 'primaryContact.role',
  'financials.pledgedAmount', 'financials.amountReceived', 'financials.agreementDate',
  'website', 'logoUrl', 'agreementContractUrl', 'interactionHistory', 'createdAt', 'updatedAt',
  'isRelatedParty', 'isFounderCommercialEntity', 'relatedParty.channel', 'relatedParty.agreementRef',
  'financials.currency', 'disclosureRecorded', 'benchmarkingRecorded',
];

function line(values: string[]) {
  return values.map((v) => `"${v}"`).join(',');
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockAudit.mockResolvedValue(undefined);
  mockBatchCommit.mockResolvedValue(undefined);
  currentDb = mockDbFor();
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('partners export streaming fallback (v2)', () => {
  it('emits byte-exact CSV for a small fixture', async () => {
    mockGet.mockResolvedValue({
      docs: [
        doc('p1', {
          organizationName: 'Acme',
          status: 'active',
          relationshipType: 'sponsor',
          sponsorshipTier: 'Gold',
          primaryContact: { name: 'Ann', email: 'ann@x.com', phone: '123', role: 'CEO' },
          financials: { pledgedAmount: 1000, amountReceived: 500, agreementDate: '2026-01-01', currency: 'USD' },
          website: 'https://acme.test',
          interactionHistory: [
            { timestamp: ts('2026-02-03T04:05:06.000Z'), author: 'Bob', note: 'Hello "world"\nnewline' },
          ],
          createdAt: ts('2026-01-02T03:04:05.000Z'),
          updatedAt: ts('2026-01-03T03:04:05.000Z'),
          isRelatedParty: true,
          isFounderCommercialEntity: false,
          relatedParty: { channel: 'direct', agreementRef: 'REF1', disclosureRecorded: true, benchmarkingRecorded: false },
        }),
        doc('p2', { organizationName: 'Beta' }),
        doc('p3', {
          organizationName: 'Gamma',
          interactionHistory: 'plain note',
        }),
      ],
    });

    const res = await GET(exportRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toContain('partners.csv');
    const body = await res.text();
    const expected = [
      HEADERS.join(','),
      line([
        'Acme', 'active', 'sponsor', 'Gold', 'Ann', 'ann@x.com', '123', 'CEO',
        '1000', '500', '2026-01-01', 'https://acme.test', '', '',
        '2026-02-03T04:05:06.000Z Bob: Hello \\\\"world\\\\" newline',
        '2026-01-02T03:04:05.000Z', '2026-01-03T03:04:05.000Z',
        'true', 'false', 'direct', 'REF1', 'USD', 'true', 'false',
      ]),
      line([
        'Beta', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
        'false', 'false', '', '', 'PKR', 'false', 'false',
      ]),
      line([
        'Gamma', '', '', '', '', '', '', '', '', '', '', '', '', '', 'plain note', '', '',
        'false', 'false', '', '', 'PKR', 'false', 'false',
      ]),
    ].join('\n');
    expect(body).toBe(expected);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][2].payload.rowCount).toBe(3);
  });

  it('streams 600 docs off a single contract-shape .get() with the exact audit count', async () => {
    const docs = Array.from({ length: 600 }, (_, i) =>
      doc(`p${i}`, { organizationName: `Org ${i}` }),
    );
    mockGet.mockResolvedValue({ docs });

    const res = await GET(exportRequest());
    expect(res.status).toBe(200);
    // The body is a stream, not a prebuilt string: a reader exists.
    expect(typeof (res.body as any)?.getReader).toBe('function');
    const body = await res.text();
    const lines = body.split('\n');
    expect(lines).toHaveLength(601);
    expect(lines[0]).toBe(HEADERS.join(','));
    expect(lines[600]).toContain('Org 599');
    // Exactly one fallback read: no counting pass, no paging passes.
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][2].payload.rowCount).toBe(600);
    expect(mockBatchCommit).toHaveBeenCalledTimes(1);
  });
});
