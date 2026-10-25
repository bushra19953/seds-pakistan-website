/**
 * @jest-environment node
 *
 * Flag-ON / flag-OFF proof for /api/cron/reconcile-roles (Supabase
 * migration, G1):
 *
 *  - Flag ON (SUPA_SURFACES=cron-g1, FakeSupa behind a mocked
 *    @supabase/supabase-js createClient, zero live reads): the route
 *    hands the adapter-backed handle to reconcileRoles (asserted in
 *    the mock) and the route's own report write lands in
 *    fs_reconciliation_reports through the handle. The Firestore
 *    sentinel db is never used for the write.
 *  - Flag OFF: the same request writes through the Firestore mock
 *    exactly as before the migration, and nothing lands in FakeSupa.
 */
import { NextRequest } from 'next/server';
import { FakeSupa } from '@/lib/supa/__tests__/fake-supa';

const mockFake = new FakeSupa();

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockFake),
}));

const state = {
  reconcileCalls: [] as Array<{ db: any; options: any }>,
  firestoreSets: [] as Array<{ collection: string; docId: string; data: any; options: any }>,
};

const mockFirestoreDb = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      set: async (data: any, options: any) => {
        state.firestoreSets.push({ collection: name, docId: id, data, options });
      },
    }),
  }),
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockFirestoreDb),
  ensureAdminInitialized: jest.fn(() => true),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => ({ authenticated: false })),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async () => false),
}));

jest.mock('@/lib/server/role-reconciliation', () => ({
  reconcileRoles: jest.fn(async (db: any, options: any) => {
    state.reconcileCalls.push({ db, options });
    return {
      generatedAt: '2026-10-25T03:00:00.000Z',
      mode: options.mode,
      entries: [],
      summary: {},
    };
  }),
}));

import { GET } from '../route';

const SECRET = 'test-cron-secret';
const ENV_KEYS = [
  'CRON_SECRET',
  'SUPA_SURFACES',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  process.env.SUPABASE_URL = 'https://fake.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-key';
  delete process.env.SUPA_SURFACES;
  state.reconcileCalls = [];
  state.firestoreSets = [];
  mockFake.seed('fs_reconciliation_reports', []);
});

function cronReq() {
  return new NextRequest('http://localhost/api/cron/reconcile-roles', {
    method: 'GET',
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

describe('GET /api/cron/reconcile-roles — supa seam', () => {
  it('flag ON: report write lands in fs_reconciliation_reports through the handle', async () => {
    process.env.SUPA_SURFACES = 'cron-g1';

    const res = await GET(cronReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.report.generatedAt).toBe('2026-10-25T03:00:00.000Z');

    // The delegated library received a handle, not the Firestore db.
    expect(state.reconcileCalls).toHaveLength(1);
    expect(state.reconcileCalls[0].db).not.toBe(mockFirestoreDb);
    expect(typeof state.reconcileCalls[0].db.collection).toBe('function');
    expect(state.reconcileCalls[0].options).toEqual({ mode: 'report' });

    // The report doc landed in the landing table, keyed by date, with
    // storedAt stored as an ISO string (the adapter's timestamp shape).
    const rows = mockFake.rows('fs_reconciliation_reports');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('2026-10-25');
    expect(rows[0].data.generatedAt).toBe('2026-10-25T03:00:00.000Z');
    expect(typeof rows[0].data.storedAt).toBe('string');
    expect(Number.isFinite(Date.parse(rows[0].data.storedAt as string))).toBe(true);

    // Firestore was not written.
    expect(state.firestoreSets).toHaveLength(0);
  });

  it('flag OFF: behaviour untouched — the write goes to Firestore, nothing lands in FakeSupa', async () => {
    delete process.env.SUPA_SURFACES;

    const res = await GET(cronReq());
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    // The delegated library received the real Firestore db by identity.
    expect(state.reconcileCalls).toHaveLength(1);
    expect(state.reconcileCalls[0].db).toBe(mockFirestoreDb);

    expect(state.firestoreSets).toHaveLength(1);
    expect(state.firestoreSets[0].collection).toBe('reconciliation_reports');
    expect(state.firestoreSets[0].docId).toBe('2026-10-25');
    expect(state.firestoreSets[0].options).toEqual({ merge: true });
    expect(state.firestoreSets[0].data.storedAt).toBeInstanceOf(Date);

    expect(mockFake.rows('fs_reconciliation_reports')).toHaveLength(0);
  });
});
