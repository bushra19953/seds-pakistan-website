/**
 * @jest-environment node
 *
 * Tests for GET /api/public/warning-registry
 * (src/app/api/public/warning-registry/route.ts).
 *
 * This route is the read-path fix for the public /warning-registry page:
 * Firestore rules deny direct client reads of `users` and
 * `users/{uid}/warnings` to non-admin visitors, so the page used to show 0
 * records while /admin/defaulters showed active probation records. The
 * route must read the SAME source the admin panel reads and return the
 * SAME active set, sanitized for public consumption:
 *
 * (a) member set = users with warningCount > 0, union blacklisted, union
 *     banned (deduped by uid), exactly like the admin panel;
 * (b) active warnings = users/{uid}/warnings with isActive == true and
 *     non-expired (permanent warnings always active; missing expiresAt
 *     stays active), exactly like the admin status badge;
 * (c) sanitized projection: no warning notes, no admin UIDs, no email or
 *     phone fields anywhere in the payload;
 * (d) publicVisibility=false in warningConfig/global returns 403;
 * (e) missing settings fall back to DEFAULT_WARNING_SETTINGS;
 * (f) unavailable database returns 500.
 */

import { Timestamp } from 'firebase-admin/firestore';

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
  settingsExists: true,
  settingsData: {
    blacklistThreshold: 3,
    expirationDays: 14,
    publicVisibility: true,
  } as Record<string, unknown>,
  users: [] as MockUser[],
  dbAvailable: true,
};

type Filter = [string, string, unknown];

function matchesFilters(
  data: Record<string, unknown>,
  filters: Filter[]
): boolean {
  return filters.every(([field, op, value]) => {
    if (op === '==') return data[field] === value;
    if (op === '>')
      return typeof data[field] === 'number' && (data[field] as number) > (value as number);
    return false;
  });
}

function makeWarningSnapshot(user: MockUser, w: MockWarning) {
  return {
    id: w.id,
    exists: true,
    data: () => ({ ...w.data }),
    ref: { id: w.id, path: `users/${user.id}/warnings/${w.id}` },
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
    throw new Error(`unexpected collection: ${name}`);
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => (state.dbAvailable ? mockDb : null)),
  ensureAdminInitialized: jest.fn(() => state.dbAvailable),
}));

import { GET } from '@/app/api/public/warning-registry/route';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function fixtureUsers(): MockUser[] {
  return [
    {
      id: 'u-alpha',
      data: {
        displayName: 'Alpha User',
        chapterId: 'ch-1',
        warningCount: 2,
        isBlacklisted: false,
        email: 'alpha@example.com',
        whatsappNumber: '03001234567',
      },
      warnings: [
        {
          id: 'w-active',
          data: {
            reason: 'Missed review deadline',
            type: 'missed-deadline',
            severity: 'medium',
            notes: 'INTERNAL NOTE: repeat offender, do not publish',
            createdBy: 'admin-uid-1',
            createdByName: 'Admin One',
            createdAt: Timestamp.fromMillis(NOW - 2 * DAY),
            expiresAt: Timestamp.fromMillis(NOW + 12 * DAY),
            isActive: true,
            isPermanent: false,
            penaltyPoints: 5,
            appealStatus: 'none',
            taskId: 'task-9',
            taskTitle: 'Chapter Report',
          },
        },
        {
          id: 'w-expired',
          data: {
            reason: 'Old expired warning',
            type: 'attendance',
            createdBy: 'admin-uid-1',
            createdAt: Timestamp.fromMillis(NOW - 40 * DAY),
            expiresAt: Timestamp.fromMillis(NOW - 26 * DAY),
            isActive: true,
            isPermanent: false,
          },
        },
        {
          id: 'w-revoked',
          data: {
            reason: 'Revoked warning',
            type: 'other',
            createdBy: 'admin-uid-1',
            createdAt: Timestamp.fromMillis(NOW - DAY),
            expiresAt: Timestamp.fromMillis(NOW + 13 * DAY),
            isActive: false,
          },
        },
      ],
    },
    {
      id: 'u-beta',
      data: {
        displayName: 'Beta User',
        chapterId: 'ch-2',
        warningCount: 0,
        isBlacklisted: true,
        email: 'beta@example.com',
      },
      warnings: [],
    },
    {
      id: 'u-gamma',
      data: {
        displayName: 'Gamma User',
        chapterId: 'ch-1',
        warningCount: 1,
        isBlacklisted: false,
      },
      warnings: [
        {
          id: 'w-permanent',
          data: {
            reason: 'Permanent standing warning',
            type: 'misconduct',
            createdBy: 'admin-uid-2',
            createdAt: Timestamp.fromMillis(NOW - 90 * DAY),
            expiresAt: Timestamp.fromMillis(NOW - DAY),
            isActive: true,
            isPermanent: true,
          },
        },
      ],
    },
    {
      id: 'u-clean',
      data: {
        displayName: 'Clean User',
        warningCount: 0,
        isBlacklisted: false,
        isBanned: false,
      },
      warnings: [],
    },
  ];
}

beforeEach(() => {
  state.settingsExists = true;
  state.settingsData = {
    blacklistThreshold: 3,
    expirationDays: 14,
    publicVisibility: true,
  };
  state.users = fixtureUsers();
  state.dbAvailable = true;
  jest.clearAllMocks();
});

describe('GET /api/public/warning-registry', () => {
  it('returns the same active set the admin panel sees, deduped', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    const uids = body.users.map((u: any) => u.uid);
    // Clean member excluded; warned + blacklisted members present once each.
    expect(uids).not.toContain('u-clean');
    expect(uids.filter((u: string) => u === 'u-alpha')).toHaveLength(1);
    expect(uids.filter((u: string) => u === 'u-beta')).toHaveLength(1);
    expect(uids).toContain('u-gamma');
    // Blacklisted members sort first.
    expect(uids[0]).toBe('u-beta');

    const alpha = body.users.find((u: any) => u.uid === 'u-alpha');
    // isActive=false (revoked) is excluded by the query; the expired one is
    // excluded by the non-expired filter; only the live warning remains.
    expect(alpha.activeWarnings).toHaveLength(1);
    expect(alpha.activeWarnings[0].id).toBe('w-active');
    expect(alpha.activeWarnings[0].reason).toBe('Missed review deadline');
    expect(alpha.activeWarnings[0].penaltyPoints).toBe(5);
    expect(alpha.activeWarnings[0].taskTitle).toBe('Chapter Report');

    const gamma = body.users.find((u: any) => u.uid === 'u-gamma');
    // Permanent warnings never expire even when expiresAt is in the past.
    expect(gamma.activeWarnings).toHaveLength(1);
    expect(gamma.activeWarnings[0].isPermanent).toBe(true);
  });

  it('never leaks internal or private fields', async () => {
    const res = await GET();
    const body = await res.json();
    const serialized = JSON.stringify(body);

    expect(serialized).not.toContain('INTERNAL NOTE');
    expect(serialized).not.toContain('admin-uid-1');
    expect(serialized).not.toContain('alpha@example.com');
    expect(serialized).not.toContain('03001234567');
    expect(serialized).not.toContain('createdBy');

    const alpha = body.users.find((u: any) => u.uid === 'u-alpha');
    expect(alpha.email).toBeUndefined();
    expect(alpha.whatsappNumber).toBeUndefined();
    expect(alpha.activeWarnings[0].notes).toBeUndefined();
    expect(alpha.activeWarnings[0].taskId).toBeUndefined();
  });

  it('returns 403 when publicVisibility is off and exposes no users', async () => {
    state.settingsData = { ...state.settingsData, publicVisibility: false };

    const res = await GET();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/not public/i);
    expect(body.users).toBeUndefined();
  });

  it('falls back to default settings when warningConfig is missing', async () => {
    state.settingsExists = false;

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.blacklistThreshold).toBe(3);
    expect(body.settings.expirationDays).toBe(90);
  });

  it('serializes Firestore timestamps to ISO strings', async () => {
    const res = await GET();
    const body = await res.json();
    const alpha = body.users.find((u: any) => u.uid === 'u-alpha');
    const w = alpha.activeWarnings[0];
    expect(typeof w.createdAt).toBe('string');
    expect(w.createdAt).toBe(new Date(NOW - 2 * DAY).toISOString());
    expect(new Date(w.expiresAt).getTime()).toBeGreaterThan(NOW);
  });

  it('returns 500 when the database is unavailable', async () => {
    state.dbAvailable = false;

    const res = await GET();
    expect(res.status).toBe(500);
  });
});
