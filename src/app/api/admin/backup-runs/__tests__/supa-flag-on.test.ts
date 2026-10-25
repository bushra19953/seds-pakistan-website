/**
 * @jest-environment node
 *
 * Flag-ON behaviour for GET /api/admin/backup-runs (Supabase migration,
 * cluster S group G4): the list read runs through the shared handle over
 * the adapter (FakeSupa underneath). Pins:
 *  - orderBy('startedAt','desc').limit(20) works over the handle with
 *    ISO-string timestamps (the adapter-written shape);
 *  - a dumped-shape timestamp serializes in the JSON response EXACTLY
 *    as the Firestore path serializes an Admin Timestamp of the same
 *    instant (both are {_seconds,_nanoseconds} own-property shapes) —
 *    no response drift under the flag.
 * Zero live reads; no real auth (auth + permission mocked at the seam).
 */
import { NextRequest } from 'next/server';
import { Timestamp } from 'firebase-admin/firestore';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupaAdapter } from '@/lib/supa';
import { FakeSupa, landingRow, dumpedTimestamp } from '@/lib/supa/__tests__/fake-supa';
import { createSupaDbHandle } from '@/lib/server/supa-db-handle';

const mockState = { handle: null as unknown };

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
    user: { uid: 'u-admin', role: 'founder' },
  })),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async () => true),
}));

import { GET } from '../route';

function setup(fake: FakeSupa) {
  mockState.handle = createSupaDbHandle(
    createSupaAdapter(fake as unknown as SupabaseClient),
  );
}

describe('backup-runs flag ON (Supabase handle)', () => {
  it('lists runs newest-first over the handle', async () => {
    const fake = new FakeSupa().seed('fs_backup_runs', [
      landingRow('run-old', {
        status: 'success',
        startedAt: '2026-10-20T03:00:00.000Z',
        totals: { documents: 100 },
      }),
      landingRow('run-new', {
        status: 'partial',
        startedAt: '2026-10-24T03:00:00.000Z',
        totals: { documents: 250 },
      }),
    ]);
    setup(fake);

    const res = await GET(new NextRequest('http://localhost/api/admin/backup-runs'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runs.map((r: { runId: string }) => r.runId)).toEqual([
      'run-new',
      'run-old',
    ]);
    expect(body.runs[0].status).toBe('partial');
    expect(body.runs[0].startedAt).toBe('2026-10-24T03:00:00.000Z');
  });

  it('dumped-shape startedAt serializes exactly like an Admin Timestamp', async () => {
    const millis = 1760000000123;
    const fake = new FakeSupa().seed('fs_backup_runs', [
      landingRow('run-1', {
        status: 'success',
        startedAt: dumpedTimestamp(new Date(millis).toISOString()),
      }),
    ]);
    setup(fake);

    const res = await GET(new NextRequest('http://localhost/api/admin/backup-runs'));
    const body = await res.json();
    const firestoreShape = JSON.parse(
      JSON.stringify({ startedAt: Timestamp.fromMillis(millis) }),
    ).startedAt;
    expect(body.runs[0].startedAt).toEqual(firestoreShape);
    expect(body.runs[0].startedAt).toEqual({
      _seconds: 1760000000,
      _nanoseconds: 123000000,
    });
  });
});
