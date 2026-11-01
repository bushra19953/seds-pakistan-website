/**
 * @jest-environment node
 *
 * Heap-guard tests for src/app/api/admin/partners/export/route.ts
 * (fix/heap-root-hunt): the Firestore fallback read the whole
 * sponsors_partners collection into one snapshot and built the full CSV
 * string in memory. It now pages (500 docs per read, document-id order)
 * and streams lines out. The seam path is forced off here so the tests
 * drive the fallback. Test 1 pins the CSV bytes for a small fixture
 * (field order, escaping, defaults); test 2 proves paging across 600
 * docs (two passes: audit count, then stream) and the audit row count.
 */
import { NextRequest } from 'next/server';

const mockAudit = jest.fn();
const mockBatchCommit = jest.fn();
let getPageSizes: number[] = [];
let limitArgs: number[] = [];

function doc(id: string, data: any) {
  return { id, data: () => data };
}

function ts(iso: string) {
  return { toDate: () => new Date(iso) };
}

function sponsorsQuery(all: any[]) {
  let cursor: string | null = null;
  let limited = false;
  const chain: any = {
    orderBy: () => chain,
    limit: (n: number) => {
      limited = true;
      limitArgs.push(n);
      return chain;
    },
    startAfter: (snap: any) => {
      cursor = snap.id;
      return chain;
    },
    get: async () => {
      const start = cursor === null ? 0 : all.findIndex((d) => d.id === cursor) + 1;
      // Faithful Firestore shape: no limit() means one unbounded read of
      // everything past the cursor (the old code's path); limit(500)
      // means one bounded page (the new code's path).
      const page = limited ? all.slice(start, start + 500) : all.slice(start);
      getPageSizes.push(page.length);
      return { docs: page, size: page.length };
    },
  };
  return chain;
}

function mockDbFor(all: any[]) {
  return {
    collection: () => sponsorsQuery(all),
    batch: () => ({ commit: mockBatchCommit }),
  };
}

let currentDb: any = null;

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
jest.mock('@/lib/server/firebase-admin', () => ({
  admin: { firestore: { FieldPath: { documentId: () => '__name__' } } },
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
  getPageSizes = [];
  limitArgs = [];
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockAudit.mockResolvedValue(undefined);
  mockBatchCommit.mockResolvedValue(undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('partners export streaming fallback', () => {
  it('emits byte-exact CSV for a small fixture', async () => {
    const docs = [
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
    ];
    currentDb = mockDbFor(docs);

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
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][2].payload.rowCount).toBe(3);
  });

  it('pages 600 docs in two passes and audits the exact count', async () => {
    const docs = Array.from({ length: 600 }, (_, i) =>
      doc(`p${i}`, { organizationName: `Org ${i}` }),
    );
    currentDb = mockDbFor(docs);

    const res = await GET(exportRequest());
    expect(res.status).toBe(200);
    const body = await res.text();
    const lines = body.split('\n');
    expect(lines).toHaveLength(601);
    expect(lines[0]).toBe(HEADERS.join(','));
    expect(lines[600]).toContain('Org 599');
    // Two passes (audit count, then stream), 500 + 100 per pass.
    expect(getPageSizes).toEqual([500, 100, 500, 100]);
    expect(limitArgs).toEqual([500, 500]);
    expect(mockAudit.mock.calls[0][2].payload.rowCount).toBe(600);
    expect(mockBatchCommit).toHaveBeenCalledTimes(1);
  });
});
