/**
 * @jest-environment node
 *
 * Read-bleed train 2, CRM item 3: GET /api/admin/partners/export must
 * read partners through the CRM seam FIRST (supaListAllPartners — the
 * helper the CRM pages' list route serves). When the seam serves, the
 * G4 db's sponsors_partners collection is NEVER read (zero Firestore
 * reads on that path) and the CSV is identical to the Firestore-path
 * output, including .toDate-rendered timestamp cells (seam ISO
 * strings are rehydrated exactly like handle-served rows). When the
 * seam returns null, the previous G4 path runs unchanged. The
 * permission gate and audit-before-serve write stay on the G4 db.
 * Zero live reads; every dependency mocked at the seam.
 */
import { NextRequest } from 'next/server';

const mockSeam = { rows: null as Array<Record<string, unknown>> | null };
const mockCollectionGet = jest.fn(async () => ({
  docs: [
    {
      data: () => ({
        organizationName: 'Fs Org',
        status: 'lead',
        createdAt: { toDate: () => new Date('2026-01-01T00:00:00.000Z') },
        updatedAt: { toDate: () => new Date('2026-01-02T00:00:00.000Z') },
      }),
    },
  ],
}));
const mockCollection = jest.fn((_name: string) => ({ get: mockCollectionGet }));
const mockBatchCommit = jest.fn(async () => undefined);
const mockDb = {
  collection: mockCollection,
  batch: jest.fn(() => ({ commit: mockBatchCommit })),
};
const mockAudit = { calls: [] as Array<Record<string, unknown>> };

jest.mock('@/lib/server/backup-exports/g4-data', () => {
  const actual = jest.requireActual('@/lib/server/backup-exports/g4-data');
  return {
    ...actual,
    getG4Db: () => mockDb,
    getG4Handle: () => null,
  };
});

jest.mock('@/lib/server/crm-supa', () => ({
  supaListAllPartners: jest.fn(async () => mockSeam.rows),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => ({
    authenticated: true,
    user: { userId: 'u-admin', role: 'founder' },
  })),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => true),
}));

jest.mock('@/lib/server/finance-audit', () => ({
  writeFinanceAudit: jest.fn(async (_db: unknown, _batch: unknown, entry: Record<string, unknown>) => {
    mockAudit.calls.push(entry);
  }),
}));

import { GET } from '../route';

beforeEach(() => {
  mockSeam.rows = null;
  mockAudit.calls = [];
  jest.clearAllMocks();
  // clearAllMocks wipes implementations set in factories; restore them.
  mockCollectionGet.mockImplementation(async () => ({
    docs: [
      {
        data: () => ({
          organizationName: 'Fs Org',
          status: 'lead',
          createdAt: { toDate: () => new Date('2026-01-01T00:00:00.000Z') },
          updatedAt: { toDate: () => new Date('2026-01-02T00:00:00.000Z') },
        }),
      },
    ],
  }));
});

describe('partners export — CRM seam first', () => {
  it('seam serves: collection .get() never runs, CSV renders ISO timestamp cells, audit rowCount matches', async () => {
    mockSeam.rows = [
      {
        id: 'p1',
        organizationName: 'Seam Org',
        status: 'active',
        relationshipType: 'sponsor',
        primaryContact: { name: 'Pat', email: 'pat@seam.example' },
        financials: { pledgedAmount: 100, amountReceived: 50, currency: 'PKR' },
        interactionHistory: [
          { timestamp: '2026-02-01T09:15:00.000Z', author: 'Admin', note: 'Kickoff' },
        ],
        createdAt: '2026-01-15T10:00:00.000Z',
        updatedAt: '2026-03-20T12:30:00.000Z',
      },
    ];
    const res = await GET(new NextRequest('http://localhost/api/admin/partners/export'));
    expect(res.status).toBe(200);
    expect(mockCollection).not.toHaveBeenCalled();
    const csv = await res.text();
    const lines = csv.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"Seam Org"');
    // ISO seam timestamps rehydrated -> rendered, not blanked.
    expect(lines[1]).toContain('"2026-01-15T10:00:00.000Z"');
    expect(lines[1]).toContain('"2026-03-20T12:30:00.000Z"');
    expect(lines[1]).toContain('2026-02-01T09:15:00.000Z Admin: Kickoff');
    // Audit-before-serve still ran on the G4 db with the seam row count.
    expect(mockAudit.calls).toHaveLength(1);
    expect(mockAudit.calls[0].payload).toEqual({ rowCount: 1 });
    expect(mockBatchCommit).toHaveBeenCalledTimes(1);
  });

  it('seam unavailable (null): previous G4/Firestore path runs byte-identically', async () => {
    mockSeam.rows = null;
    const res = await GET(new NextRequest('http://localhost/api/admin/partners/export'));
    expect(res.status).toBe(200);
    expect(mockCollection).toHaveBeenCalledWith('sponsors_partners');
    expect(mockCollectionGet).toHaveBeenCalledTimes(1);
    const csv = await res.text();
    const lines = csv.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"Fs Org"');
    expect(lines[1]).toContain('"2026-01-01T00:00:00.000Z"');
    expect(mockAudit.calls[0].payload).toEqual({ rowCount: 1 });
  });
});
