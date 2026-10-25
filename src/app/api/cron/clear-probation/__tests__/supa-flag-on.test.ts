/**
 * @jest-environment node
 *
 * Flag-ON behaviour for GET /api/cron/clear-probation (Supabase
 * migration, cluster cron G3): the route and the SHARED discipline
 * libraries it delegates to (derived-counter, stanzas,
 * adapters-probation — never edited by this group) run against the
 * shared Firestore-shaped db handle over the adapter (FakeSupa
 * underneath). Pins:
 *  - warnings stored with ISO-string timestamps (the adapter's storage
 *    shape) are expiry-evaluated by the route's toMillisSafe union
 *    exactly like Firestore Timestamps: the expired one is archived
 *    (isActive false, status probation_cleared) in the warnings
 *    subcollection table, the live one is untouched;
 *  - the user doc is repaired in the same batch: warningCount becomes
 *    the DERIVED count of decided strike cases (computed through the
 *    handle, including its .select() projection call) and
 *    activeWarningCount reflects the remaining live warnings;
 *  - notificationService is mocked: it self-acquires Firestore (the
 *    documented partial coverage in g3-data.ts) and must not be
 *    exercised against any live store here.
 * Zero live reads; dummy fixture secret.
 */
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupaAdapter } from '@/lib/supa';
import { FakeSupa, landingRow } from '@/lib/supa/__tests__/fake-supa';
import { createSupaDbHandle } from '@/lib/server/supa-db-handle';

const mockState = { handle: null as unknown };
const mockSend = jest.fn(async () => undefined);

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() => null),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => ({ authenticated: false })),
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: mockSend },
}));

jest.mock('@/lib/server/cron/g3-data', () => ({
  G3_SURFACE: 'cron-g3',
  getG3Db: () => mockState.handle,
}));

import { GET } from '../route';

const SECRET = 'g3-test-secret';
const DAY = 24 * 60 * 60 * 1000;

function req() {
  return new NextRequest('http://localhost/api/cron/clear-probation', {
    headers: { Authorization: `Bearer ${SECRET}` },
  });
}

beforeAll(() => {
  process.env.CRON_SECRET = SECRET;
});
afterAll(() => {
  delete process.env.CRON_SECRET;
});

describe('clear-probation flag ON (Supabase handle)', () => {
  it('archives exactly the expired ISO-timestamp warning and repairs counters via the derived count', async () => {
    const now = Date.now();
    const fake = new FakeSupa()
      .seed('fs_warningConfig', [
        landingRow('global', { expirationDays: 90, blacklistThreshold: 3 }),
      ])
      .seed('fs_users', [
        landingRow('u1', {
          warningCount: 2,
          activeWarningCount: 2,
          isBlacklisted: false,
        }),
      ])
      .seed('fs_group_warnings', [
        landingRow(
          'w-expired',
          {
            isActive: true,
            createdAt: new Date(now - 100 * DAY).toISOString(),
            expiresAt: new Date(now - 10 * DAY).toISOString(),
          },
          'users/u1/warnings',
          'u1',
        ),
        landingRow(
          'w-live',
          {
            isActive: true,
            createdAt: new Date(now - 10 * DAY).toISOString(),
            expiresAt: new Date(now + 80 * DAY).toISOString(),
          },
          'users/u1/warnings',
          'u1',
        ),
      ])
      .seed('fs_disciplinary_cases', [
        landingRow('case1', {
          subjectUid: 'u1',
          status: 'closed',
          strikeNumber: 1,
          founderReview: { outcome: 'upheld' },
        }),
        landingRow('case2', {
          subjectUid: 'u1',
          status: 'notice_issued',
          strikeNumber: null,
        }),
      ])
      .seed('fs_probation_restores', []);
    mockState.handle = createSupaDbHandle(
      createSupaAdapter(fake as unknown as SupabaseClient),
    );

    const res = await GET(req());
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.usersChecked).toBe(1);
    expect(body.warningsCleared).toBe(1);
    expect(body.usersTouched).toBe(1);
    expect(body.usersFullyCleared).toBe(0);
    expect(body.failed).toBe(0);

    const warnings = new Map(fake.rows('fs_group_warnings').map((r) => [r.id, r.data]));
    const expired = warnings.get('w-expired')!;
    expect(expired.isActive).toBe(false);
    expect(expired.status).toBe('probation_cleared');
    expect(typeof expired.expiredAt).toBe('string');
    const live = warnings.get('w-live')!;
    expect(live.isActive).toBe(true);
    expect(live.status).toBeUndefined();

    const user = fake.rows('fs_users')[0].data;
    expect(user.warningCount).toBe(1); // derived: one decided strike case
    expect(user.activeWarningCount).toBe(1); // w-live remains

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toBe('u1');
  });

  it('a user whose warnings are all live is skipped with zero writes', async () => {
    const now = Date.now();
    const fake = new FakeSupa()
      .seed('fs_warningConfig', [])
      .seed('fs_users', [
        landingRow('u9', { warningCount: 1, activeWarningCount: 1 }),
      ])
      .seed('fs_group_warnings', [
        landingRow(
          'w-only',
          {
            isActive: true,
            createdAt: new Date(now - DAY).toISOString(),
            expiresAt: new Date(now + 30 * DAY).toISOString(),
          },
          'users/u9/warnings',
          'u9',
        ),
      ])
      .seed('fs_disciplinary_cases', [])
      .seed('fs_probation_restores', []);
    mockState.handle = createSupaDbHandle(
      createSupaAdapter(fake as unknown as SupabaseClient),
    );

    const res = await GET(req());
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.warningsCleared).toBe(0);
    expect(body.usersTouched).toBe(0);
    expect(body.skipped).toBe(1);
    expect(fake.rows('fs_users')[0].data.warningCount).toBe(1);
    expect(fake.rows('fs_group_warnings')[0].data.isActive).toBe(true);
  });
});
