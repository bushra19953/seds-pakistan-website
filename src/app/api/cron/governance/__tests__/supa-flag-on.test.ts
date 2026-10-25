/**
 * @jest-environment node
 *
 * Flag-ON behaviour for GET /api/cron/governance?dryRun=1 (Supabase
 * migration, cluster cron G2): the route hands the shared handle to
 * the REAL runGovernanceCron dispatcher (FakeSupa underneath). The
 * dry-run contract is the pinned behaviour under test: the route
 * reports posture and writes NOTHING — every FakeSupa table stays
 * exactly as seeded (empty), and the response is the dispatcher's
 * summary passed through. Self-acquiring settings reads inside the
 * action modules resolve against the mocked Firestore facade, which
 * answers "missing" for everything (the pre-migration default posture:
 * lifecycleEnforce off).
 * Zero live reads; dummy fixture secret.
 */
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupaAdapter } from '@/lib/supa';
import { FakeSupa } from '@/lib/supa/__tests__/fake-supa';
import { createSupaDbHandle } from '@/lib/server/supa-db-handle';

const mockState = { handle: null as unknown };

// Benign Firestore facade for self-acquiring readers: every doc is
// missing, every query is empty, every write is a no-op sink (dry-run
// must not reach writes at all; the sink only keeps stray reads from
// crashing the posture pass).
function emptyFirestore() {
  const query: Record<string, unknown> = {};
  const self = () => query as never;
  Object.assign(query, {
    where: self,
    orderBy: self,
    limit: self,
    startAfter: self,
    get: async () => ({ docs: [], empty: true, size: 0 }),
    count: () => ({ get: async () => ({ data: () => ({ count: 0 }) }) }),
    doc: (id?: string) => ({
      id: id ?? 'auto',
      get: async () => ({ exists: false, id, data: () => undefined }),
      set: async () => {},
      update: async () => {},
      delete: async () => {},
      collection: () => query,
    }),
    add: async () => ({ id: 'auto' }),
  });
  return { collection: () => query };
}

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() => emptyFirestore()),
  getAuth: jest.fn(() => null),
  getApp: jest.fn(() => null),
}));

jest.mock('@/lib/server/supa-db-handle', () => {
  const actual = jest.requireActual('@/lib/server/supa-db-handle');
  return {
    ...actual,
    supaDbHandleFor: (surface: string) =>
      surface === 'cron-g2' ? mockState.handle : null,
  };
});

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => ({ authenticated: false })),
}));

import { GET } from '../route';

const SECRET = 'g2-test-secret';

beforeAll(() => {
  process.env.CRON_SECRET = SECRET;
});
afterAll(() => {
  delete process.env.CRON_SECRET;
});

describe('governance flag ON (Supabase handle)', () => {
  it('dryRun=1 reports posture and writes nothing to the mirror', async () => {
    const fake = new FakeSupa();
    mockState.handle = createSupaDbHandle(
      createSupaAdapter(fake as unknown as SupabaseClient),
    );

    const res = await GET(
      new NextRequest('http://localhost/api/cron/governance?dryRun=1', {
        headers: { Authorization: `Bearer ${SECRET}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.dryRun).toBe(true);

    // Zero writes anywhere in the mirror: no table gained a row.
    for (const table of [
      'fs_consent_requests',
      'fs_audit_logs',
      'fs_governance_records',
      'fs_probation_restores',
      'fs_users',
      'fs_roles',
    ]) {
      expect(fake.rows(table)).toHaveLength(0);
    }
  });
});
