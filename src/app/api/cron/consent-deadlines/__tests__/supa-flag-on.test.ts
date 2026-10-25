/**
 * @jest-environment node
 *
 * Flag-ON behaviour for GET /api/cron/consent-deadlines (Supabase
 * migration, cluster cron G2): the route and the REAL consent service
 * run against the shared Firestore-shaped db handle over the adapter
 * (FakeSupa underneath); notificationService is mocked (it
 * self-acquires Firestore in production — documented partial
 * coverage). Pins the PLAN_G2 section-3 hotspot end to end:
 *  - a pending request whose decisionDeadlineAt is an ISO STRING
 *    (the adapter-written shape) past due is STAMPED deemed withheld
 *    by stampDeemedWithheld's transaction — before the migration fix
 *    it read as 'not_due' forever in the service and null in the
 *    route's toMillis, a silent failure of the Reserved Powers clock;
 *  - the same for a dumped-shape (kit-landed) deadline;
 *  - the stamp writes land: status update, history subcollection row
 *    (fs_group_history), audit_logs row — all inside the handle's
 *    transaction emulation, status re-checked inside the callback;
 *  - a due-soon ISO deadline takes the warning pass (founder notice +
 *    deadlineWarningSentAt update with the serverTimestamp sentinel);
 *  - a far-future request is untouched.
 * Zero live reads; dummy fixture secret.
 */
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupaAdapter } from '@/lib/supa';
import { FakeSupa, landingRow, dumpedTimestamp } from '@/lib/supa/__tests__/fake-supa';
import { createSupaDbHandle } from '@/lib/server/supa-db-handle';

const mockState = { handle: null as unknown };
const mockSends: Array<{ uid: string; type: string }> = [];

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

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: jest.fn(async (uid: string, payload: { type: string }) => {
      mockSends.push({ uid, type: payload.type });
    }),
  },
}));

import { GET } from '../route';

const SECRET = 'g2-test-secret';
const DAY = 24 * 3600 * 1000;

function req() {
  return new NextRequest('http://localhost/api/cron/consent-deadlines', {
    headers: { Authorization: `Bearer ${SECRET}` },
  });
}

beforeAll(() => {
  process.env.CRON_SECRET = SECRET;
});
afterAll(() => {
  delete process.env.CRON_SECRET;
});
beforeEach(() => {
  mockSends.length = 0;
});

describe('consent-deadlines flag ON (Supabase handle)', () => {
  it('stamps ISO + dumped past deadlines via the transaction; warns on the due-soon ISO deadline', async () => {
    const now = Date.now();
    const fake = new FakeSupa()
      .seed('fs_consent_requests', [
        landingRow('cr-iso', {
          status: 'pending',
          requestNumber: 'CR-101',
          requestedByUid: 'u-requester',
          matterLabel: 'Matter A',
          isUrgent: false,
          decisionDeadlineAt: new Date(now - 2 * DAY).toISOString(),
        }),
        landingRow('cr-dumped', {
          status: 'pending',
          requestNumber: 'CR-102',
          requestedByUid: 'u-requester',
          matterLabel: 'Matter B',
          isUrgent: false,
          decisionDeadlineAt: dumpedTimestamp(
            new Date(now - 5 * DAY).toISOString(),
          ),
        }),
        landingRow('cr-soon', {
          status: 'pending',
          requestNumber: 'CR-103',
          requestedByUid: 'u-requester',
          matterLabel: 'Matter C',
          isUrgent: true,
          decisionDeadlineAt: new Date(now + 3 * DAY).toISOString(),
        }),
        landingRow('cr-future', {
          status: 'pending',
          requestNumber: 'CR-104',
          requestedByUid: 'u-requester',
          matterLabel: 'Matter D',
          isUrgent: false,
          decisionDeadlineAt: new Date(now + 40 * DAY).toISOString(),
        }),
      ])
      .seed('fs_audit_logs', [])
      .seed('fs_group_history', []);
    mockState.handle = createSupaDbHandle(
      createSupaAdapter(fake as unknown as SupabaseClient),
    );

    const res = await GET(req());
    expect(res.status).toBe(200);
    const summary = await res.json();
    expect(summary.checked).toBe(4);
    expect(summary.deemedWithheld).toBe(2);
    expect(summary.warningsSent).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.skippedDecidedInFlight).toBe(0);

    const requests = new Map(
      fake.rows('fs_consent_requests').map((r) => [r.id, r.data]),
    );
    for (const id of ['cr-iso', 'cr-dumped']) {
      const stamped = requests.get(id)!;
      expect(stamped.status).toBe('deemed_withheld');
      expect(stamped.decidedByUid).toBe('system_cron');
      expect(typeof stamped.updatedAt).toBe('string');
    }
    const soon = requests.get('cr-soon')!;
    expect(soon.status).toBe('pending');
    expect(typeof soon.deadlineWarningSentAt).toBe('string');
    expect(requests.get('cr-future')!.deadlineWarningSentAt).toBeUndefined();

    // Transaction write set: one history row per stamp, in the
    // consent_requests/{id}/history subcollection (parent_path), and
    // one audit_logs row per stamp.
    const history = fake.rows('fs_group_history');
    expect(history).toHaveLength(2);
    expect(
      history.map((h) => h.parent_path).sort(),
    ).toEqual([
      'consent_requests/cr-dumped/history',
      'consent_requests/cr-iso/history',
    ]);
    expect(history[0].data.event).toBe('deemed_withheld');
    expect(history[0].data.toStatus).toBe('deemed_withheld');

    const audit = fake.rows('fs_audit_logs');
    expect(audit).toHaveLength(2);
    expect(
      audit.every((a) => a.data.action === 'consent_deemed_withheld'),
    ).toBe(true);

    // Notifications: requester notices for the stamps, founder warning
    // for the due-soon request.
    expect(mockSends.filter((s) => s.type === 'consent_deemed_withheld')).toHaveLength(2);
    expect(mockSends.filter((s) => s.type === 'consent_deadline_warning')).toHaveLength(1);
    expect(
      mockSends.find((s) => s.type === 'consent_deemed_withheld')!.uid,
    ).toBe('u-requester');
  });
});
