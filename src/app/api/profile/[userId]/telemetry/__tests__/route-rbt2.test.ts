/**
 * @jest-environment node
 *
 * RBT2 tests for GET /api/profile/[userId]/telemetry:
 * - When the seams answer, tasks / points_ledger / users are served
 *   with ZERO Firestore reads for those collections, and the ledger
 *   is fetched through ONE single-key-form seam call (no dual
 *   snake+camel Firestore queries).
 * - A repeat call inside the cache TTL performs no reads at all.
 * - Auth gates still run before the cache (403 with no reads, even
 *   when a cached payload exists for the target user).
 */

const ts = (iso: string) => ({ toDate: () => new Date(iso) });

const state = {
  authResult: {
    authenticated: true,
    user: { userId: 'owner-1', role: 'member', user: { claims: {} } },
  } as any,
  readOps: [] as string[],
};

const dbCollection = jest.fn((name: string) => ({
  doc: jest.fn((id: string) => ({
    get: jest.fn(async () => {
      state.readOps.push(`${name}/${id}`);
      return { exists: true, data: () => ({}) };
    }),
    collection: jest.fn((sub: string) => ({
      limit: jest.fn(() => ({
        get: jest.fn(async () => {
          state.readOps.push(`${name}/${id}/${sub}`);
          return { docs: [] };
        }),
      })),
    })),
  })),
  where: jest.fn((field: string) => {
    state.readOps.push(`${name}|${field}`);
    return { limit: jest.fn(() => ({ get: jest.fn(async () => ({ docs: [] })) })) };
  }),
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() => ({ collection: dbCollection })),
  admin: {},
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

const seamLedgerCalls: Array<[string, number]> = [];
jest.mock('@/lib/supa/gamification', () => ({
  listPointsLedgerForUserFromSupa: jest.fn(async (userId: string, limit: number) => {
    seamLedgerCalls.push([userId, limit]);
    return [
      { id: 'l1', user_id: userId, action: 'COMPLETION', points_awarded: 20, completed_late: false },
      { id: 'l2', user_id: userId, action: 'PENALTY', points_awarded: 0, penalty_applied: 5 },
    ];
  }),
}));

jest.mock('@/lib/supa/seam-tasks-lists', () => ({
  listDocsViaSeam: jest.fn(async (_coll: string, opts: any) => {
    const field = opts?.where?.[0]?.[0];
    const docs = field === 'assigneeId'
      ? [{
          id: 't1',
          data: () => ({
            title: 'Seamed task', status: 'completed',
            deadline: ts('2026-10-10T00:00:00Z'), completedAt: ts('2026-10-09T00:00:00Z'),
            hoursWorked: 5, points: 20, assigneeId: 'owner-1',
          }),
        }]
      : [];
    return { docs, empty: docs.length === 0, size: docs.length };
  }),
}));

jest.mock('@/lib/supa-seams/profile', () => ({
  tryGetProfileUser: jest.fn(async (userId: string) => ({
    status: 'ok',
    value: {
      exists: true,
      id: userId,
      data: () => ({ displayName: 'Owner One', tasksAssignedCount: 1, points: 500 }),
    },
  })),
}));

import { GET } from '@/app/api/profile/[userId]/telemetry/route';
import { NextRequest } from 'next/server';

function req() {
  return new NextRequest('http://localhost/api/profile/owner-1/telemetry');
}
const params = { params: Promise.resolve({ userId: 'owner-1' }) };

describe('GET telemetry RBT2 seams', () => {
  beforeEach(() => {
    state.readOps = [];
    seamLedgerCalls.length = 0;
    state.authResult = {
      authenticated: true,
      user: { userId: 'owner-1', role: 'member', user: { claims: {} } },
    };
  });

  test('seam-served: no Firestore reads for tasks/points_ledger/users; ledger via ONE seam call', async () => {
    const res = await GET(req(), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.telemetry.tasksCompleted).toBe(1);
    expect(body.telemetry.penaltiesApplied).toBe(5);
    expect(body.telemetry.totalPoints).toBe(500);
    // Exactly one ledger seam call, with the route's bound.
    expect(seamLedgerCalls).toEqual([['owner-1', 300]]);
    // Firestore was touched ONLY for the held legs (warnings,
    // warningConfig, certificates) -- never tasks/points_ledger/user doc.
    const forbidden = state.readOps.filter((op) =>
      op.startsWith('tasks|') || op.startsWith('points_ledger|') || op === 'users/owner-1');
    expect(forbidden).toEqual([]);
  });

  test('repeat call within TTL: cache hit performs no reads at all', async () => {
    await GET(req(), params); // warm (or already warm from prior test)
    state.readOps = [];
    seamLedgerCalls.length = 0;
    const res = await GET(req(), params);
    expect(res.status).toBe(200);
    expect(state.readOps).toEqual([]);
    expect(seamLedgerCalls).toEqual([]);
  });

  test('403 still fires before the cache when a payload is cached', async () => {
    state.authResult = {
      authenticated: true,
      user: { userId: 'stranger-9', role: 'member', user: { claims: {} } },
    } as any;
    state.readOps = [];
    const res = await GET(req(), params);
    expect(res.status).toBe(403);
    expect(state.readOps).toEqual([]);
  });
});
