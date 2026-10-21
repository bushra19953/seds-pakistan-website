/**
 * @jest-environment node
 *
 * Tests for GET/POST /api/cron/clear-probation
 * (src/app/api/cron/clear-probation/route.ts).
 *
 * The cron auto-archives expired probation warnings:
 *
 * (a) only warnings with isActive == true, isPermanent != true, and expiry
 *     in the past are archived; permanent and unexpired warnings are kept;
 * (b) archived warnings get isActive=false, status='probation_cleared',
 *     expiredAt=<now>;
 * (c) the member doc is repaired: warningCount decremented per archived
 *     warning (FieldValue.increment), activeWarningCount recomputed, and
 *     isBlacklisted cleared when the count falls below the threshold
 *     (mirrors the manual-revoke path);
 * (d) a probation_cleared notification is sent to each touched member;
 * (e) idempotency: a rerun performs zero writes and reports cleared 0;
 * (f) auth: Bearer CRON_SECRET or an authenticated admin session; 401
 *     otherwise, with no writes;
 * (g) warnings with no expiresAt fall back to createdAt + expirationDays.
 *
 * The in-memory Firestore mock applies batch commits to its store, so the
 * idempotency test runs the real handler twice and asserts the second run
 * selects nothing.
 */

import { Timestamp } from 'firebase-admin/firestore';
import { NextRequest } from 'next/server';

interface MockWarning {
  id: string;
  data: Record<string, unknown>;
}

interface MockUser {
  id: string;
  data: Record<string, unknown>;
  warnings: MockWarning[];
}

const state = {
  dbAvailable: true,
  settingsExists: true,
  settingsData: {
    blacklistThreshold: 3,
    expirationDays: 14,
    penaltyPoints: 5,
  } as Record<string, unknown>,
  authResult: { authenticated: false } as any,
  users: [] as MockUser[],
  notifications: [] as Array<{ userId: string; payload: any; priority: string }>,
  batchOps: [] as Array<{ op: string; path: string; data: any }>,
  commitCount: 0,
  // Item 3 F3: uids whose post-commit re-read (ref.get) must throw.
  refGetThrowsFor: new Set<string>(),
};

type Filter = [string, string, unknown];

function matchesFilters(
  data: Record<string, unknown>,
  filters: Filter[]
): boolean {
  return filters.every(([field, op, value]) => {
    if (op === '==') return data[field] === value;
    if (op === '>')
      return (
        typeof data[field] === 'number' &&
        (data[field] as number) > (value as number)
      );
    return false;
  });
}

function isIncrement(value: any): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    value.constructor?.name === 'NumericIncrementTransform' &&
    typeof value.operand === 'number'
  );
}

function applyData(target: Record<string, unknown>, data: Record<string, unknown>) {
  for (const [key, value] of Object.entries(data)) {
    if (isIncrement(value)) {
      const current = typeof target[key] === 'number' ? (target[key] as number) : 0;
      target[key] = current + (value as any).operand;
    } else {
      target[key] = value;
    }
  }
}

function makeWarningSnapshot(user: MockUser, w: MockWarning) {
  return {
    id: w.id,
    exists: true,
    data: () => ({ ...w.data }),
    ref: {
      id: w.id,
      path: `users/${user.id}/warnings/${w.id}`,
      __apply: (data: Record<string, unknown>) => applyData(w.data, data),
    },
  };
}

// Firestore Query builders are immutable: .where returns a NEW query. The
// mock mirrors that, otherwise parallel .where() chains on one collection
// reference would contaminate each other.
function makeWarningQuery(user: MockUser, filters: Filter[]): any {
  return {
    where: (f: string, op: string, v: unknown) =>
      makeWarningQuery(user, [...filters, [f, op, v]]),
    get: async () => {
      const docs = user.warnings
        .filter((w) => matchesFilters(w.data, filters))
        .map((w) => makeWarningSnapshot(user, w));
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  };
}

function makeUserQuery(filters: Filter[]): any {
  return {
    where: (f: string, op: string, v: unknown) =>
      makeUserQuery([...filters, [f, op, v]]),
    get: async () => {
      const docs = state.users
        .filter((u) => matchesFilters(u.data, filters))
        .map(makeUserSnapshot);
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  };
}

function makeUserSnapshot(user: MockUser) {
  return {
    id: user.id,
    exists: true,
    data: () => ({ ...user.data }),
    ref: {
      id: user.id,
      path: `users/${user.id}`,
      // Item 3 R6: the route re-reads the user doc after the batch commit
      // (notification guard). The fake serves the re-read from live state.
      get: async () => {
        if (state.refGetThrowsFor.has(user.id)) {
          throw new Error('simulated re-read failure');
        }
        return makeUserSnapshot(user);
      },
      __apply: (data: Record<string, unknown>) => applyData(user.data, data),
      collection: (_name: string) => makeWarningQuery(user, []),
    },
  };
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'warningConfig') {
      return {
        doc: (id: string) => ({
          id,
          path: `warningConfig/${id}`,
          get: async () => ({
            exists: state.settingsExists,
            data: () => state.settingsData,
          }),
        }),
      };
    }
    if (name === 'users') {
      return makeUserQuery([]);
    }
    if (name === 'audit_logs') {
      // Item 3 F3: the restoration-blocked branch writes an audit entry.
      let n = 0;
      return {
        doc: (id?: string) => ({
          id: id || `audit-${++n}`,
          path: `audit_logs/${id || `audit-${n}`}`,
        }),
      };
    }
    if (name === 'expulsions') {
      // Item 3 F3: no expulsion records exist; the query reads empty.
      const emptyGet = async () => ({ empty: true, size: 0, docs: [] });
      return { where: () => ({ where: () => ({ get: emptyGet }) }) };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
  batch: () => {
    const ops: Array<{ op: string; ref: any; data: Record<string, unknown> }> = [];
    return {
      update: (ref: any, data: Record<string, unknown>) => {
        ops.push({ op: 'update', ref, data });
      },
      set: (ref: any, data: Record<string, unknown>) => {
        ops.push({ op: 'set', ref, data });
      },
      commit: async () => {
        state.commitCount++;
        for (const o of ops) {
          state.batchOps.push({ op: o.op, path: o.ref.path, data: o.data });
          if (typeof o.ref.__apply === 'function') o.ref.__apply(o.data);
        }
      },
    };
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => (state.dbAvailable ? mockDb : null)),
  ensureAdminInitialized: jest.fn(() => state.dbAvailable),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: jest.fn(
      async (userId: string, payload: any, priority: string) => {
        state.notifications.push({ userId, payload, priority });
      }
    ),
  },
}));

import { GET, POST } from '@/app/api/cron/clear-probation/route';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function cronRequest(method: string, withSecret: boolean) {
  const headers: Record<string, string> = {};
  if (withSecret) headers.Authorization = `Bearer ${process.env.CRON_SECRET}`;
  return new NextRequest('http://localhost/api/cron/clear-probation', {
    method,
    headers,
  });
}

function fixtureUsers(): MockUser[] {
  return [
    {
      id: 'u-one',
      data: { displayName: 'Member One', warningCount: 2, isBlacklisted: false },
      warnings: [
        {
          id: 'w-old',
          data: {
            reason: 'Expired warning',
            type: 'missed-deadline',
            isActive: true,
            isPermanent: false,
            createdAt: Timestamp.fromMillis(NOW - 20 * DAY),
            expiresAt: Timestamp.fromMillis(NOW - 6 * DAY),
          },
        },
        {
          id: 'w-new',
          data: {
            reason: 'Still active warning',
            type: 'attendance',
            isActive: true,
            isPermanent: false,
            createdAt: Timestamp.fromMillis(NOW - 2 * DAY),
            expiresAt: Timestamp.fromMillis(NOW + 12 * DAY),
          },
        },
      ],
    },
    {
      id: 'u-blacklisted',
      data: {
        displayName: 'Member Two',
        warningCount: 1,
        isBlacklisted: true,
      },
      warnings: [
        {
          id: 'w-old-2',
          data: {
            reason: 'Expired warning',
            type: 'misconduct',
            isActive: true,
            isPermanent: false,
            createdAt: Timestamp.fromMillis(NOW - 30 * DAY),
            expiresAt: Timestamp.fromMillis(NOW - 16 * DAY),
          },
        },
      ],
    },
    {
      id: 'u-permanent',
      data: { displayName: 'Member Three', warningCount: 1 },
      warnings: [
        {
          id: 'w-perm',
          data: {
            reason: 'Permanent warning',
            type: 'misconduct',
            isActive: true,
            isPermanent: true,
            createdAt: Timestamp.fromMillis(NOW - 90 * DAY),
            expiresAt: Timestamp.fromMillis(NOW - DAY),
          },
        },
      ],
    },
    {
      id: 'u-fallback',
      data: { displayName: 'Member Four', warningCount: 1 },
      warnings: [
        {
          id: 'w-no-expiry',
          data: {
            reason: 'Legacy warning without expiresAt',
            type: 'other',
            isActive: true,
            isPermanent: false,
            createdAt: Timestamp.fromMillis(NOW - 20 * DAY),
          },
        },
      ],
    },
  ];
}

function findUser(id: string) {
  return state.users.find((u) => u.id === id)!;
}

beforeEach(() => {
  process.env.CRON_SECRET = 'test-cron-secret';
  state.dbAvailable = true;
  state.settingsExists = true;
  state.settingsData = {
    blacklistThreshold: 3,
    expirationDays: 14,
    penaltyPoints: 5,
  };
  state.authResult = { authenticated: false };
  state.users = fixtureUsers();
  state.notifications = [];
  state.batchOps = [];
  state.commitCount = 0;
  state.refGetThrowsFor = new Set<string>();
  jest.clearAllMocks();
});

describe('GET /api/cron/clear-probation', () => {
  it('archives expired warnings and repairs member state', async () => {
    const res = await GET(cronRequest('GET', true));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.warningsCleared).toBe(3);
    expect(body.usersTouched).toBe(3);
    expect(body.failed).toBe(0);

    // Archived warning: status marker set, deactivated.
    const wOld = findUser('u-one').warnings.find((w) => w.id === 'w-old')!;
    expect(wOld.data.isActive).toBe(false);
    expect(wOld.data.status).toBe('probation_cleared');
    expect(wOld.data.expiredAt).toBeDefined();

    // Still-active warning untouched.
    const wNew = findUser('u-one').warnings.find((w) => w.id === 'w-new')!;
    expect(wNew.data.isActive).toBe(true);
    expect(wNew.data.status).toBeUndefined();

    // Permanent warning untouched even though its expiresAt passed.
    const wPerm = findUser('u-permanent').warnings.find((w) => w.id === 'w-perm')!;
    expect(wPerm.data.isActive).toBe(true);
    expect(wPerm.data.status).toBeUndefined();

    // Member state repaired.
    expect(findUser('u-one').data.warningCount).toBe(1);
    expect(findUser('u-one').data.activeWarningCount).toBe(1);

    // Member whose only warning expired drops below the threshold and is
    // unblacklisted, with no warnings left active.
    const u2 = findUser('u-blacklisted');
    expect(u2.data.warningCount).toBe(0);
    expect(u2.data.activeWarningCount).toBe(0);
    expect(u2.data.isBlacklisted).toBe(false);
    expect(body.unblacklisted).toBe(1);
    expect(body.usersFullyCleared).toBe(2); // u-blacklisted and u-fallback

    // Fallback expiry: no expiresAt recorded, createdAt + expirationDays
    // (14d) lands in the past, so it is archived too.
    const wNoExpiry = findUser('u-fallback').warnings.find(
      (w) => w.id === 'w-no-expiry'
    )!;
    expect(wNoExpiry.data.isActive).toBe(false);
    expect(wNoExpiry.data.status).toBe('probation_cleared');

    // Member notifications sent for every touched member.
    const clearedNotifs = state.notifications.filter(
      (n) => n.payload.type === 'probation_cleared'
    );
    expect(clearedNotifs).toHaveLength(3);
    expect(clearedNotifs.map((n) => n.userId).sort()).toEqual(
      ['u-blacklisted', 'u-fallback', 'u-one']
    );
    expect(clearedNotifs[0].priority).toBe('P1');
  });

  it('is idempotent: a rerun performs zero writes', async () => {
    const first = await GET(cronRequest('GET', true));
    expect((await first.json()).warningsCleared).toBe(3);
    const opsAfterFirst = state.batchOps.length;
    const commitsAfterFirst = state.commitCount;

    const second = await GET(cronRequest('GET', true));
    const body = await second.json();

    expect(second.status).toBe(200);
    expect(body.warningsCleared).toBe(0);
    expect(body.usersTouched).toBe(0);
    // No new writes: archived warnings now carry isActive=false and are
    // never selected again.
    expect(state.batchOps.length).toBe(opsAfterFirst);
    expect(state.commitCount).toBe(commitsAfterFirst);
  });

  it('leaves a member fully alone when nothing is expired', async () => {
    const res = await GET(cronRequest('GET', true));
    expect(res.status).toBe(200);

    // u-permanent had nothing expired: no warning writes for it and no
    // user-doc update either.
    const permOps = state.batchOps.filter((o) =>
      o.path.startsWith('users/u-permanent')
    );
    expect(permOps).toHaveLength(0);
    expect(findUser('u-permanent').data.warningCount).toBe(1);
  });

  it('accepts an authenticated admin session without the cron secret', async () => {
    state.authResult = {
      authenticated: true,
      user: { userId: 'admin-1', role: 'superadmin' },
    };

    const res = await POST(cronRequest('POST', false));
    expect(res.status).toBe(200);
    expect((await res.json()).warningsCleared).toBe(3);
  });

  it('returns 401 with no writes for unauthenticated callers', async () => {
    const res = await GET(cronRequest('GET', false));

    expect(res.status).toBe(401);
    expect(state.batchOps).toHaveLength(0);
    expect(state.commitCount).toBe(0);
    expect(state.notifications).toHaveLength(0);
  });

  it('rejects a wrong cron secret', async () => {
    const res = await GET(
      new NextRequest('http://localhost/api/cron/clear-probation', {
        method: 'GET',
        headers: { Authorization: 'Bearer wrong-secret' },
      })
    );

    expect(res.status).toBe(401);
    expect(state.batchOps).toHaveLength(0);
  });

  it('falls back to default settings when warningConfig is missing', async () => {
    state.settingsExists = false;

    const res = await GET(cronRequest('GET', true));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.expirationDays).toBe(90);
    // The two warnings with stored expiresAt still archive. The legacy
    // warning without expiresAt falls back to createdAt + 90 days, which is
    // still in the future, so it stays active.
    expect(body.warningsCleared).toBe(2);
    const wNoExpiry = findUser('u-fallback').warnings.find(
      (w) => w.id === 'w-no-expiry'
    )!;
    expect(wNoExpiry.data.isActive).toBe(true);
  });

  it('returns 500 when the database is unavailable', async () => {
    state.dbAvailable = false;

    const res = await GET(cronRequest('GET', true));
    expect(res.status).toBe(500);
    expect(state.batchOps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Item 3 (spec F3): threshold-ban restoration, blocked restoration for
// manual/unknown bans, still-blacklisted, and the re-read failure guard.
// ---------------------------------------------------------------------------

const expiredWarning = (id: string): MockWarning => ({
  id,
  data: {
    reason: 'Expired warning',
    type: 'misconduct',
    isActive: true,
    isPermanent: false,
    createdAt: Timestamp.fromMillis(NOW - 30 * DAY),
    expiresAt: Timestamp.fromMillis(NOW - 16 * DAY),
  },
});

const activeWarning = (id: string): MockWarning => ({
  id,
  data: {
    reason: 'Active warning',
    type: 'misconduct',
    isActive: true,
    isPermanent: false,
    createdAt: Timestamp.fromMillis(NOW - 2 * DAY),
    expiresAt: Timestamp.fromMillis(NOW + 12 * DAY),
  },
});

function userOps(uid: string) {
  return state.batchOps.filter((o) => o.path === `users/${uid}`);
}

describe('GET /api/cron/clear-probation - Item 3 restoration (F3)', () => {
  it.each([
    ['manual-route string', 'Reached 3 warnings. Blacklisted and banned permanently.'],
    ['cron string', 'Exceeded 3 warnings. Auto-blacklisted.'],
  ])(
    'restores a threshold ban (%s): blacklist and ban clear in the SAME update, notification sent',
    async (_label, banReason) => {
      state.users = [
        {
          id: 'u-threshold-ban',
          data: {
            displayName: 'Threshold Banned',
            warningCount: 3,
            isBlacklisted: true,
            blacklistReason: 'Reached 3 active warnings.',
            isBanned: true,
            banReason,
          },
          warnings: [expiredWarning('w-e1'), activeWarning('w-a1'), activeWarning('w-a2')],
        },
      ];

      const res = await GET(cronRequest('GET', true));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.failed).toBe(0);
      expect(body.unbanned).toBe(1);
      expect(body.unblacklisted).toBe(1);

      const repair = userOps('u-threshold-ban')[0];
      expect(repair.data.isBlacklisted).toBe(false);
      expect(repair.data.isBanned).toBe(false);
      expect(repair.data.banReason).toBe('');

      const stored = findUser('u-threshold-ban');
      expect(stored.data.isBlacklisted).toBe(false);
      expect(stored.data.isBanned).toBe(false);

      const notifs = state.notifications.filter(
        (n) => n.userId === 'u-threshold-ban' && n.payload.type === 'probation_cleared'
      );
      expect(notifs).toHaveLength(1);
    }
  );

  it.each([
    ['manual ban', 'Manually banned by admin'],
    ['unknown-reason ban', 'Banned by chapter vote'],
  ])(
    'does NOT clear a %s: blacklist clears, ban stays, no notification, review queued',
    async (_label, banReason) => {
      state.users = [
        {
          id: 'u-manual-ban',
          data: {
            displayName: 'Manually Banned',
            warningCount: 3,
            isBlacklisted: true,
            blacklistReason: 'Reached 3 active warnings.',
            isBanned: true,
            banReason,
          },
          warnings: [expiredWarning('w-e1'), activeWarning('w-a1'), activeWarning('w-a2')],
        },
      ];

      const res = await GET(cronRequest('GET', true));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.failed).toBe(0);
      expect(body.unbanned).toBe(0);
      expect(body.unblacklisted).toBe(1);
      expect(body.restorationBlocked).toContain('u-manual-ban');

      const stored = findUser('u-manual-ban');
      expect(stored.data.isBlacklisted).toBe(false);
      expect(stored.data.isBanned).toBe(true);
      expect(stored.data.banReason).toBe(banReason);
      expect(stored.data.restorationReviewNeeded).toBe(true);

      const repair = userOps('u-manual-ban')[0];
      expect(repair.data.isBanned).toBeUndefined();

      expect(
        state.notifications.filter((n) => n.userId === 'u-manual-ban')
      ).toHaveLength(0);

      const auditSets = state.batchOps.filter(
        (o) => o.op === 'set' && o.path.startsWith('audit_logs/')
      );
      expect(auditSets).toHaveLength(1);
      expect(auditSets[0].data.action).toBe('restoration_blocked');
      expect(auditSets[0].data.targetUid).toBe('u-manual-ban');
    }
  );

  it('still blacklisted at the threshold after expiry: no unblacklist, no unban, no notification', async () => {
    state.users = [
      {
        id: 'u-still-blacklisted',
        data: {
          displayName: 'Still Blacklisted',
          warningCount: 4,
          isBlacklisted: true,
          blacklistReason: 'Reached 3 active warnings.',
        },
        warnings: [expiredWarning('w-e1'), activeWarning('w-a1')],
      },
    ];

    const res = await GET(cronRequest('GET', true));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.unblacklisted).toBe(0);
    expect(body.unbanned).toBe(0);

    const repair = userOps('u-still-blacklisted')[0];
    expect(repair.data.isBlacklisted).toBeUndefined();
    expect(findUser('u-still-blacklisted').data.isBlacklisted).toBe(true);
    expect(
      state.notifications.filter((n) => n.userId === 'u-still-blacklisted')
    ).toHaveLength(0);
  });

  it('re-read failure suppresses the notification and lands the user in failedDetails (fail closed)', async () => {
    state.users = [
      {
        id: 'u-reread-fails',
        data: {
          displayName: 'Re-read Fails',
          warningCount: 3,
          isBlacklisted: true,
          blacklistReason: 'Reached 3 active warnings.',
          isBanned: true,
          banReason: 'Reached 3 warnings. Blacklisted and banned permanently.',
        },
        warnings: [expiredWarning('w-e1'), activeWarning('w-a1'), activeWarning('w-a2')],
      },
    ];
    state.refGetThrowsFor = new Set(['u-reread-fails']);

    const res = await GET(cronRequest('GET', true));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.failed).toBe(1);
    expect(body.failedDetails[0].uid).toBe('u-reread-fails');
    expect(
      state.notifications.filter((n) => n.userId === 'u-reread-fails')
    ).toHaveLength(0);
  });
});
