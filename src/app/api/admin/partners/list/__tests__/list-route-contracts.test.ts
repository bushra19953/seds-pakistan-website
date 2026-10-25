/**
 * @jest-environment node
 *
 * Cluster F contracts for GET /api/admin/partners/list:
 *  - 401 unauthenticated, 403 without canManageSponsorsPartners (both
 *    before the flag response, so the route leaks nothing).
 *  - Flag OFF => 503 (the route is NOT a new Firestore list API; the
 *    client falls back to Firestore).
 *  - Flag ON => whole collection served from the adapter; status
 *    filter and limit+cursor pagination served too.
 *  - Adapter error => 503 (client fallback signal), never a 500 leak.
 * Zero live reads; auth/permissions mocked, adapter faked.
 */
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupaAdapter } from '@/lib/supa';
import { FakeSupa, landingRow } from '@/lib/supa/__tests__/fake-supa';

const state = {
  authenticated: true,
  permitted: true,
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() => null),
  getAuth: jest.fn(() => null),
  getApp: jest.fn(() => null),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () =>
    state.authenticated
      ? { authenticated: true, user: { userId: 'u-admin', role: 'founder' } }
      : { authenticated: false, error: 'Unauthorized' },
  ),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => state.permitted),
}));

import { GET } from '../route';
import {
  __setCrmSupaEnabledForTests,
  __setCrmSupaPortForTests,
  type CrmSupaPort,
} from '@/lib/server/crm-supa';

const TABLE = 'fs_sponsors_partners';

function seedFake(): FakeSupa {
  return new FakeSupa().seed(TABLE, [
    landingRow('p1', {
      organizationName: 'One',
      status: 'Active',
      updatedAt: '2026-03-01T00:00:00.000Z',
    }),
    landingRow('p2', {
      organizationName: 'Two',
      status: 'Past',
      updatedAt: '2026-02-01T00:00:00.000Z',
    }),
    landingRow('p3', {
      organizationName: 'Three',
      status: 'Active',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
  ]);
}

function req(qs = ''): NextRequest {
  return new NextRequest(`http://localhost/api/admin/partners/list${qs}`);
}

beforeEach(() => {
  state.authenticated = true;
  state.permitted = true;
  __setCrmSupaEnabledForTests(undefined);
  __setCrmSupaPortForTests(undefined);
});

afterEach(() => {
  __setCrmSupaEnabledForTests(undefined);
  __setCrmSupaPortForTests(undefined);
});

it('401 when unauthenticated', async () => {
  state.authenticated = false;
  const res = await GET(req());
  expect(res.status).toBe(401);
});

it('403 without the CRM permission', async () => {
  state.permitted = false;
  const res = await GET(req());
  expect(res.status).toBe(403);
});

it('503 when the crm surface is OFF (no Firestore list fallback in-route)', async () => {
  __setCrmSupaEnabledForTests(false);
  const res = await GET(req());
  expect(res.status).toBe(503);
});

it('ON: whole collection served, updatedAt desc', async () => {
  const fake = seedFake();
  __setCrmSupaEnabledForTests(true);
  __setCrmSupaPortForTests(
    createSupaAdapter(fake as unknown as SupabaseClient) as unknown as CrmSupaPort,
  );
  const res = await GET(req());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.partners.map((p: { id: string }) => p.id)).toEqual(['p1', 'p2', 'p3']);
  expect(body.nextCursor).toBeNull();
});

it('ON: status filter + pagination via cursor', async () => {
  const fake = seedFake();
  __setCrmSupaEnabledForTests(true);
  __setCrmSupaPortForTests(
    createSupaAdapter(fake as unknown as SupabaseClient) as unknown as CrmSupaPort,
  );
  const page1 = await (await GET(req('?status=Active&limit=1'))).json();
  expect(page1.partners.map((p: { id: string }) => p.id)).toEqual(['p1']);
  expect(typeof page1.nextCursor).toBe('string');
  const page2 = await (
    await GET(req(`?status=Active&limit=1&cursor=${encodeURIComponent(page1.nextCursor)}`))
  ).json();
  expect(page2.partners.map((p: { id: string }) => p.id)).toEqual(['p3']);
});

it('ON but adapter erroring: 503 fallback signal', async () => {
  __setCrmSupaEnabledForTests(true);
  __setCrmSupaPortForTests({
    listDocs: (async () => {
      throw new Error('down');
    }) as never,
    getDoc: (async () => null) as never,
    setDoc: (async () => {}) as never,
    updateDoc: (async () => {}) as never,
    deleteDoc: (async () => {}) as never,
  });
  const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const res = await GET(req());
    expect(res.status).toBe(503);
  } finally {
    errSpy.mockRestore();
  }
});
