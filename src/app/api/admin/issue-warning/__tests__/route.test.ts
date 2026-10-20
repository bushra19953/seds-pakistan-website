/**
 * @jest-environment node
 *
 * Tests for POST /api/admin/issue-warning
 * (src/app/api/admin/issue-warning/route.ts).
 *
 * Covers Bug 5 recovery:
 * (a) penalty deduction: points decremented via FieldValue.increment(-n) and
 *     totalPenalties incremented on the user doc;
 * (b) points_audit doc written with reason 'manual_warning_penalty' and
 *     actorId = the caller's uid;
 * (c) 'penalty_applied' notification sent to the target user;
 * (d) demotion writes BOTH role stores (roles/{uid}.role and
 *     users/{uid}.role + displayRole), per the repo demotion-staleness rule;
 * (e) unauthorized callers rejected: 401 when unauthenticated, 403 when the
 *     caller lacks canManageUsers, with no Firestore writes;
 * (f) validation: missing userUid / reason are 400;
 * (g) blacklist threshold: hitting the threshold sets both isBlacklisted and
 *     isBanned and sends the account_blacklisted notification.
 */

import { FieldValue } from 'firebase-admin/firestore';

const state = {
  authResult: {
    authenticated: true,
    user: { userId: 'admin-1', displayName: 'Admin One', role: 'superadmin' },
  } as any,
  permissionGranted: true,
  userExists: true,
  userData: { warningCount: 1, points: 100, isBlacklisted: false } as Record<string, unknown>,
  settingsData: {
    blacklistThreshold: 3,
    expirationDays: 90,
    penaltyPoints: 5,
  } as Record<string, unknown>,
  batchOps: [] as Array<{ op: 'set' | 'update'; path: string; data: any; opts?: any }>,
  notifications: [] as Array<{ userId: string; payload: any; priority: string }>,
};

let docCounter = 0;

type MockDocRef = {
  id: string;
  path: string;
  get: () => Promise<{ exists: boolean; data: () => any }>;
  collection?: (name: string) => { doc: () => MockDocRef };
};

function makeRef(path: string, id: string): MockDocRef {
  return {
    id,
    path,
    get: async () => ({ exists: false, data: () => ({}) }),
  };
}

const mockDb = {
  collection: (name: string) => ({
    doc: (id?: string) => {
      const docId = id ?? `auto-${++docCounter}`;
      if (name === 'users') {
        const ref: MockDocRef = {
          id: docId,
          path: `users/${docId}`,
          get: async () => ({
            exists: state.userExists,
            data: () => state.userData,
          }),
          collection: (sub: string) => ({
            doc: () => makeRef(`users/${docId}/${sub}/warn-${++docCounter}`, `warn-${docCounter}`),
          }),
        };
        return ref;
      }
      if (name === 'warningConfig') {
        return {
          id: docId,
          path: `warningConfig/${docId}`,
          get: async () => ({ exists: true, data: () => state.settingsData }),
        };
      }
      // roles, points_audit, and anything else.
      return makeRef(`${name}/${docId}`, docId);
    },
  }),
  batch: () => ({
    set: (ref: MockDocRef, data: any, opts?: any) => {
      state.batchOps.push({ op: 'set', path: ref.path, data, opts });
    },
    update: (ref: MockDocRef, data: any) => {
      state.batchOps.push({ op: 'update', path: ref.path, data });
    },
    commit: async () => undefined,
  }),
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

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: jest.fn(async (userId: string, payload: any, priority: string) => {
      state.notifications.push({ userId, payload, priority });
    }),
  },
}));

import { POST } from '@/app/api/admin/issue-warning/route';
import { NextRequest } from 'next/server';

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/admin/issue-warning', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    userUid: 'target-uid',
    warningType: 'misconduct',
    reason: 'Repeated failure to meet project deadlines.',
    expiresDays: 90,
    isPermanent: false,
    penaltyPoints: 5,
    ...overrides,
  };
}

function findOp(op: 'set' | 'update', pathPrefix: string) {
  return state.batchOps.find((o) => o.op === op && o.path.startsWith(pathPrefix));
}

function findOps(op: 'set' | 'update', pathPrefix: string) {
  return state.batchOps.filter((o) => o.op === op && o.path.startsWith(pathPrefix));
}

beforeEach(() => {
  state.authResult = {
    authenticated: true,
    user: { userId: 'admin-1', displayName: 'Admin One', role: 'superadmin' },
  };
  state.permissionGranted = true;
  state.userExists = true;
  state.userData = { warningCount: 1, points: 100, isBlacklisted: false };
  state.settingsData = { blacklistThreshold: 3, expirationDays: 90, penaltyPoints: 5 };
  state.batchOps = [];
  state.notifications = [];
  docCounter = 0;
  jest.clearAllMocks();
});

describe('POST /api/admin/issue-warning', () => {
  it('creates the warning doc with penaltyPoints and increments warningCount', async () => {
    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.warningCount).toBe(2);
    expect(body.blacklisted).toBe(false);

    const warningOp = findOp('set', 'users/target-uid/warnings/');
    expect(warningOp).toBeDefined();
    expect(warningOp!.data.reason).toContain('Repeated failure');
    expect(warningOp!.data.type).toBe('misconduct');
    expect(warningOp!.data.penaltyPoints).toBe(5);
    expect(warningOp!.data.isActive).toBe(true);
    expect(warningOp!.data.createdBy).toBe('admin-1');

    const userOp = findOp('update', 'users/target-uid');
    expect(userOp).toBeDefined();
    expect(userOp!.data.warningCount).toEqual(FieldValue.increment(1));
  });

  it('deducts penalty points, bumps totalPenalties, and writes the points_audit doc', async () => {
    const res = await POST(postRequest(validBody({ penaltyPoints: 7 })));

    expect(res.status).toBe(200);
    const userOp = findOp('update', 'users/target-uid');
    expect(userOp!.data.points).toEqual(FieldValue.increment(-7));
    expect(userOp!.data.totalPenalties).toEqual(FieldValue.increment(7));

    const auditOps = findOps('set', 'points_audit/');
    expect(auditOps).toHaveLength(1);
    const audit = auditOps[0].data;
    expect(audit.userId).toBe('target-uid');
    expect(audit.delta).toBe(-7);
    expect(audit.reason).toBe('manual_warning_penalty');
    expect(audit.actorId).toBe('admin-1');

    const body = await res.json();
    expect(body.penaltyPoints).toBe(7);
    expect(body.auditId).toBeTruthy();
  });

  it('skips deduction, audit, and notification when penaltyPoints is 0', async () => {
    const res = await POST(postRequest(validBody({ penaltyPoints: 0 })));

    expect(res.status).toBe(200);
    const userOp = findOp('update', 'users/target-uid');
    expect(userOp!.data.points).toBeUndefined();
    expect(userOp!.data.totalPenalties).toBeUndefined();
    expect(findOps('set', 'points_audit/')).toHaveLength(0);
    expect(
      state.notifications.filter((n) => n.payload.type === 'penalty_applied')
    ).toHaveLength(0);
  });

  it('sends the penalty_applied notification to the target user', async () => {
    const res = await POST(postRequest(validBody({ penaltyPoints: 5 })));

    expect(res.status).toBe(200);
    const penaltyNotifs = state.notifications.filter(
      (n) => n.payload.type === 'penalty_applied'
    );
    expect(penaltyNotifs).toHaveLength(1);
    expect(penaltyNotifs[0].userId).toBe('target-uid');
    expect(penaltyNotifs[0].priority).toBe('P0');
    expect(penaltyNotifs[0].payload.body).toContain('5 point');
  });

  it('writes BOTH role stores on demotion and sends the role_changed notification', async () => {
    const res = await POST(
      postRequest(validBody({ penaltyPoints: 0, demoteToRole: 'team_member' }))
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.demotedTo).toBe('team_member');

    // Canonical store: roles/{uid}.role
    const rolesOp = findOp('set', 'roles/target-uid');
    expect(rolesOp).toBeDefined();
    expect(rolesOp!.data.role).toBe('team_member');

    // Legacy mirror: users/{uid}.role + displayRole
    const userOp = findOp('update', 'users/target-uid');
    expect(userOp!.data.role).toBe('team_member');
    expect(userOp!.data.displayRole).toBe('team_member');

    const roleNotifs = state.notifications.filter(
      (n) => n.payload.type === 'role_changed'
    );
    expect(roleNotifs).toHaveLength(1);
    expect(roleNotifs[0].userId).toBe('target-uid');
  });

  it('does not touch role stores when demoteToRole is omitted', async () => {
    const res = await POST(postRequest(validBody({ penaltyPoints: 0 })));

    expect(res.status).toBe(200);
    expect(findOps('set', 'roles/')).toHaveLength(0);
    const userOp = findOp('update', 'users/target-uid');
    expect(userOp!.data.role).toBeUndefined();
    expect((await res.json()).demotedTo).toBeNull();
  });

  it('blacklists AND bans when the warning hits the threshold', async () => {
    state.userData = { warningCount: 2, points: 100, isBlacklisted: false };

    const res = await POST(postRequest(validBody({ penaltyPoints: 0 })));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warningCount).toBe(3);
    expect(body.blacklisted).toBe(true);

    const userOp = findOp('update', 'users/target-uid');
    expect(userOp!.data.isBlacklisted).toBe(true);
    expect(userOp!.data.isBanned).toBe(true);
    expect(userOp!.data.blacklistReason).toContain('3');
    expect(userOp!.data.banReason).toContain('3');

    const blacklistNotifs = state.notifications.filter(
      (n) => n.payload.type === 'account_blacklisted'
    );
    expect(blacklistNotifs).toHaveLength(1);
  });

  it('does not re-blacklist an already blacklisted user', async () => {
    state.userData = { warningCount: 5, points: 100, isBlacklisted: true };

    const res = await POST(postRequest(validBody({ penaltyPoints: 0 })));

    expect(res.status).toBe(200);
    expect((await res.json()).blacklisted).toBe(false);
    const userOp = findOp('update', 'users/target-uid');
    // No blacklist fields in this update (flags already set on the doc).
    expect(userOp!.data.isBlacklisted).toBeUndefined();
    expect(userOp!.data.isBanned).toBeUndefined();
  });

  it('sets a 100-year expiry for permanent warnings', async () => {
    const res = await POST(
      postRequest(validBody({ isPermanent: true, expiresDays: 1 }))
    );

    expect(res.status).toBe(200);
    const warningOp = findOp('set', 'users/target-uid/warnings/');
    expect(warningOp!.data.isPermanent).toBe(true);
    const hundredYearsMs = 100 * 365 * 24 * 60 * 60 * 1000;
    const actualMs =
      warningOp!.data.expiresAt.toMillis() - warningOp!.data.createdAt.toMillis();
    expect(actualMs).toBeGreaterThan(hundredYearsMs - 60 * 1000);
  });

  it('returns 401 for unauthenticated callers with no writes', async () => {
    state.authResult = { authenticated: false, error: 'Unauthorized' };

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(401);
    expect(state.batchOps).toHaveLength(0);
    expect(state.notifications).toHaveLength(0);
  });

  it('returns 403 when the caller lacks canManageUsers with no writes', async () => {
    state.permissionGranted = false;

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(403);
    expect(state.batchOps).toHaveLength(0);
    expect(state.notifications).toHaveLength(0);
  });

  it('returns 400 when reason is missing', async () => {
    const res = await POST(postRequest({ reason: '   ' }));

    expect(res.status).toBe(400);
    expect(state.batchOps).toHaveLength(0);
  });

  it('returns 400 when userUid is missing', async () => {
    const res = await POST(postRequest({ userUid: '' }));

    expect(res.status).toBe(400);
    expect(state.batchOps).toHaveLength(0);
  });

  it('returns 404 when the target user does not exist', async () => {
    state.userExists = false;

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(404);
    expect(state.batchOps).toHaveLength(0);
  });
});
