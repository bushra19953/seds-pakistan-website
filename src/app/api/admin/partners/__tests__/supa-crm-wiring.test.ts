/**
 * @jest-environment node
 *
 * Cluster F wiring contracts for POST/PATCH/DELETE /api/admin/partners
 * with the 'crm' surface ON:
 *  - POST create mirrors into fs_sponsors_partners after the Firestore
 *    add (Firestore stays primary; the response is unchanged).
 *  - PATCH reads the existing record FROM THE SEAM (the Firestore doc
 *    deliberately disagrees / is absent) and mirrors the update.
 *  - DELETE mirrors the delete after the Firestore delete.
 * OFF parity for this route is pinned by the pre-existing suite
 * (route.test.ts), which runs with the flag unset.
 * Zero live reads; gate + audit mocked as in route.test.ts.
 */
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupaAdapter } from '@/lib/supa';
import { FakeSupa, landingRow } from '@/lib/supa/__tests__/fake-supa';

jest.mock('@/lib/server/consent-gate', () => ({
  assertConsentFor: jest.fn().mockResolvedValue({ mode: 'record', outcome: 'recorded' }),
  consentGateHttpError: () => ({ status: 500, body: { error: 'gate' } }),
}));

jest.mock('@/lib/server/governance-audit', () => ({
  writeGovernanceAuditOrThrow: jest.fn().mockResolvedValue('audit-1'),
  GovernanceAuditError: class GovernanceAuditError extends Error {},
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => ({
    authenticated: true,
    user: { userId: 'admin-1', role: 'executive_director' },
  })),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(true),
  hasServerPermissionForUser: jest.fn().mockResolvedValue(true),
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
}));

import { POST, PATCH, DELETE } from '@/app/api/admin/partners/route';
import {
  __setCrmSupaEnabledForTests,
  __setCrmSupaPortForTests,
  type CrmSupaPort,
} from '@/lib/server/crm-supa';

const TABLE = 'fs_sponsors_partners';

/** Firestore db whose sponsors_partners docs are ABSENT (so any
 * existing-record read the route performs must come from the seam). */
function makeDb() {
  const state = { added: [] as Array<Record<string, unknown>>, updates: [] as Array<Record<string, unknown>>, deletes: 0 };
  const db = {
    __state: state,
    collection: () => ({
      add: async (data: Record<string, unknown>) => {
        state.added.push(data);
        return { id: 'partner-new' };
      },
      doc: (id: string) => ({
        get: async () => ({ exists: false, id, data: () => undefined }),
        update: async (data: Record<string, unknown>) => {
          state.updates.push(data);
        },
        delete: async () => {
          state.deletes += 1;
        },
      }),
    }),
  };
  return db;
}

function req(method: string, body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/admin/partners', {
    method,
    body: JSON.stringify(body),
  });
}

let fake: FakeSupa;

beforeEach(() => {
  fake = new FakeSupa().seed(TABLE, [
    landingRow('p-seam', {
      organizationName: 'Seam Co',
      status: 'Prospect',
      updatedAt: '2026-03-01T00:00:00.000Z',
    }),
  ]);
  __setCrmSupaEnabledForTests(true);
  __setCrmSupaPortForTests(
    createSupaAdapter(fake as unknown as SupabaseClient) as unknown as CrmSupaPort,
  );
  mockDbHolder.db = makeDb();
});

afterEach(() => {
  __setCrmSupaEnabledForTests(undefined);
  __setCrmSupaPortForTests(undefined);
});

it('POST: Firestore add stays primary; mirror create lands in fs_sponsors_partners', async () => {
  const res = await POST(req('POST', { organizationName: 'Mirror Co', status: 'Prospect' }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, id: 'partner-new' });
  const row = fake.rows(TABLE).find((r) => r.id === 'partner-new');
  expect(row?.data.organizationName).toBe('Mirror Co');
  expect(typeof row?.data.createdAt).toBe('undefined'); // create payload carries no client timestamps
});

it('PATCH: existing record read from the seam (Firestore says missing), update mirrored', async () => {
  const res = await PATCH(req('PATCH', { id: 'p-seam', status: 'Active' }));
  expect(res.status).toBe(200);
  const db = mockDbHolder.db as ReturnType<typeof makeDb>;
  expect(db.__state.updates).toHaveLength(1);
  const row = fake.rows(TABLE).find((r) => r.id === 'p-seam');
  expect(row?.data.status).toBe('Active');
  expect(row?.data.organizationName).toBe('Seam Co');
});

it('DELETE: seam existence read satisfies the route; delete mirrored', async () => {
  const res = await DELETE(req('DELETE', { id: 'p-seam' }));
  expect(res.status).toBe(200);
  const db = mockDbHolder.db as ReturnType<typeof makeDb>;
  expect(db.__state.deletes).toBe(1);
  expect(fake.rows(TABLE).find((r) => r.id === 'p-seam')).toBeUndefined();
});
