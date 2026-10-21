/**
 * @jest-environment node
 *
 * Tests for GET/POST /api/cron/check-deadlines (Item 3, spec F4).
 *
 * The route had NO route-level suite before Phase 0. These cases pin
 * the Item 3 behavior: every warning notifies (even 0-point), the
 * threshold blacklists WITHOUT banning, an audit_logs entry rides the
 * per-assignee batch, and the Bug 4 proof skip + leave exemption keep
 * working.
 */

import { Timestamp } from 'firebase-admin/firestore';
import { NextRequest } from 'next/server';

interface MockTask {
  id: string;
  data: Record<string, any>;
}
interface MockUser {
  id: string;
  data: Record<string, any>;
}

const state = {
  authResult: { authenticated: false } as any,
  settingsData: {
    blacklistThreshold: 3,
    expirationDays: 14,
    penaltyPoints: 5,
  } as Record<string, unknown>,
  tasks: [] as MockTask[],
  users: new Map<string, MockUser>(),
  notifications: [] as Array<{ userId: string; payload: any; priority: string }>,
  warningDocs: [] as Array<{ path: string; data: any }>,
  auditSets: [] as Array<any>,
  pointsAuditAdds: [] as Array<any>,
  taskUpdates: [] as Array<{ id: string; data: any }>,
};

function isIncrement(v: any): boolean {
  return (
    !!v &&
    typeof v === 'object' &&
    v.constructor?.name === 'NumericIncrementTransform' &&
    typeof v.operand === 'number'
  );
}
function isArrayUnion(v: any): boolean {
  return (
    !!v &&
    typeof v === 'object' &&
    v.constructor?.name === 'ArrayUnionTransform' &&
    Array.isArray(v.elements)
  );
}
function applyData(target: Record<string, any>, data: Record<string, unknown>) {
  for (const [key, value] of Object.entries(data)) {
    if (isIncrement(value)) {
      const cur = typeof target[key] === 'number' ? target[key] : 0;
      target[key] = cur + (value as any).operand;
    } else if (isArrayUnion(value)) {
      const cur = Array.isArray(target[key]) ? target[key] : [];
      target[key] = [...cur, ...(value as any).elements];
    } else {
      target[key] = value;
    }
  }
}

let warnSeq = 0;
let auditSeq = 0;

function makeUserRef(user: MockUser) {
  return {
    id: user.id,
    path: `users/${user.id}`,
    get: async () => ({
      exists: true,
      data: () => ({ ...user.data }),
    }),
    collection: (_name: string) => ({
      doc: () => {
        const id = `warn-${++warnSeq}`;
        return { id, path: `users/${user.id}/warnings/${id}` };
      },
    }),
    __user: user,
  };
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'warningConfig') {
      return {
        doc: (_id: string) => ({
          get: async () => ({ exists: true, data: () => state.settingsData }),
        }),
      };
    }
    if (name === 'tasks') {
      return {
        where: (_f: string, _op: string, values: unknown[]) => ({
          get: async () => {
            const docs = state.tasks
              .filter((t) => (values as string[]).includes(t.data.status))
              .map((t) => ({
                id: t.id,
                data: () => ({ ...t.data }),
                ref: {
                  update: async (data: Record<string, unknown>) => {
                    applyData(t.data, data);
                    state.taskUpdates.push({ id: t.id, data });
                  },
                },
              }));
            return { docs, size: docs.length, empty: docs.length === 0 };
          },
        }),
      };
    }
    if (name === 'users') {
      return {
        doc: (uid: string) => {
          const user = state.users.get(uid);
          if (!user) {
            return {
              id: uid,
              path: `users/${uid}`,
              get: async () => ({ exists: false, data: () => undefined }),
              collection: () => ({ doc: () => ({ id: 'x', path: 'x' }) }),
            };
          }
          return makeUserRef(user);
        },
      };
    }
    if (name === 'points_audit') {
      return {
        add: async (data: any) => {
          state.pointsAuditAdds.push(data);
          return { id: `pa-${state.pointsAuditAdds.length}` };
        },
      };
    }
    if (name === 'audit_logs') {
      return {
        doc: () => {
          const id = `audit-${++auditSeq}`;
          return { id, path: `audit_logs/${id}` };
        },
      };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
  batch: () => {
    const ops: Array<{ kind: string; ref: any; data: any }> = [];
    return {
      set: (ref: any, data: any) => ops.push({ kind: 'set', ref, data }),
      update: (ref: any, data: any) => ops.push({ kind: 'update', ref, data }),
      commit: async () => {
        for (const o of ops) {
          if (o.ref.path?.includes('/warnings/')) {
            state.warningDocs.push({ path: o.ref.path, data: o.data });
          } else if (o.ref.path?.startsWith('audit_logs/')) {
            state.auditSets.push(o.data);
          } else if (o.ref.__user) {
            applyData(o.ref.__user.data, o.data);
          }
        }
      },
    };
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
  ensureAdminInitialized: jest.fn(() => true),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: jest.fn(async (userId: string, payload: any, priority: string) => {
      state.notifications.push({ userId, payload, priority });
    }),
  },
}));

import { GET } from '@/app/api/cron/check-deadlines/route';

const DAY = 24 * 60 * 60 * 1000;
const PAST = Date.now() - 2 * DAY;

function cronRequest(withSecret: boolean) {
  const headers: Record<string, string> = {};
  if (withSecret) headers.Authorization = `Bearer ${process.env.CRON_SECRET}`;
  return new NextRequest('http://localhost/api/cron/check-deadlines', {
    method: 'GET',
    headers,
  });
}

function overdueTask(overrides: Record<string, any> = {}): MockTask {
  return {
    id: 'task-1',
    data: {
      title: 'Poster run',
      status: 'pending',
      assigneeIds: ['user-1'],
      deadline: Timestamp.fromMillis(PAST),
      ...overrides,
    },
  };
}

function addUser(overrides: Record<string, any> = {}): MockUser {
  const user: MockUser = {
    id: 'user-1',
    data: { displayName: 'Member One', warningCount: 0, points: 100, ...overrides },
  };
  state.users.set(user.id, user);
  return user;
}

beforeEach(() => {
  process.env.CRON_SECRET = 'test-cron-secret';
  state.authResult = { authenticated: false };
  state.settingsData = { blacklistThreshold: 3, expirationDays: 14, penaltyPoints: 5 };
  state.tasks = [];
  state.users = new Map();
  state.notifications = [];
  state.warningDocs = [];
  state.auditSets = [];
  state.pointsAuditAdds = [];
  state.taskUpdates = [];
  jest.clearAllMocks();
});

describe('GET /api/cron/check-deadlines (Item 3, F4)', () => {
  it('0-point warning: doc created, count incremented, warning_issued notification sent (silent-warning regression)', async () => {
    state.settingsData = { blacklistThreshold: 3, expirationDays: 14, penaltyPoints: 0 };
    addUser();
    state.tasks = [overdueTask()]; // task carries no penaltyPoints of its own

    const res = await GET(cronRequest(true));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warningsIssued).toBe(1);
    expect(body.failed).toBe(0);

    expect(state.warningDocs).toHaveLength(1);
    expect(state.warningDocs[0].data.taskId).toBe('task-1');
    expect(state.warningDocs[0].data.isActive).toBe(true);
    expect(state.warningDocs[0].data.penaltyPoints).toBe(0);

    expect(state.users.get('user-1')!.data.warningCount).toBe(1);
    expect(state.pointsAuditAdds).toHaveLength(0);

    const notifs = state.notifications.filter((n) => n.payload.type === 'warning_issued');
    expect(notifs).toHaveLength(1);
    expect(notifs[0].userId).toBe('user-1');
    expect(notifs[0].priority).toBe('P0');
    expect(notifs[0].payload.body).not.toContain('deducted');

    // R9 audit entry rides the same batch.
    expect(state.auditSets).toHaveLength(1);
    expect(state.auditSets[0].action).toBe('warning_issued');
    expect(state.auditSets[0].actorId).toBe('system');
    expect(state.auditSets[0].targetUid).toBe('user-1');
    expect(state.auditSets[0].data.taskId).toBe('task-1');

    // Task stamped processed.
    expect(state.tasks[0].data.overdueProcessed).toBe(true);
    expect(state.tasks[0].data.status).toBe('overdue');
  });

  it('with penalty: points_audit written, missedDeadlinesCount incremented, body carries the deduction sentence', async () => {
    addUser();
    state.tasks = [overdueTask()];

    const res = await GET(cronRequest(true));
    const body = await res.json();
    expect(body.warningsIssued).toBe(1);

    expect(state.pointsAuditAdds).toHaveLength(1);
    expect(state.pointsAuditAdds[0].delta).toBe(-5);
    expect(state.pointsAuditAdds[0].userId).toBe('user-1');

    const stored = state.users.get('user-1')!.data;
    expect(stored.points).toBe(95);
    expect(stored.missedDeadlinesCount).toBe(1);

    const notif = state.notifications.find((n) => n.payload.type === 'warning_issued')!;
    expect(notif.payload.body).toContain('5 points deducted');
  });

  it('threshold crossing: blacklist pending_review, NO isBanned or banReason, blacklist notification sent', async () => {
    addUser({ warningCount: 2 });
    state.tasks = [overdueTask({ penaltyPoints: 0 })];

    const res = await GET(cronRequest(true));
    const body = await res.json();
    expect(body.blacklistsTriggered).toBe(1);

    const stored = state.users.get('user-1')!.data;
    expect(stored.isBlacklisted).toBe(true);
    expect(stored.blacklistStatus).toBe('pending_review');
    expect(stored.blacklistReason).toBe('Reached 3 active warnings.');
    expect('isBanned' in stored).toBe(false);
    expect('banReason' in stored).toBe(false);

    const bl = state.notifications.filter((n) => n.payload.type === 'account_blacklisted');
    expect(bl).toHaveLength(1);
    expect(bl[0].payload.body).toContain('pending review');
  });

  it('already blacklisted assignee crossing again: blacklist fields are not rewritten (R2)', async () => {
    addUser({
      warningCount: 3,
      isBlacklisted: true,
      blacklistStatus: 'pending_review',
      blacklistReason: 'Reached 3 active warnings.',
    });
    state.tasks = [overdueTask({ penaltyPoints: 0 })];

    const res = await GET(cronRequest(true));
    const body = await res.json();
    expect(body.warningsIssued).toBe(1);
    expect(body.blacklistsTriggered).toBe(0);
    expect(
      state.notifications.filter((n) => n.payload.type === 'account_blacklisted')
    ).toHaveLength(0);
  });

  it('proof-uploaded assignee is skipped and the task is not stamped (Bug 4)', async () => {
    addUser();
    state.tasks = [overdueTask({ deliverableFiles: ['proof.pdf'] })];

    const res = await GET(cronRequest(true));
    const body = await res.json();
    expect(body.warningsIssued).toBe(0);
    expect(body.skipped).toBeGreaterThanOrEqual(1);
    expect(state.warningDocs).toHaveLength(0);
    expect(state.notifications).toHaveLength(0);
    expect(state.tasks[0].data.overdueProcessed).toBeUndefined();
  });

  it('leave-exempt assignee is skipped with no warning and no stamp', async () => {
    addUser({
      isOnVacation: true,
      vacationStartDate: new Date(PAST - DAY).toISOString(),
      vacationEndDate: new Date(PAST + DAY).toISOString(),
      leaveRequestId: 'leave-1',
    });
    state.tasks = [overdueTask()];

    const res = await GET(cronRequest(true));
    const body = await res.json();
    expect(body.warningsIssued).toBe(0);
    expect(body.skipped).toBeGreaterThanOrEqual(1);
    expect(state.warningDocs).toHaveLength(0);
    expect(state.notifications).toHaveLength(0);
    expect(state.tasks[0].data.overdueProcessed).toBeUndefined();
  });

  it('returns 401 for unauthenticated non-cron callers with no writes', async () => {
    addUser();
    state.tasks = [overdueTask()];

    const res = await GET(cronRequest(false));
    expect(res.status).toBe(401);
    expect(state.warningDocs).toHaveLength(0);
    expect(state.notifications).toHaveLength(0);
  });
});
