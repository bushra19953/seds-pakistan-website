/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION CONTRACT — COMPLIANCE/DISCIPLINE, clusters 1+3
 * (cron half).
 *
 * Pinned from src/app/api/cron/clear-probation/route.ts:
 *  - the user-doc update this cron writes is EXACTLY
 *    { warningCount: <derived>, activeWarningCount, updatedAt }
 *    (route.ts:243-247) — isBlacklisted is NEVER cleared here
 *    (route header :31-32 and code: no isBlacklisted key is ever
 *    written), and reaching/passing the blacklist threshold in the
 *    settings doc changes nothing: blacklistThreshold is loaded and
 *    reported but never acted on;
 *  - the suspension-lift stanza hosted by this cron
 *    (discipline/stanzas.ts runSuspensionLifts) clears exactly the
 *    three suspension fields and likewise never touches
 *    isBlacklisted/isBanned;
 *  - the probation-restore stanza result is surfaced in the
 *    response as probationRestores {restored,pending,failed}.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { NextRequest } from 'next/server';

interface MockWarning { id: string; data: Record<string, any> }
interface MockUser { id: string; data: Record<string, any>; warnings: MockWarning[] }

const state = {
  authResult: { authenticated: false } as any,
  users: [] as MockUser[],
  notifications: [] as Array<{ userId: string; payload: any }>,
  batchOps: [] as Array<{ path: string; data: any }>,
  auditRows: [] as Array<Record<string, any>>,
};

type Filter = [string, string, unknown];
function matches(data: Record<string, any>, filters: Filter[]): boolean {
  return filters.every(([f, op, v]) => {
    if (op === '==') return data[f] === v;
    if (op === '>') return typeof data[f] === 'number' && data[f] > (v as number);
    if (op === '!=') return data[f] !== v && data[f] !== undefined;
    return false;
  });
}
function applyData(target: Record<string, any>, data: Record<string, any>) {
  for (const [k, val] of Object.entries(data)) target[k] = val;
}
function makeWarningQuery(user: MockUser, filters: Filter[]): any {
  return {
    where: (f: string, op: string, v: unknown) => makeWarningQuery(user, [...filters, [f, op, v]]),
    get: async () => {
      const docs = user.warnings.filter((w) => matches(w.data, filters)).map((w) => ({
        id: w.id, exists: true, data: () => ({ ...w.data }),
        ref: { id: w.id, path: `users/${user.id}/warnings/${w.id}`, __apply: (d: any) => applyData(w.data, d) },
      }));
      return { docs, size: docs.length, empty: docs.length === 0, forEach: (cb: any) => docs.forEach(cb) };
    },
  };
}
function makeUserSnapshot(user: MockUser): any {
  const ref = {
    id: user.id, path: `users/${user.id}`,
    __apply: (d: any) => applyData(user.data, d),
    update: async (d: any) => applyData(user.data, d),
    collection: (_n: string) => makeWarningQuery(user, []),
  };
  return { id: user.id, exists: true, data: () => ({ ...user.data }), ref };
}
function makeUserQuery(filters: Filter[]): any {
  return {
    where: (f: string, op: string, v: unknown) => makeUserQuery([...filters, [f, op, v]]),
    get: async () => {
      const docs = state.users.filter((u) => matches(u.data, filters)).map(makeUserSnapshot);
      return { docs, size: docs.length, empty: docs.length === 0, forEach: (cb: any) => docs.forEach(cb) };
    },
  };
}
const emptyQuery: any = {
  where: () => emptyQuery, select: () => emptyQuery, limit: () => emptyQuery,
  get: async () => ({ docs: [], size: 0, empty: true, forEach: (_cb: any) => {} }),
};
const mockDb = {
  collection: (name: string) => {
    if (name === 'users') return makeUserQuery([]);
    if (name === 'warningConfig') {
      return { doc: (_id: string) => ({ get: async () => ({ exists: true, data: () => ({ blacklistThreshold: 3, expirationDays: 14 }) }) }) };
    }
    if (name === 'audit_logs') {
      return { doc: () => ({ id: `audit-${state.auditRows.length}`, set: async (row: any) => { state.auditRows.push(row); } }) };
    }
    // disciplinary_cases / probation_restores: empty in these fixtures.
    return emptyQuery;
  },
  batch: () => {
    const ops: Array<{ ref: any; data: any }> = [];
    return {
      update: (ref: any, data: any) => { ops.push({ ref, data }); },
      commit: async () => { for (const o of ops) { state.batchOps.push({ path: o.ref.path, data: o.data }); o.ref.__apply(o.data); } },
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
  notificationService: { send: jest.fn(async (userId: string, payload: any) => { state.notifications.push({ userId, payload }); }) },
}));

import { GET } from '@/app/api/cron/clear-probation/route';

const DAY = 86400000;
const NOW = Date.now();
function expiredWarning(id: string): MockWarning {
  return { id, data: { isActive: true, isPermanent: false, createdAt: Timestamp.fromMillis(NOW - 30 * DAY), expiresAt: Timestamp.fromMillis(NOW - DAY) } };
}
function findUser(id: string) { return state.users.find((u) => u.id === id)!; }

beforeEach(() => {
  process.env.CRON_SECRET = 'test-cron-secret';
  state.authResult = { authenticated: false };
  state.notifications = [];
  state.batchOps = [];
  state.auditRows = [];
  state.users = [
    { id: 'u-black', data: { displayName: 'Legacy Blacklisted', warningCount: 1, isBlacklisted: true }, warnings: [expiredWarning('w-b1')] },
    {
      id: 'u-three', data: { displayName: 'Three Warnings', warningCount: 3, isBlacklisted: false },
      warnings: [expiredWarning('w-t1'), expiredWarning('w-t2'), expiredWarning('w-t3')],
    },
    {
      id: 'u-susp', data: {
        displayName: 'Suspended', warningCount: 2, isBlacklisted: true,
        privilegesSuspendedUntil: Timestamp.fromMillis(NOW - DAY), suspendedFrom: Timestamp.fromMillis(NOW - 10 * DAY), suspensionCaseId: 'case-9',
      },
      warnings: [],
    },
  ];
});

function cronReq() {
  return new NextRequest('http://localhost/api/cron/clear-probation', { method: 'GET', headers: { Authorization: 'Bearer test-cron-secret' } });
}

describe('CONTRACT 1+3 (cron): clear-probation never blacklists, never un-blacklists', () => {
  it('expiry at/above the threshold sets NO blacklist flag and clears NO legacy flag', async () => {
    const res = await GET(cronReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.blacklistThreshold).toBe(3);
    expect(body.warningsCleared).toBe(4);

    // u-three had exactly the threshold count: flags untouched either way.
    const three = findUser('u-three');
    expect(three.data.isBlacklisted).toBe(false);
    expect(three.data.isBanned).toBeUndefined();
    expect(three.data.warningCount).toBe(0); // derived count (no decided cases), not a threshold effect
    expect(three.data.activeWarningCount).toBe(0);

    // u-black keeps the legacy flag: only Founder reinstatement clears it.
    const black = findUser('u-black');
    expect(black.data.isBlacklisted).toBe(true);
    expect(black.data.warningCount).toBe(0);
  });

  it('the only user-doc keys this cron writes are warningCount, activeWarningCount, updatedAt (+ suspension lift fields)', async () => {
    await GET(cronReq());
    const userBatchOps = state.batchOps.filter((o) => /^users\/[^/]+$/.test(o.path));
    expect(userBatchOps.length).toBeGreaterThan(0);
    for (const op of userBatchOps) {
      expect(Object.keys(op.data).sort()).toEqual(['activeWarningCount', 'updatedAt', 'warningCount']);
      expect(op.data).not.toHaveProperty('isBlacklisted');
      expect(op.data).not.toHaveProperty('isBanned');
    }
  });

  it('the hosted suspension lift clears exactly the three suspension fields and leaves isBlacklisted alone', async () => {
    const res = await GET(cronReq());
    const body = await res.json();
    expect(body.suspensionsLifted).toBe(1);
    expect(body.probationRestores).toEqual({ restored: 0, pending: 0, failed: 0 });
    const susp = findUser('u-susp');
    expect(susp.data.privilegesSuspendedUntil).toBeNull();
    expect(susp.data.suspendedFrom).toBeNull();
    expect(susp.data.suspensionCaseId).toBeNull();
    expect(susp.data.isBlacklisted).toBe(true);
    expect(susp.data.warningCount).toBe(2); // no expired warnings -> the cron repair never ran for this user
    expect(state.auditRows.some((a) => a.action === 'suspension_lifted' && a.targetId === 'u-susp')).toBe(true);
  });
});
