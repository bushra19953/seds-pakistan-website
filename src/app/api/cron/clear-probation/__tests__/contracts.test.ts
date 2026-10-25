/**
 * @jest-environment node
 *
 * Supabase-migration CONTRACT tests for GET/POST /api/cron/clear-probation —
 * companion to the existing route.test.ts in this folder (which pins
 * the archival write set, derived counter, idempotency and auth arms
 * against an in-memory store). This file pins what that suite does
 * not: the DELEGATION to the four discipline stanzas the route hosts,
 * their failure fallbacks, the exact zero-work response projection
 * (including the settings echo), and the manual arm's shape.
 *
 * Everything is mocked at the same boundaries the route imports;
 * zero live reads.
 */

import { NextRequest } from 'next/server';

const FIXED_NOW = new Date('2026-10-25T05:00:00.000Z');

const state = {
  authResult: { authenticated: false } as any,
  settingsDoc: null as Record<string, any> | null,
  stanzaResults: {
    lifts: { lifted: 2, uids: ['u-a', 'u-b'] } as any,
    restores: { restored: 1, pending: 3, failed: 0 } as any,
    draftExpiry: { expired: 4, caseIds: ['c-1'] } as any,
    defence: { closed: 5, caseIds: ['c-2'] } as any,
  },
  stanzaErrors: {} as Record<string, any>,
  stanzaCalls: [] as Array<{ fn: string; args: any[] }>,
};

const mockDb = {
  collection: (name: string) => {
    if (name === 'warningConfig') {
      return {
        doc: (_id: string) => ({
          get: async () => ({
            exists: state.settingsDoc !== null,
            data: () => state.settingsDoc ?? undefined,
          }),
        }),
      };
    }
    if (name === 'users') {
      const q: any = {
        where: () => q,
        get: async () => ({ docs: [], size: 0, empty: true }),
      };
      return q;
    }
    throw new Error(`unexpected collection: ${name}`);
  },
  batch: () => ({ update: jest.fn(), commit: jest.fn(async () => undefined) }),
};

function stanzaMock(fn: string, resultKey: keyof typeof state.stanzaResults) {
  return jest.fn(async (...args: any[]) => {
    state.stanzaCalls.push({ fn, args });
    if (state.stanzaErrors[fn]) throw state.stanzaErrors[fn];
    return state.stanzaResults[resultKey];
  });
}

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() => mockDb),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn(async () => undefined) },
}));

jest.mock('firebase-admin/firestore', () => ({
  Timestamp: {
    now: () => ({
      toMillis: () => FIXED_NOW.getTime(),
      toDate: () => new Date(FIXED_NOW.getTime()),
    }),
  },
}));

jest.mock('@/lib/server/discipline/derived-counter', () => ({
  computeDerivedWarningCount: jest.fn(async () => 0),
}));

jest.mock('@/lib/server/discipline/stanzas', () => ({
  runSuspensionLifts: stanzaMock('runSuspensionLifts', 'lifts'),
  runDraftExpiry: stanzaMock('runDraftExpiry', 'draftExpiry'),
  runDefenceWindowSweeps: stanzaMock('runDefenceWindowSweeps', 'defence'),
}));

jest.mock('@/lib/server/discipline/adapters-probation', () => ({
  processProbationRestores: stanzaMock('processProbationRestores', 'restores'),
}));

import { GET, POST } from '../route';

const SECRET = 'test-cron-secret';

function req(headers: Record<string, string> = {}, method = 'GET') {
  return new NextRequest('http://localhost/api/cron/clear-probation', { method, headers });
}

const cronHeaders = { Authorization: `Bearer ${SECRET}` };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  state.authResult = { authenticated: false };
  state.settingsDoc = null;
  state.stanzaErrors = {};
  state.stanzaCalls = [];
  state.stanzaResults = {
    lifts: { lifted: 2, uids: ['u-a', 'u-b'] },
    restores: { restored: 1, pending: 3, failed: 0 },
    draftExpiry: { expired: 4, caseIds: ['c-1'] },
    defence: { closed: 5, caseIds: ['c-2'] },
  };
});

afterAll(() => {
  delete process.env.CRON_SECRET;
});

describe('/api/cron/clear-probation — stanza delegation contract', () => {
  it('zero-work run: response is the exact pinned projection, stanzas ride along, defaults are echoed', async () => {
    const res = await GET(req(cronHeaders));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      usersChecked: 0,
      warningsCleared: 0,
      usersTouched: 0,
      usersFullyCleared: 0,
      suspensionsLifted: 2,
      probationRestores: { restored: 1, pending: 3, failed: 0 },
      draftsExpired: 4,
      defenceWindowsClosed: 5,
      skipped: 0,
      failed: 0,
      failedDetails: [],
      message: 'Checked 0 member(s); no expired active warnings found. Nothing to archive.',
      settings: { expirationDays: 90, blacklistThreshold: 3 },
    });
  });

  it('each stanza is delegated exactly once with (db, Date) — restores result passes through verbatim', async () => {
    await GET(req(cronHeaders));
    const byFn = Object.fromEntries(state.stanzaCalls.map((c) => [c.fn, c.args]));
    for (const fn of ['runSuspensionLifts', 'processProbationRestores', 'runDraftExpiry', 'runDefenceWindowSweeps']) {
      expect(byFn[fn]).toHaveLength(2);
      expect(byFn[fn][0]).toBe(mockDb);
      expect(byFn[fn][1]).toBeInstanceOf(Date);
      expect(byFn[fn][1].getTime()).toBe(FIXED_NOW.getTime());
    }
  });

  it('stanza failures degrade to the pinned zero fallbacks and the run still returns 200', async () => {
    state.stanzaErrors = {
      runSuspensionLifts: new Error('lifts down'),
      processProbationRestores: new Error('restores down'),
      runDraftExpiry: new Error('drafts down'),
      runDefenceWindowSweeps: new Error('defence down'),
    };
    const res = await GET(req(cronHeaders));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suspensionsLifted).toBe(0);
    expect(body.probationRestores).toEqual({ restored: 0, pending: 0, failed: 0 });
    expect(body.draftsExpired).toBe(0);
    expect(body.defenceWindowsClosed).toBe(0);
  });

  it('warningConfig doc values override the defaults in the settings echo', async () => {
    state.settingsDoc = { expirationDays: 14, blacklistThreshold: 7 };
    const res = await GET(req(cronHeaders));
    expect((await res.json()).settings).toEqual({ expirationDays: 14, blacklistThreshold: 7 });
  });

  // Current behaviour, pinned: the manual arm checks only that the
  // caller is authenticated and carries SOME role — no permission
  // check (same pattern as TS-P25).
  it('manual arm: any authenticated caller with any role (plain member) triggers the full run', async () => {
    state.authResult = { authenticated: true, user: { userId: 'u-member', role: 'member' } };
    const res = await POST(req({}, 'POST'));
    expect(res.status).toBe(200);
    expect(state.stanzaCalls).toHaveLength(4);
  });
});
