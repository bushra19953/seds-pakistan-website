/**
 * @jest-environment node
 *
 * Tests for GET /api/profile/[userId]/telemetry (WS3).
 *
 * - 401 when unauthenticated; 403 for a non-owner non-admin; no reads on
 *   either failure path.
 * - Owner and admin (superadmin role) receive telemetry, timeline, probation
 *   and sanitised certificates. Ledger camelCase/snake_case entries and both
 *   task assignment forms are merged; task docs are deduped.
 * - Probation warnings only exist on this private route (asserted by shape:
 *   the route response carries them and the public route module does not
 *   import them — covered by the WS3 public-route tests).
 */

type FirestoreTimestamp = { toDate: () => Date };
const ts = (iso: string): FirestoreTimestamp => ({ toDate: () => new Date(iso) });

function makeDoc(id: string, data: any) {
  return { id, data: () => data };
}

const state = {
  authResult: {
    authenticated: true,
    user: { userId: 'owner-1', role: 'member', user: { claims: {} } },
  } as any,
  collections: {
    'tasks|assigneeId': [
      makeDoc('t1', {
        title: 'Build rocket fin',
        status: 'completed',
        deadline: ts('2026-10-10T00:00:00Z'),
        completedAt: ts('2026-10-09T00:00:00Z'),
        hoursWorked: 5,
        points: 20,
        assigneeId: 'owner-1',
        deliverableFiles: [{ fileName: 'fin.pdf', downloadUrl: 'https://drive.example/fin' }],
        resourceLinks: 'https://example.com/proof',
      }),
    ],
    'tasks|assigneeIds': [
      makeDoc('t1', { title: 'Build rocket fin', status: 'completed' }), // dup of t1, must be deduped
      makeDoc('t2', {
        title: 'Paint airframe',
        status: 'completed',
        deadline: ts('2026-10-10T00:00:00Z'),
        completedAt: ts('2026-10-15T00:00:00Z'),
        hoursWorked: 3,
        points: 10,
        assigneeIds: ['owner-1'],
      }),
    ],
    'points_ledger|snake': [
      makeDoc('l1', { user_id: 'owner-1', action: 'COMPLETION', points_awarded: 20, completed_late: false }),
      makeDoc('l2', { user_id: 'owner-1', action: 'PENALTY', points_awarded: 0, penalty_applied: 5 }),
    ],
    'points_ledger|camel': [
      makeDoc('l3', { userId: 'owner-1', action: 'COMPLETION', pointsAwarded: 10, completedLate: true }),
    ],
    'certificates|userId': [
      makeDoc('c1', {
        code: 'SEDS-2026-X1',
        achievement: 'Fin build',
        issueDate: ts('2026-05-01T00:00:00Z'),
        userId: 'owner-1',
        status: 'issued',
      }),
    ],
  } as Record<string, Array<{ id: string; data: () => any }>>,
  warnings: [makeDoc('w1', { reason: 'Missed deadline', createdAt: ts('2026-10-01T00:00:00Z'), expiresAt: ts('2027-01-01T00:00:00Z'), isActive: true })],
  readOps: [] as string[],
  userData: { displayName: 'Owner One', role: 'member', tasksAssignedCount: 10, points: 500 } as Record<string, unknown>,
};

const dbCollection = jest.fn((name: string) => ({
  doc: jest.fn((id: string) => ({
    get: jest.fn(async () => {
      state.readOps.push(`${name}/${id}`);
      return { exists: true, data: () => state.userData };
    }),
    collection: jest.fn((sub: string) => {
      const getWarnings = jest.fn(async () => {
        state.readOps.push(`${name}/${id}/${sub}`);
        return { docs: sub === 'warnings' ? state.warnings : [] };
      });
      return {
        get: getWarnings,
        // Read-bleed bound: the route reads warnings via
        // .limit(50).get() (no orderBy — formal warnings lack createdAt).
        orderBy: jest.fn(() => ({
          limit: jest.fn(() => ({ get: getWarnings })),
          get: getWarnings,
        })),
        limit: jest.fn(() => ({ get: getWarnings })),
      };
    }),
  })),
  where: jest.fn((field: string, _op: string, value: unknown) => {
    const opId = `${name}|${field}`;
    const snakeKey = `${name}|snake`;
    const camelKey = `${name}|camel`;
    return {
      limit: jest.fn(() => ({
        get: jest.fn(async () => {
          state.readOps.push(opId);
          const docs =
            state.collections[opId] ||
            (name === 'points_ledger'
              ? field === 'user_id'
                ? state.collections[snakeKey]
                : state.collections[camelKey]
              : []) ||
            [];
          return { docs };
        }),
      })),
    };
  }),
}));

const mockDb = {
  collection: dbCollection,
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() => mockDb),
  admin: {},
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

import { GET } from '@/app/api/profile/[userId]/telemetry/route';
import { NextRequest } from 'next/server';

function req() {
  return new NextRequest('http://localhost/api/profile/owner-1/telemetry');
}
const params = { params: Promise.resolve({ userId: 'owner-1' }) };

describe('GET /api/profile/[userId]/telemetry', () => {
  beforeEach(() => {
    state.readOps = [];
    state.authResult = {
      authenticated: true,
      user: { userId: 'owner-1', role: 'member', user: { claims: {} } },
    };
    jest.clearAllMocks();
  });

  test('returns 401 for an unauthenticated caller with no Firestore reads', async () => {
    state.authResult = { authenticated: false } as any;
    const res = await GET(req(), params);
    expect(res.status).toBe(401);
    expect(state.readOps).toEqual([]);
  });

  test('returns 403 for a non-owner non-admin with no Firestore reads', async () => {
    state.authResult = {
      authenticated: true,
      user: { userId: 'stranger-9', role: 'member', user: { claims: {} } },
    } as any;
    const res = await GET(req(), params);
    expect(res.status).toBe(403);
    expect(state.readOps).toEqual([]);
  });

  test('owner receives telemetry, timeline, probation and sanitised certificates', async () => {
    const res = await GET(req(), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe('owner-1');

    // Telemetry: tasks merged and deduped (t1 appears in both assignment forms once)
    expect(body.telemetry.tasksCompleted).toBe(2);
    expect(body.telemetry.onTimeRate).toBe(0.5);
    expect(body.telemetry.loggedHours).toBe(8);
    expect(body.telemetry.penaltiesApplied).toBe(5);
    // 500 from counters vs 30 from ledger: max wins
    expect(body.telemetry.totalPoints).toBe(500);

    // Timeline: newest first, proof attached
    expect(body.missionTimeline.map((e: any) => e.taskId)).toEqual(['t2', 't1']);
    expect(body.missionTimeline[1].proof).toEqual([
      { url: 'https://drive.example/fin', label: 'fin.pdf', kind: 'file' },
      { url: 'https://example.com/proof', label: 'https://example.com/proof', kind: 'link' },
    ]);

    // Probation is visible here (private route): the active warning survives
    expect(body.probation.activeWarningCount).toBe(1);
    expect(body.probation.warnings[0].reason).toBe('Missed deadline');
    expect(body.probation.redemptionChecklist.length).toBeGreaterThan(0);

    // Certificates are sanitised and carry verification URLs
    expect(body.certificates).toHaveLength(1);
    expect(body.certificates[0].verificationUrl).toBe('/verify/SEDS-2026-X1');
  });

  test('admin (superadmin role) can read another member telemetry', async () => {
    state.authResult = {
      authenticated: true,
      user: { userId: 'admin-1', role: 'superadmin', user: { claims: {} } },
    } as any;
    const res = await GET(req(), params);
    expect(res.status).toBe(200);
  });

  test('founder uid can read another member telemetry', async () => {
    state.authResult = {
      authenticated: true,
      user: { userId: 'pLW0PuQCTAQHCNK1SfllVhPZdMz1', role: 'member', user: { claims: {} } },
    } as any;
    const res = await GET(req(), params);
    expect(res.status).toBe(200);
  });
});
