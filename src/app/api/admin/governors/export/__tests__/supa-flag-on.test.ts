/**
 * @jest-environment node
 *
 * Flag-ON wiring for GET /api/admin/governors/export (Supabase
 * migration, cluster S group G4): the route overrides the db it hands
 * to the shared register + audit libraries with the backup-exports
 * seam db (the handle). The db inside authenticateGovernorRequest
 * self-acquires and stays Firestore (C-G4-3: shared libraries are
 * never edited) — this test pins the override by identity: both
 * libraries must receive the HANDLE, not the auth context's db.
 * Zero live reads; auth/register/audit mocked at their boundaries.
 */
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupaAdapter } from '@/lib/supa';
import { FakeSupa } from '@/lib/supa/__tests__/fake-supa';
import { createSupaDbHandle } from '@/lib/server/supa-db-handle';

const mockState = { handle: null as unknown };
const AUTH_CTX_DB = { __authCtxFirestore: true };
const mockRegisterDb: unknown[] = [];
const mockAuditDb: unknown[] = [];

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

jest.mock('@/lib/server/governors/http', () => ({
  authenticateGovernorRequest: jest.fn(async () => ({
    ctx: {
      db: AUTH_CTX_DB,
      actor: { uid: 'founder-uid', role: 'founder' },
    },
  })),
  governorErrorResponse: jest.fn(
    () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }),
  ),
}));

jest.mock('@/lib/server/governors/access', () => ({
  canEditRegister: jest.fn(() => true),
}));

jest.mock('@/lib/server/governors/register', () => ({
  getRegister: jest.fn(async (db: unknown) => {
    mockRegisterDb.push(db);
    return {
      seats: [
        {
          seatKey: 'president',
          category: 'executive',
          effectiveStatus: 'seated',
          holderName: 'Test Holder',
          holderEmail: 'holder@example.test',
          termStart: '2026-01-01T00:00:00.000Z',
          termEnd: null,
          holderRoleKey: 'founder',
          lastHolderName: null,
          version: 1,
        },
      ],
      summary: { seatedCount: 1, quorum: 'met' },
    };
  }),
}));

jest.mock('@/lib/server/governance-audit', () => ({
  writeGovernanceAuditOrThrow: jest.fn(async (db: unknown) => {
    mockAuditDb.push(db);
  }),
}));

import { GET } from '../route';

beforeEach(() => {
  mockRegisterDb.length = 0;
  mockAuditDb.length = 0;
});

describe('governors export flag ON (Supabase handle)', () => {
  it('hands the handle (not the auth ctx db) to the register and the audit writer', async () => {
    const handle = createSupaDbHandle(
      createSupaAdapter(new FakeSupa() as unknown as SupabaseClient),
    );
    mockState.handle = handle;

    const res = await GET(
      new NextRequest('http://localhost/api/admin/governors/export?format=csv'),
    );
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).toContain('seatKey,category,status');
    expect(csv).toContain('president');
    expect(csv).toContain('Test Holder');
    expect(csv).toContain('2026-01-01T00:00:00.000Z');

    expect(mockRegisterDb).toEqual([handle]);
    expect(mockAuditDb).toEqual([handle]);
    expect(mockRegisterDb[0]).not.toBe(AUTH_CTX_DB);
  });
});
