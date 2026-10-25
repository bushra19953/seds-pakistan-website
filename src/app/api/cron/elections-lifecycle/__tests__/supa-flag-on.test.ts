/**
 * @jest-environment node
 *
 * Flag-ON behaviour for GET /api/cron/elections-lifecycle (Supabase
 * migration, cluster cron G2): the route hands the shared handle to
 * the REAL runElectionLifecycleSweeps (FakeSupa underneath). Pins:
 *  - an election whose timetable (dumped-shape timestamps, the
 *    kit-landed form) says nominations should be open transitions
 *    timetable_published -> nominations_open via a handle update;
 *  - the election.lifecycle_sweep audit row lands in fs_audit_logs
 *    (written with the real firebase-admin serverTimestamp sentinel,
 *    resolved by the handle at write time);
 *  - an election still before its window is untouched;
 *  - NO ELECTIONS_ENABLED check exists on this path (the migrated
 *    sweep gains none — PLAN_G2 section 1.4).
 * Caveat recorded in BUILDOUT_G2: election-ports' toMillis has no
 * string branch, so timetable values stored as ISO strings (written
 * through adapter-backed election surfaces) read as 0 — that fix
 * belongs to the elections cluster's module, not this seam.
 * Zero live reads; dummy fixture secret.
 */
import { NextRequest } from 'next/server';
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
      surface === 'cron-g2' ? mockState.handle : null,
  };
});

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => ({ authenticated: false })),
}));

// election-audit writes with the real firebase-admin namespace
// sentinel (admin.firestore.FieldValue.serverTimestamp()): expose the
// real namespace so the handle resolves a genuine sentinel.
jest.mock('firebase-admin', () => {
  const actual = jest.requireActual('firebase-admin');
  return {
    ...actual,
    ensureAdminInitialized: jest.fn(() => true),
    getDb: jest.fn(() => null),
    getAuth: jest.fn(() => null),
    getApp: jest.fn(() => null),
  };
});

import { GET } from '../route';

const SECRET = 'g2-test-secret';
const DAY = 24 * 3600 * 1000;

function timetable(nominationOpenMs: number, now: number) {
  const at = (ms: number) => dumpedTimestamp(new Date(ms).toISOString());
  return {
    electionDay: at(now + 30 * DAY),
    timetablePublishedAt: at(now - 10 * DAY),
    timetableLateReason: null,
    nominationOpenAt: at(nominationOpenMs),
    nominationCloseAt: at(now + 5 * DAY),
    vettingDeadlineAt: at(now + 8 * DAY),
    candidateListDate: at(now + 10 * DAY),
    candidateListPublishedAt: null,
    pollOpenAt: at(now + 15 * DAY),
    pollCloseAt: at(now + 16 * DAY),
    challengeWindowClosesAt: null,
    certificateDeadlineAt: null,
  };
}

beforeAll(() => {
  process.env.CRON_SECRET = SECRET;
});
afterAll(() => {
  delete process.env.CRON_SECRET;
});

describe('elections-lifecycle flag ON (Supabase handle)', () => {
  it('opens nominations for the due election and audits the transition; the not-due election is untouched', async () => {
    const now = Date.now();
    const fake = new FakeSupa()
      .seed('fs_elections', [
        landingRow('e-due', {
          status: 'timetable_published',
          title: 'AGM 2026',
          timetable: timetable(now - 1 * DAY, now),
        }),
        landingRow('e-early', {
          status: 'timetable_published',
          title: 'Special Election',
          timetable: timetable(now + 2 * DAY, now),
        }),
      ])
      .seed('fs_audit_logs', []);
    mockState.handle = createSupaDbHandle(
      createSupaAdapter(fake as unknown as SupabaseClient),
    );

    const res = await GET(
      new NextRequest('http://localhost/api/cron/elections-lifecycle', {
        headers: { Authorization: `Bearer ${SECRET}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.transitioned).toEqual([
      { electionId: 'e-due', to: 'nominations_open' },
    ]);

    const elections = new Map(
      fake.rows('fs_elections').map((r) => [r.id, r.data]),
    );
    expect(elections.get('e-due')!.status).toBe('nominations_open');
    expect(typeof elections.get('e-due')!.updatedAt).toBe('string');
    expect(elections.get('e-early')!.status).toBe('timetable_published');

    const audit = fake.rows('fs_audit_logs');
    expect(audit).toHaveLength(1);
    expect(audit[0].data.action).toBe('election.lifecycle_sweep');
    expect(audit[0].data.targetUidOrResource).toBe('election:e-due');
    expect(audit[0].data.payload).toMatchObject({
      from: 'timetable_published',
      to: 'nominations_open',
    });
    expect(typeof audit[0].data.timestamp).toBe('string');
  });
});
