/**
 * @jest-environment node
 *
 * Route-level Supa dispatch tests for GET /api/admin/dashboard/init
 * (admin-1): when the admin-dashboard seam returns a payload, the route
 * serves it and runs ZERO Firestore data queries; when the seam returns
 * null (flag OFF by default / adapter unavailable / adapter error), the
 * Firestore path runs exactly as pinned by route.test.ts. Auth and the
 * canAccessAdmin gate still run before the seam is consulted.
 */

import { NextRequest } from 'next/server';

type Doc = { id: string; data: Record<string, any> };

const state = {
  authResult: { authenticated: false } as any,
  canAccess: true,
  userDocs: new Map<string, Record<string, any>>(),
  collections: new Map<string, Doc[]>(),
  queryExecutions: 0,
  supaPayload: null as any,
};

function matchingDocs(name: string, filters: Array<[string, unknown]>): Doc[] {
  const rows = state.collections.get(name) || [];
  return rows.filter((d) => filters.every(([f, v]) => d.data[f] === v));
}

function makeQuery(name: string, filters: Array<[string, unknown]> = [], fields?: string[]): any {
  const q: any = {
    where: (f: string, _op: string, v: unknown) => makeQuery(name, [...filters, [f, v]], fields),
    orderBy: () => q,
    limit: () => q,
    select: (...fs: string[]) => makeQuery(name, filters, fs),
    count: () => ({
      get: async () => {
        state.queryExecutions++;
        return { data: () => ({ count: matchingDocs(name, filters).length }) };
      },
    }),
    get: async () => {
      state.queryExecutions++;
      const docs = matchingDocs(name, filters).map((d) => ({
        id: d.id,
        data: () => {
          if (!fields) return { ...d.data };
          const projected: Record<string, unknown> = {};
          for (const f of fields) if (f in d.data) projected[f] = (d.data as Record<string, unknown>)[f];
          return projected;
        },
      }));
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  };
  return q;
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'permissions') {
      return {
        doc: (_id: string) => ({
          get: async () => ({ exists: false, data: () => undefined }),
        }),
      };
    }
    return {
      ...makeQuery(name),
      doc: (id: string) => ({
        get: async () => {
          const data = state.userDocs.get(id);
          return { exists: !!data, id, data: () => data };
        },
      }),
    };
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
  admin: {},
  getAdminDiagnostics: jest.fn(() => ({})),
  getLastAdminError: jest.fn(() => null),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async () => state.canAccess),
  hasServerPermissionForUser: jest.fn(async () => state.canAccess),
}));

jest.mock('@/lib/server/admin-dashboard-supa', () => ({
  tryAdminDashboardInitFromSupa: jest.fn(async () => state.supaPayload),
}));

import { GET } from '@/app/api/admin/dashboard/init/route';
import { tryAdminDashboardInitFromSupa } from '@/lib/server/admin-dashboard-supa';

const supaMock = tryAdminDashboardInitFromSupa as unknown as jest.Mock;
const tsObj = { toDate: () => new Date('2026-10-20T00:00:00Z') };

const SUPA_PAYLOAD = {
  metrics: {
    users: 6,
    projects: 3,
    blogs: 2,
    events: 3,
    announcements: 2,
    applicationsPending: 5,
    applicationsShortlisted: 2,
    applicationsRejected: 1,
  },
  indicators: {
    usersDeparted: 1,
    medianDaysWaiting: 20.0,
    tasksCompleted: 3,
    tasksOverdueRate: 22.2,
  },
  auditLogs: [
    { id: 'ad01', action: 'role_assigned', targetUidOrResource: 'u1', timestamp: '2026-10-25T11:00:00.000Z' },
  ],
};

function fixtures() {
  state.collections = new Map<string, Doc[]>([
    ['users', [
      { id: 'u1', data: { chapterId: 'ist' } },
      { id: 'u2', data: { chapterId: 'ist' } },
      { id: 'u3', data: { chapterId: 'other' } },
    ]],
    ['projects', []],
    ['blogs', []],
    ['events', []],
    ['announcements', []],
    ['applications', []],
    ['tasks', []],
    ['audit_logs', [
      { id: 'l1', data: { chapterId: 'ist', action: 'x', timestamp: tsObj } },
    ]],
  ]);
}

function asUser(userId: string, role: string, doc: Record<string, any>) {
  state.authResult = { authenticated: true, user: { userId, role } };
  state.userDocs.set(userId, doc);
}

function req(qs = '') {
  return new NextRequest(`http://localhost/api/admin/dashboard/init${qs}`);
}

beforeEach(() => {
  state.authResult = { authenticated: false };
  state.canAccess = true;
  state.userDocs = new Map();
  state.queryExecutions = 0;
  state.supaPayload = null;
  fixtures();
  jest.clearAllMocks();
  supaMock.mockImplementation(async () => state.supaPayload);
});

describe('GET /api/admin/dashboard/init — Supa dispatch (admin-1)', () => {
  it('seam payload present: route serves it verbatim and runs zero Firestore data queries', async () => {
    state.supaPayload = SUPA_PAYLOAD;
    asUser('g1', 'superadmin', {});
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metrics).toEqual(SUPA_PAYLOAD.metrics);
    expect(body.indicators).toEqual(SUPA_PAYLOAD.indicators);
    expect(body.auditLogs).toEqual(SUPA_PAYLOAD.auditLogs);
    expect(state.queryExecutions).toBe(0);
    expect(supaMock).toHaveBeenCalledWith({ chapterId: null });
  });

  it('seam receives the effective chapter filter (global caller + switcher)', async () => {
    state.supaPayload = SUPA_PAYLOAD;
    asUser('g1', 'superadmin', {});
    const res = await GET(req('?chapterId=ist'));
    expect(res.status).toBe(200);
    expect(supaMock).toHaveBeenCalledWith({ chapterId: 'ist' });
  });

  it('seam null (flag OFF / unavailable / error): Firestore path runs exactly as before', async () => {
    state.supaPayload = null;
    asUser('g1', 'superadmin', {});
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metrics.users).toBe(3);
    expect(body.auditLogs).toHaveLength(1);
    expect(body.auditLogs[0].id).toBe('l1');
    expect(state.queryExecutions).toBeGreaterThan(0);
  });

  it('unauthenticated: 401 and the seam is never consulted', async () => {
    state.supaPayload = SUPA_PAYLOAD;
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(supaMock).not.toHaveBeenCalled();
  });

  it('foreign chapter: 403 and the seam is never consulted', async () => {
    state.supaPayload = SUPA_PAYLOAD;
    asUser('c1', 'chair_design', { chapterId: 'ist' });
    const res = await GET(req('?chapterId=other'));
    expect(res.status).toBe(403);
    expect(supaMock).not.toHaveBeenCalled();
    expect(state.queryExecutions).toBe(0);
  });
});
