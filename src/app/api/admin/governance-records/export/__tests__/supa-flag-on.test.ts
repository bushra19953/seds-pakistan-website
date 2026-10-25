/**
 * @jest-environment node
 *
 * Flag-ON behaviour for GET /api/admin/governance-records/export
 * (Supabase migration, cluster S group G4): the permission gate, the
 * REAL registration-status read (settings/siteWide -> defaults when
 * absent), and the GOVERNANCE_COLLECTION full get all run through the
 * shared handle over the adapter (FakeSupa underneath); the CSV body
 * is the sorted record set. The audit write is asserted CALLED — its
 * module (src/lib/governance/audit) self-acquires its own db and stays
 * on Firestore under the flag (partial coverage, C-G4-3: the two audit
 * modules are never unified or forked by this group).
 * Zero live reads; the route-auth gate is mocked at the boundary.
 */
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupaAdapter } from '@/lib/supa';
import { FakeSupa, landingRow } from '@/lib/supa/__tests__/fake-supa';
import { createSupaDbHandle } from '@/lib/server/supa-db-handle';

const mockState = { handle: null as unknown };
const mockGateDb: unknown[] = [];
const mockAuditCalls: unknown[][] = [];

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() => null),
  getAuth: jest.fn(() => null),
  getApp: jest.fn(() => null),
}));

jest.mock('@/lib/server/supa-db-handle', () => {
  const actual = jest.requireActual('@/lib/server/supa-db-handle');
  return {
    ...actual,
    supaDbHandleFor: (surface: string) =>
      surface === 'backup-exports' ? mockState.handle : null,
  };
});

jest.mock('@/lib/governance/route-auth', () => ({
  dbUnavailable: jest.fn(
    () =>
      new Response(JSON.stringify({ error: 'db' }), { status: 503 }),
  ),
  requireGovernancePermission: jest.fn(
    async (_req: unknown, db: unknown) => {
      mockGateDb.push(db);
      return { ok: true, auth: { uid: 'u-admin' } };
    },
  ),
}));

jest.mock('@/lib/governance/audit', () => ({
  writeGovernanceAudit: jest.fn(async (...args: unknown[]) => {
    mockAuditCalls.push(args);
  }),
}));

import { GET } from '../route';

beforeEach(() => {
  mockGateDb.length = 0;
  mockAuditCalls.length = 0;
});

describe('governance-records export flag ON (Supabase handle)', () => {
  it('serves the sorted CSV from the handle; gate receives the handle; audit fires', async () => {
    const fake = new FakeSupa()
      .seed('fs_governance_records', [
        landingRow('rec-b', {
          recordId: 'SEDS-GOV-002',
          familyId: 'fam-1',
          series: 'bylaws',
          layer: 'national',
          title: 'Bylaws v2',
          version: '2.0',
          status: 'adopted',
          adoptionStatus: 'adopted',
          accessLevel: 'public',
          redactionStatus: 'none',
          recordDate: '2026-01-02',
          fileName: 'bylaws-v2.pdf',
          sha256: 'abc123',
          createdAt: '2026-01-02T00:00:00.000Z',
        }),
        landingRow('rec-a', {
          recordId: 'SEDS-GOV-001',
          familyId: 'fam-1',
          series: 'charter',
          layer: 'national',
          title: 'Charter',
          version: '1.0',
          status: 'adopted',
          adoptionStatus: 'adopted',
          accessLevel: 'public',
          redactionStatus: 'none',
          recordDate: '2025-12-01',
          fileName: 'charter.pdf',
          sha256: 'def456',
          createdAt: '2025-12-01T00:00:00.000Z',
        }),
      ])
      .seed('fs_settings', []);
    const handle = createSupaDbHandle(
      createSupaAdapter(fake as unknown as SupabaseClient),
    );
    mockState.handle = handle;

    const res = await GET(
      new NextRequest('http://localhost/api/admin/governance-records/export'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    const csv = await res.text();
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('recordId,familyId,series');
    // Sorted by recordId.
    expect(lines[1]).toContain('SEDS-GOV-001');
    expect(lines[2]).toContain('SEDS-GOV-002');
    expect(lines[1]).toContain('charter.pdf');
    expect(lines[1]).toContain('def456');

    expect(mockGateDb).toEqual([handle]);
    expect(mockAuditCalls).toHaveLength(1);
    expect(mockAuditCalls[0][0]).toBe('GOVERNANCE_RECORDS_EXPORTED');
    expect(mockAuditCalls[0][3]).toEqual({ count: 2 });
  });
});
