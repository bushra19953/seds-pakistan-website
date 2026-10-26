/**
 * @jest-environment node
 *
 * Flag-ON behaviour for GET /api/cron/compliance (cutover seam,
 * C-G2-2 closure): the REAL engine, generator, governance-settings,
 * governance-audit and compliance-role-holders run against the
 * shared Firestore-shaped handle over the adapter (FakeSupa
 * underneath), threaded by the route's scoped ALS context — the
 * modules' pinned entry signatures are unchanged. Firestore getDb()
 * is mocked to NULL: any silent fallback to Firestore fails the run,
 * so a green run proves the seam carried every acquisition.
 * notificationService is mocked (it self-acquires in production —
 * the cluster's named split, unchanged).
 *
 * Pins:
 *  - the complianceLive flag is read from fs_governance_settings;
 *  - an instance whose dueDate is an ISO STRING (adapter shape) is
 *    seen by the engine (tsToDate string branch) — before the fix it
 *    was silently skipped;
 *  - the reminder is routed to the LIVE holder resolved from
 *    fs_roles, the receipt + ladder advance land in
 *    fs_compliance_obligations, and audit rows (engine ladder +
 *    route cron_run) land in fs_audit_logs.
 * Zero live reads; dummy fixture secret.
 */
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupaAdapter } from '@/lib/supa';
import { FakeSupa, landingRow } from '@/lib/supa/__tests__/fake-supa';
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

// The engine stamps with the real firebase-admin FieldValue
// sentinels so the handle resolves them structurally.
jest.mock('firebase-admin', () => {
  const actual = jest.requireActual('firebase-admin');
  return { ...actual };
});

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: jest.fn(async (uid: string, payload: { type: string }) => {
      mockSends.push({ uid, type: payload.type });
    }),
    broadcastByRoles: jest.fn(async () => undefined),
  },
}));

import { GET } from '../route';

const SECRET = 'compliance-seam-secret';
const DAY = 24 * 3600 * 1000;

function req() {
  return new NextRequest('http://localhost/api/cron/compliance', {
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

describe('compliance cron flag ON (seam context + Supabase handle)', () => {
  it('runs the whole engine on the handle: flag read, ISO-due reminder, receipt, ladder, audits', async () => {
    const now = Date.now();
    const fake = new FakeSupa()
      .seed('fs_governance_settings', [
        landingRow('phase2', {
          flags: {
            consentLive: false,
            boardLive: false,
            disciplineLive: false,
            cadetshipLive: false,
            complianceLive: true,
          },
          consentGateMode: {},
        }),
      ])
      .seed('fs_compliance_templates', [
        landingRow('bank-reconciliation', {
          templateKey: 'bank-reconciliation',
          title: 'Monthly bank reconciliation',
          officeRole: 'national_treasurer',
          cadence: 'monthly',
          deadlineRule: { kind: 'fixed_day_of_month', day: 15 },
          reminderOffsetsDays: [30, 14, 7],
          alsoNotifiedRoles: [],
          active: true,
          templateVersion: 1,
        }),
      ])
      .seed('fs_compliance_obligations', [
        landingRow('inst-1', {
          templateKey: 'bank-reconciliation',
          templateVersion: 1,
          title: 'Monthly bank reconciliation',
          officeRole: 'national_treasurer',
          ownerUidSnapshot: null,
          chapterId: null,
          periodKey: '2026-11',
          // Adapter shape: ISO string. The pre-seam tsToDate read
          // this as null and skipped the instance entirely.
          dueDate: new Date(now + 10 * DAY).toISOString(),
          status: 'scheduled',
          remindersSent: { d30: null, d14: null, d7: null },
          reminderReceipts: [],
          defaultNoticeId: null,
          seedHold: false,
        }),
      ])
      .seed('fs_roles', [
        landingRow('holder-1', { role: 'national_treasurer' }),
      ])
      .seed('fs_chapters', [])
      .seed('fs_compliance_meta', [])
      .seed('fs_default_notices', [])
      .seed('fs_audit_logs', []);
    mockState.handle = createSupaDbHandle(
      createSupaAdapter(fake as unknown as SupabaseClient),
    );

    const res = await GET(req());
    expect(res.status).toBe(200);
    const summary = await res.json();
    expect(summary.ok).toBe(true);
    expect(summary.passes.reminders.ok).toBe(true);
    expect(summary.passes.reminders.counts.sent).toBeGreaterThanOrEqual(1);

    // Reminder routed to the LIVE holder resolved from fs_roles.
    expect(
      mockSends.some(
        (s) => s.uid === 'holder-1' && s.type === 'compliance_reminder',
      ),
    ).toBe(true);

    // Receipt + snapshot + ladder advance landed in Supabase.
    const inst = fake
      .rows('fs_compliance_obligations')
      .find((r) => r.id === 'inst-1')!;
    expect(inst.data.ownerUidSnapshot).toBe('holder-1');
    const receipts = inst.data.reminderReceipts as Array<{ uid: string; ok: boolean }>;
    expect(receipts.some((r) => r.uid === 'holder-1' && r.ok)).toBe(true);
    expect(inst.data.status).not.toBe('scheduled');

    // Audit rows landed in fs_audit_logs (engine + route cron_run).
    const actions = fake.rows('fs_audit_logs').map((r) => r.data.action);
    expect(actions).toContain('compliance.cron_run');
  });
});
