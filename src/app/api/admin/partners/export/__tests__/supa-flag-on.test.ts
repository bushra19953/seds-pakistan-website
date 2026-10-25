/**
 * @jest-environment node
 *
 * Flag-ON behaviour for GET /api/admin/partners/export (Supabase
 * migration, cluster S group G4). The CSV-equivalence test for the
 * .toDate-cell drift (PLAN_G4 section 3): seeded Firestore-shaped data
 * whose timestamps sit in the ADAPTER's shapes (dumped
 * {_seconds,_nanoseconds} + adapter-written ISO strings) must render
 * the identical CSV cells the Firestore path renders for Admin
 * Timestamps of the same instants — including interactionHistory
 * timestamps, which blank silently without the seam rehydration.
 * Also pins: the permission check receives the handle, and the
 * audit-before-serve batch (REAL writeFinanceAudit over a handle
 * batch) lands in fs_audit_logs BEFORE the response is produced.
 * Zero live reads; auth mocked at the seam.
 */
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupaAdapter } from '@/lib/supa';
import { FakeSupa, landingRow, dumpedTimestamp } from '@/lib/supa/__tests__/fake-supa';
import { createSupaDbHandle } from '@/lib/server/supa-db-handle';

const mockState = { handle: null as unknown };
const mockPermissionDb: unknown[] = [];

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

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => ({
    authenticated: true,
    user: { userId: 'u-admin', role: 'founder' },
  })),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async (db: unknown) => {
    mockPermissionDb.push(db);
    return true;
  }),
}));

import { GET } from '../route';

const CREATED_MS = Date.parse('2026-01-15T10:00:00.000Z');
const UPDATED_ISO = '2026-03-20T12:30:00.000Z';
const INTERACTION_ISO = '2026-02-01T09:15:00.000Z';

beforeEach(() => {
  mockPermissionDb.length = 0;
});

describe('partners export flag ON (Supabase handle)', () => {
  it('renders identical timestamp cells, audits before serving, permission check gets the handle', async () => {
    const fake = new FakeSupa()
      .seed('fs_sponsors_partners', [
        landingRow('p1', {
          organizationName: 'Acme Space',
          status: 'active',
          relationshipType: 'sponsor',
          sponsorshipTier: 'gold',
          primaryContact: {
            name: 'Pat',
            email: 'pat@acme.example',
            phone: '0300',
            role: 'CEO',
          },
          financials: {
            pledgedAmount: 5000,
            amountReceived: 2500,
            agreementDate: '2026-01-10',
            currency: 'PKR',
          },
          website: 'https://acme.example',
          interactionHistory: [
            { timestamp: INTERACTION_ISO, author: 'Admin', note: 'Kickoff call' },
          ],
          // Dumped shape (kit-landed) and ISO string (adapter-written):
          createdAt: dumpedTimestamp(new Date(CREATED_MS).toISOString()),
          updatedAt: UPDATED_ISO,
        }),
      ])
      .seed('fs_audit_logs', []);
    const handle = createSupaDbHandle(
      createSupaAdapter(fake as unknown as SupabaseClient),
    );
    mockState.handle = handle;

    const res = await GET(
      new NextRequest('http://localhost/api/admin/partners/export'),
    );
    expect(res.status).toBe(200);
    const csv = await res.text();
    const lines = csv.split('\n');
    expect(lines).toHaveLength(2);
    // createdAt (dumped) and updatedAt (ISO) cells both render ISO.
    expect(lines[1]).toContain('"2026-01-15T10:00:00.000Z"');
    expect(lines[1]).toContain(`"${UPDATED_ISO}"`);
    // Interaction timestamp renders (would be blank without rehydration).
    expect(lines[1]).toContain(`${INTERACTION_ISO} Admin: Kickoff call`);
    expect(lines[1]).toContain('"Acme Space"');

    // Permission gate ran against the handle.
    expect(mockPermissionDb).toEqual([handle]);

    // Audit-before-serve: the finance audit entry is in fs_audit_logs,
    // written through the handle batch with the serverTimestamp
    // sentinel resolved to a string at apply time.
    const audit = fake.rows('fs_audit_logs');
    expect(audit).toHaveLength(1);
    expect(audit[0].data.action).toBe('PARTNERS_EXPORTED');
    expect(audit[0].data.actorUid).toBe('u-admin');
    expect(audit[0].data.source).toBe('server-finance');
    expect(audit[0].data.payload).toEqual({ rowCount: 1 });
    expect(typeof audit[0].data.timestamp).toBe('string');
  });
});
