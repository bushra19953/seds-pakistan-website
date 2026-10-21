/**
 * @jest-environment node
 *
 * Tests for GET /api/admin/banned-restore-report (Item 3, spec F6).
 *
 * The route is a ONE-TIME, read-only report of banned members the live
 * restoration paths cannot reach. It must never write to a user doc;
 * its only write is one audit_logs entry per run.
 */

import { NextRequest } from 'next/server';

const state = {
  authResult: { authenticated: false } as any,
  permissionGranted: true,
  users: [] as Array<{ id: string; data: Record<string, unknown> }>,
  auditAdds: [] as Array<Record<string, unknown>>,
  userWrites: 0,
};

const mockDb = {
  collection: (name: string) => {
    if (name === 'warningConfig') {
      return {
        doc: (_id: string) => ({
          get: async () => ({
            exists: true,
            data: () => ({ blacklistThreshold: 3, expirationDays: 14, penaltyPoints: 5 }),
          }),
        }),
      };
    }
    if (name === 'users') {
      return {
        where: (field: string, op: string, value: unknown) => ({
          get: async () => {
            const docs = state.users
              .filter((u) => (op === '==' ? u.data[field] === value : false))
              .map((u) => ({
                id: u.id,
                data: () => ({ ...u.data }),
                ref: {
                  update: async () => {
                    state.userWrites++;
                  },
                },
              }));
            return { docs, size: docs.length, empty: docs.length === 0 };
          },
        }),
      };
    }
    if (name === 'expulsions') {
      const emptyGet = async () => ({ empty: true, size: 0, docs: [] });
      return { where: () => ({ where: () => ({ get: emptyGet }) }) };
    }
    if (name === 'audit_logs') {
      return {
        add: async (data: Record<string, unknown>) => {
          state.auditAdds.push(data);
          return { id: 'audit-1' };
        },
      };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
  ensureAdminInitialized: jest.fn(() => true),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async () => state.permissionGranted),
}));

import { GET } from '@/app/api/admin/banned-restore-report/route';

function getRequest() {
  return new NextRequest('http://localhost/api/admin/banned-restore-report', {
    method: 'GET',
  });
}

function fixtureUsers() {
  return [
    // (i) banned, not blacklisted, count 1, threshold-pattern reason.
    {
      id: 'u-threshold-orphan',
      data: {
        displayName: 'Threshold Orphan',
        email: 'orphan@example.com',
        isBanned: true,
        isBlacklisted: false,
        warningCount: 1,
        banReason: 'Reached 3 warnings. Blacklisted and banned permanently.',
      },
    },
    // (ii) banned, blacklisted, count 0 (below threshold): included.
    {
      id: 'u-below-threshold',
      data: {
        displayName: 'Below Threshold',
        isBanned: true,
        isBlacklisted: true,
        warningCount: 0,
        banReason: 'Exceeded 3 warnings. Auto-blacklisted.',
      },
    },
    // (iii) banned, blacklisted, count 5 (at/above threshold): EXCLUDED,
    // the live expiry/revoke paths own this case.
    {
      id: 'u-owned-by-live-paths',
      data: {
        displayName: 'Owned By Live Paths',
        isBanned: true,
        isBlacklisted: true,
        warningCount: 5,
        banReason: 'Reached 3 warnings. Blacklisted and banned permanently.',
      },
    },
    // (iv) banned, manual reason, count 0: included, classified manual.
    {
      id: 'u-manual',
      data: {
        displayName: 'Manual Ban',
        isBanned: true,
        isBlacklisted: false,
        warningCount: 0,
        banReason: 'Manually banned by admin',
      },
    },
    // (v) not banned: excluded.
    {
      id: 'u-not-banned',
      data: { displayName: 'Not Banned', isBanned: false, warningCount: 2 },
    },
  ];
}

beforeEach(() => {
  state.authResult = {
    authenticated: true,
    user: { userId: 'founder-1', role: 'superadmin', displayName: 'Founder' },
  };
  state.permissionGranted = true;
  state.users = fixtureUsers();
  state.auditAdds = [];
  state.userWrites = 0;
  jest.clearAllMocks();
});

describe('GET /api/admin/banned-restore-report (Item 3, F6)', () => {
  it('returns 401 unauthenticated with zero writes', async () => {
    state.authResult = { authenticated: false, error: 'Unauthorized' };

    const res = await GET(getRequest());

    expect(res.status).toBe(401);
    expect(state.auditAdds).toHaveLength(0);
    expect(state.userWrites).toBe(0);
  });

  it('returns 403 without canManageUsers with zero writes', async () => {
    state.permissionGranted = false;

    const res = await GET(getRequest());

    expect(res.status).toBe(403);
    expect(state.auditAdds).toHaveLength(0);
    expect(state.userWrites).toBe(0);
  });

  it('lists exactly the unreachable cases, classified, with one audit write and zero user writes', async () => {
    const res = await GET(getRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.threshold).toBe(3);
    expect(body.count).toBe(3);

    const byUid = new Map(body.rows.map((r: any) => [r.uid, r]));
    expect(byUid.has('u-threshold-orphan')).toBe(true);
    expect(byUid.get('u-threshold-orphan').classification).toBe('threshold-pattern');
    expect(byUid.has('u-below-threshold')).toBe(true);
    expect(byUid.get('u-below-threshold').classification).toBe('threshold-pattern');
    expect(byUid.has('u-manual')).toBe(true);
    expect(byUid.get('u-manual').classification).toBe('manual');
    expect(byUid.has('u-owned-by-live-paths')).toBe(false);
    expect(byUid.has('u-not-banned')).toBe(false);
    expect(byUid.get('u-threshold-orphan').hasExpulsionRecord).toBe(false);

    // Exactly one audit_logs write (the report-generated entry), and
    // zero writes to any users doc across the whole run.
    expect(state.auditAdds).toHaveLength(1);
    expect(state.auditAdds[0].action).toBe('banned_restore_report_generated');
    expect(state.auditAdds[0].actorId).toBe('founder-1');
    expect(state.userWrites).toBe(0);
  });
});
