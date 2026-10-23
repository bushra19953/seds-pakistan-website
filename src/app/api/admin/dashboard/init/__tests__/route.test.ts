/**
 * @jest-environment node
 *
 * Tests for GET /api/admin/dashboard/init (Item 5, spec 5(f) suite 1):
 * the canAccessAdmin gate, canonical-role scope derivation, R1-R3
 * chapter filtering applied uniformly to all seven queries (events
 * included), and the foreign-chapter 403.
 */

import { NextRequest } from 'next/server';

type Doc = { id: string; data: Record<string, any> };

const state = {
  authResult: { authenticated: false } as any,
  canAccess: true,
  userDocs: new Map<string, Record<string, any>>(),
  collections: new Map<string, Doc[]>(),
  queryExecutions: 0,
};

function matchingDocs(name: string, filters: Array<[string, unknown]>): Doc[] {
  const rows = state.collections.get(name) || [];
  return rows.filter((d) => filters.every(([f, v]) => d.data[f] === v));
}

function makeQuery(name: string, filters: Array<[string, unknown]> = []): any {
  const q: any = {
    where: (f: string, _op: string, v: unknown) => makeQuery(name, [...filters, [f, v]]),
    orderBy: () => q,
    limit: () => q,
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
        data: () => ({ ...d.data }),
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

import { GET } from '@/app/api/admin/dashboard/init/route';

const tsObj = { toDate: () => new Date('2026-10-20T00:00:00Z') };

function fixtures() {
  state.collections = new Map<string, Doc[]>([
    ['users', [
      { id: 'u1', data: { chapterId: 'ist' } },
      { id: 'u2', data: { chapterId: 'ist' } },
      { id: 'u3', data: { chapterId: 'other' } },
    ]],
    ['projects', [
      { id: 'p1', data: { chapterId: 'ist' } },
      { id: 'p2', data: { chapterId: 'other' } },
    ]],
    ['blogs', [{ id: 'b1', data: { chapterId: 'ist' } }]],
    ['events', [
      { id: 'e1', data: { chapterId: 'ist' } },
      { id: 'e2', data: { chapterId: 'ist' } },
      { id: 'e3', data: { chapterId: 'other' } },
    ]],
    ['announcements', [{ id: 'a1', data: { chapterId: 'other' } }]],
    ['applications', [
      { id: 'ap1', data: { chapterId: 'ist', status: 'pending' } },
      { id: 'ap2', data: { chapterId: 'ist', status: 'shortlisted' } },
      { id: 'ap3', data: { chapterId: 'other', status: 'pending' } },
      { id: 'ap4', data: { chapterId: 'other', status: 'rejected' } },
    ]],
    ['audit_logs', [
      { id: 'l1', data: { chapterId: 'ist', action: 'x', timestamp: tsObj } },
      { id: 'l2', data: { chapterId: 'other', action: 'y', timestamp: tsObj } },
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
  fixtures();
  jest.clearAllMocks();
});

describe('GET /api/admin/dashboard/init (Item 5)', () => {
  it('1. unauthenticated: 401', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('2. authenticated member without canAccessAdmin: 403 and zero query executions', async () => {
    state.canAccess = false;
    asUser('m1', 'member', { chapterId: 'ist' });
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(state.queryExecutions).toBe(0);
  });

  it('3. chapter caller, no param: all seven counts and the audit fetch are own-chapter, events included', async () => {
    asUser('c1', 'chair_design', { chapterId: 'ist', role: 'chair_design' });
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metrics).toEqual({
      users: 2,
      projects: 1,
      blogs: 1,
      events: 2,
      announcements: 0,
      applicationsPending: 1,
      applicationsShortlisted: 1,
      applicationsRejected: 0,
    });
    expect(body.auditLogs).toHaveLength(1);
    expect(body.auditLogs[0].id).toBe('l1');
  });

  it('4. chapter caller, chapterId = own chapter: 200 with the same filters', async () => {
    asUser('c1', 'chair_design', { chapterId: 'ist' });
    const res = await GET(req('?chapterId=ist'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metrics.users).toBe(2);
    expect(body.metrics.events).toBe(2);
  });

  it('5. chapter caller, chapterId = foreign chapter: 403 and zero count queries executed (headline P9 case)', async () => {
    asUser('c1', 'chair_design', { chapterId: 'ist' });
    const res = await GET(req('?chapterId=other'));
    expect(res.status).toBe(403);
    expect(state.queryExecutions).toBe(0);
  });

  it('6. global caller, no param: no chapter filter anywhere, events included', async () => {
    asUser('g1', 'superadmin', { role: 'superadmin' });
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metrics.users).toBe(3);
    expect(body.metrics.events).toBe(3);
    expect(body.metrics.announcements).toBe(1);
    expect(body.metrics.applicationsPending).toBe(2);
    expect(body.auditLogs).toHaveLength(2);
  });

  it('7. global caller, chapterId = X: every query carries the filter, events included (two-scopes regression)', async () => {
    asUser('g1', 'superadmin', {});
    const res = await GET(req('?chapterId=ist'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metrics.users).toBe(2);
    expect(body.metrics.events).toBe(2);
    expect(body.metrics.announcements).toBe(0);
    expect(body.metrics.applicationsPending).toBe(1);
    expect(body.auditLogs).toHaveLength(1);
  });

  it('8. scope follows the roles-derived role, not the users mirror, in both directions', async () => {
    // Mirror says member, canonical role is global: switcher honoured.
    asUser('g2', 'superadmin', { role: 'member', chapterId: 'ist' });
    const resA = await GET(req('?chapterId=other'));
    expect(resA.status).toBe(200);
    const bodyA = await resA.json();
    expect(bodyA.metrics.users).toBe(1);

    // Mirror says superadmin, canonical role is chapter: foreign chapter 403s.
    asUser('c2', 'chair_design', { role: 'superadmin', chapterId: 'ist' });
    const resB = await GET(req('?chapterId=other'));
    expect(resB.status).toBe(403);
  });

  it('9. chapter caller with no own chapterId: sentinel scope, all counts 0, never unscoped', async () => {
    asUser('c3', 'chair_design', { role: 'chair_design' });
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metrics.users).toBe(0);
    expect(body.metrics.events).toBe(0);
    expect(body.auditLogs).toHaveLength(0);
  });

  it('10. canAccessAdmin via a dynamic grant (non-superadmin role): 200', async () => {
    asUser('o1', 'events_coordinator', { chapterId: 'ist' });
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metrics.users).toBe(2);
  });
});
