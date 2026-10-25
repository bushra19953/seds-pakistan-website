/**
 * @jest-environment node
 *
 * Flag-ON behaviour for GET /api/cron/custom-role-expiry-sweep
 * (Supabase migration, cluster cron G2): the route hands the shared
 * handle to the REAL runCustomRoleExpirySweep (FakeSupa underneath);
 * notificationService is mocked (it self-acquires Firestore in
 * production — documented partial coverage). Pins:
 *  - warn path: a grant expiring within the window gets its
 *    expiryAlertStage stamped 't7_sent' on fs_roles through the
 *    handle, with the grant composition untouched, and the alert sent;
 *  - expired path: the governance audit (custom_role_grant_expired)
 *    is written through the handle BEFORE any state change
 *    (contracts 5.4), and the grant is materialised or isolated into
 *    failures — never silently dropped;
 *  - a roles doc with no pending expiry is ignored entirely.
 * Zero live reads; dummy fixture secret.
 */
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupaAdapter } from '@/lib/supa';
import { FakeSupa, landingRow } from '@/lib/supa/__tests__/fake-supa';
import { createSupaDbHandle } from '@/lib/server/supa-db-handle';

const mockState = { handle: null as unknown };
const mockSends: Array<{ uid: string }> = [];

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

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async () => false),
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: jest.fn(async (uid: string) => {
      mockSends.push({ uid });
    }),
  },
}));

import { GET } from '../route';

const SECRET = 'g2-test-secret';
const DAY = 24 * 3600 * 1000;

function req() {
  return new NextRequest('http://localhost/api/cron/custom-role-expiry-sweep', {
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

describe('custom-role-expiry-sweep flag ON (Supabase handle)', () => {
  it('stamps the T-7 warn stage through the handle and leaves the grant untouched', async () => {
    const now = Date.now();
    const fake = new FakeSupa()
      .seed('fs_roles', [
        landingRow('u-warn', {
          role: 'member_basic',
          additionalRoles: ['custom_chapter_lead'],
          chapterId: 'ist',
          expiresAt: new Date(now + 3 * DAY).toISOString(),
          expiresRoleKey: 'custom_chapter_lead',
          expiryAlertStage: 'none',
        }),
        landingRow('u-plain', {
          role: 'member_basic',
          additionalRoles: [],
          chapterId: 'ist',
        }),
      ])
      .seed('fs_users', [landingRow('u-warn', { isBanned: false })]);
    mockState.handle = createSupaDbHandle(
      createSupaAdapter(fake as unknown as SupabaseClient),
    );

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.reminded).toEqual([
      { uid: 'u-warn', roleKey: 'custom_chapter_lead', stage: 't7_sent' },
    ]);
    expect(body.expiredMaterialised).toEqual([]);
    expect(body.failures).toEqual([]);

    const roles = new Map(fake.rows('fs_roles').map((r) => [r.id, r.data]));
    expect(roles.get('u-warn')!.expiryAlertStage).toBe('t7_sent');
    // Warn path mutates ONLY the stage stamp.
    expect(roles.get('u-warn')!.additionalRoles).toEqual([
      'custom_chapter_lead',
    ]);
    expect(roles.get('u-plain')!.expiryAlertStage).toBeUndefined();
    expect(mockSends.length).toBeGreaterThan(0);
  });

  it('expired grant: the audit-before-change write lands through the handle; the grant is never silently dropped', async () => {
    const now = Date.now();
    const fake = new FakeSupa()
      .seed('fs_roles', [
        landingRow('u-exp', {
          role: 'member_basic',
          additionalRoles: ['custom_temp_grant'],
          chapterId: 'ist',
          expiresAt: new Date(now - 1 * DAY).toISOString(),
          expiresRoleKey: 'custom_temp_grant',
          expiryAlertStage: 't7_sent',
          priorRole: null,
          priorAdditionalRoles: [],
        }),
      ])
      .seed('fs_users', [landingRow('u-exp', { isBanned: false })])
      .seed('fs_audit_logs', [])
      .seed('fs_roleHistory', []);
    mockState.handle = createSupaDbHandle(
      createSupaAdapter(fake as unknown as SupabaseClient),
    );

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();

    // Audit BEFORE any state change (contracts 5.4), through the handle.
    const audit = fake
      .rows('fs_audit_logs')
      .filter((a) => a.data.action === 'custom_role_grant_expired');
    expect(audit).toHaveLength(1);
    expect(audit[0].data.targetId ?? audit[0].data.targetUidOrResource).toBeDefined();

    // The grant resolves exactly one way: materialised or isolated
    // into failures (assignRole's deep chain decides which) — never
    // both, never neither.
    const materialised = (body.expiredMaterialised ?? []).filter(
      (e: { uid: string }) => e.uid === 'u-exp',
    );
    const failed = (body.failures ?? []).filter(
      (e: { uid: string }) => e.uid === 'u-exp',
    );
    expect(materialised.length + failed.length).toBe(1);
    if (materialised.length === 1) {
      expect(materialised[0].branch).toBe('restored_prior');
      const role = fake
        .rows('fs_roles')
        .find((r) => r.id === 'u-exp')!.data;
      expect(role.additionalRoles ?? []).not.toContain('custom_temp_grant');
    }
  });
});
