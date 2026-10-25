/**
 * @jest-environment node
 *
 * Supabase-migration CONTRACT tests for GET/POST /api/cron/check-deadlines —
 * companion to the existing route.test.ts (B3 bearer arms + shadow
 * summary via the cron arm) and referral.test.ts /
 * custom-role-expiry-hosting.test.ts (live-path behaviour) in this
 * folder. This file pins what those do not:
 *
 *  - TS-P25: the manual arm accepts ANY authenticated caller who has a
 *    role — there is no permission check (hasServerPermission is never
 *    imported by this route). Pinned as current behaviour, NOT fixed.
 *  - The 401 split (unauthenticated vs authenticated-without-role).
 *  - The 500 init/db failure bodies and their ordering (auth, then
 *    admin init, then db, then the discipline settings read).
 *  - The EXACT shadow-mode summary object.
 *
 * All collaborators mocked; zero live reads.
 */

import { NextRequest } from 'next/server';

const state = {
  authResult: { authenticated: false } as any,
  adminInit: true,
  db: { __sentinel: 'check-deadlines-db' } as any,
  settingsError: null as any,
  settingsCalls: 0,
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => state.db),
  ensureAdminInitialized: jest.fn(() => state.adminInit),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn(async () => undefined) },
}));

jest.mock('@/lib/server/discipline/settings', () => ({
  getDisciplineSettings: jest.fn(async (db: any) => {
    state.settingsCalls += 1;
    if (state.settingsError) throw state.settingsError;
    expect(db).toBe(state.db);
    return {
      shadowMode: true,
      cronReferralLive: false,
      referralWindowDays: 28,
      referralMissThreshold: 3,
      warningRegistryVariant: 'retired',
    };
  }),
}));

jest.mock('@/lib/server/discipline/miss-records', () => ({
  recordMiss: jest.fn(async () => ({ created: false })),
  evaluateReferralPatterns: jest.fn(async () => ({ draftsCreated: 0, digestsSent: 0 })),
}));

jest.mock('@/lib/server/leave-exemption', () => ({
  isExemptFromDeadlinePenalty: jest.fn(() => ({ exempt: false })),
}));

jest.mock('@/lib/server/bug4-proof-guards', () => ({
  taskHasProofUploaded: jest.fn(() => false),
}));

import { GET, POST } from '../route';

const SECRET = 'test-cron-secret';

function req(headers: Record<string, string> = {}, method = 'GET') {
  return new NextRequest('http://localhost/api/cron/check-deadlines', { method, headers });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  state.authResult = { authenticated: false };
  state.adminInit = true;
  state.db = { __sentinel: 'check-deadlines-db' };
  state.settingsError = null;
  state.settingsCalls = 0;
});

afterAll(() => {
  delete process.env.CRON_SECRET;
});

const SHADOW_BODY = {
  success: true,
  checked: 0,
  overdue: 0,
  tasksProcessed: 0,
  warningsIssued: 0,
  blacklistsTriggered: 0,
  missRecordsCreated: 0,
  referralDraftsCreated: 0,
  skipped: 0,
  skippedDetails: [],
  failed: 0,
  failedDetails: [],
  message:
    'Shadow mode: deadline-miss recording is not live yet (settings/discipline.cronReferralLive is false). The legacy auto-warning path has been retired and issues nothing.',
};

describe('/api/cron/check-deadlines — manual-arm + failure contract (TS-P25)', () => {
  // SECURITY FLAG TS-P25 (current behaviour, pinned not fixed): the
  // manual arm requires only an authenticated session carrying SOME
  // role. A plain member — no admin permission of any kind — triggers
  // the full cron. When the discipline flag is flipped live, this same
  // arm will write deadline_miss_records and referral drafts.
  it('SECURITY FLAG TS-P25: any authenticated user with any role (plain member, no permission check) triggers the cron', async () => {
    state.authResult = { authenticated: true, user: { userId: 'u-member', role: 'member' } };
    const res = await POST(req({}, 'POST'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SHADOW_BODY);
    expect(state.settingsCalls).toBe(1);
  });

  it('authenticated caller WITHOUT a role gets 401 { error: "Unauthorized" } and settings are never read', async () => {
    state.authResult = { authenticated: true, user: { userId: 'u-1' } };
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(state.settingsCalls).toBe(0);
  });

  it('unauthenticated caller gets 401 before admin init is even consulted', async () => {
    state.adminInit = false; // would 500 if the order were reversed
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(state.settingsCalls).toBe(0);
  });

  it('admin not initialized -> 500 { error: "Firebase Admin not initialized" }', async () => {
    state.adminInit = false;
    const res = await GET(req({ Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Firebase Admin not initialized' });
    expect(state.settingsCalls).toBe(0);
  });

  it('db unavailable -> 500 { error: "Firestore not initialized" }', async () => {
    state.db = null;
    const res = await GET(req({ Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Firestore not initialized' });
    expect(state.settingsCalls).toBe(0);
  });

  it('shadow mode: the cron-arm response is EXACTLY the pinned shadow summary object', async () => {
    const res = await GET(req({ Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SHADOW_BODY);
  });

  it('settings read failure -> 500 { error: <message> } from the outer catch', async () => {
    state.settingsError = new Error('settings doc unreadable');
    const res = await GET(req({ Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'settings doc unreadable' });
  });
});
