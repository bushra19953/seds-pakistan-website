/**
 * @jest-environment node
 *
 * Perf tests for GET /api/profile/[userId] (profile data-path fix,
 * 2026-10-31; skill: performance / addyosmani web-quality-skills —
 * evidence-led: every assertion below pins a defect measured in the
 * pre-fix route source):
 *
 *  D1 CACHE PRIVACY: the 60 s in-process cache was keyed ONLY by
 *     `${userId}:${sections}` and was checked BEFORE authentication,
 *     while the cached payload carries requester-personalised fields
 *     (owner email + whatsapp, owner/admin-only warnings). An owner's
 *     warm cache entry was therefore served verbatim to ANY later
 *     requester, including anonymous ones.
 *  D2 WASTED WARNINGS READ: the warnings subcollection was fetched
 *     for every `extended` request and then thrown away unless the
 *     requester was the owner or an admin.
 *  D3 NO READ DEADLINES: no leg of the route raced a deadline, so one
 *     hung Firestore leg pinned the whole profile response (and, on
 *     the single free instance, unrelated traffic behind it). The
 *     batch-1 helper src/lib/server/read-deadline.ts existed but was
 *     unused here. These tests shrink the budget via a mock wrapper
 *     so a hanging leg must surface as a failed section, fast.
 *  D4 UNBOUNDED MANAGER LOOKUP: the inline MyTeam legacy leg
 *     `users where managerId in <chunk>` had NO limit() on its
 *     Firestore fallback (the standalone my-team route caps the same
 *     leg at 500).
 *
 * Zero live reads: Firestore, auth, contacts and every seam are
 * fakes, copied from the route-supa-profile harness shape.
 */

import { NextRequest } from 'next/server';

type Row = { id: string; data: Record<string, any> };

const state = {
  authResult: { authenticated: false } as any,
  warningsGets: 0,
  managerLimits: [] as Array<number | null>,
  hangTasks: false,
};

const users: Row[] = [
  { id: 'owner-1', data: { displayName: 'Owner One', displayRole: 'member', role: 'member', points: 5 } },
  { id: 'victim-1', data: { displayName: 'Victim One', displayRole: 'member', role: 'member', points: 1 } },
  { id: 'mgr-1', data: { displayName: 'Manager One', displayRole: 'member', role: 'member' } },
  { id: 'sub-1', data: { displayName: 'Sub One', displayRole: 'member', role: 'member', managerId: 'mgr-1' } },
];
const collections: Record<string, Row[]> = {
  users,
  roles: [],
  projects: [],
  tasks: [],
  certificates: [],
  chapters: [],
  badges: [],
  skills: [],
  reporting_relationships: [],
};
const warningsByUser: Record<string, Row[]> = {
  'victim-1': [{ id: 'w-1', data: { reason: 'test warning' } }],
  'owner-1': [{ id: 'w-9', data: { reason: 'owner warning' } }],
};

function matches(r: Row, field: string, op: string, value: any): boolean {
  if (field === '__name__') {
    if (op === 'in') return (value as string[]).includes(r.id);
    return r.id === value;
  }
  const v = r.data[field];
  if (op === '==') return v === value;
  if (op === 'in') return (value as any[]).includes(v);
  if (op === 'array-contains') return Array.isArray(v) && v.includes(value);
  return true;
}

function makeChain(coll: string, filters: Array<[string, string, any]> = [], limitVal: number | null = null): any {
  return {
    where: (f: string, op: string, v: any) => makeChain(coll, [...filters, [f, op, v]], limitVal),
    limit: (n: number) => makeChain(coll, filters, n),
    get: async () => {
      if (coll === 'tasks' && state.hangTasks) {
        // A leg that never settles: GAPIC retry-storm stand-in.
        return new Promise(() => {});
      }
      if (coll === 'users' && filters.some(([f]) => f === 'managerId')) {
        state.managerLimits.push(limitVal);
      }
      let matched = (collections[coll] || []).filter((r) => filters.every(([f, op, v]) => matches(r, f, op, v)));
      if (limitVal !== null) matched = matched.slice(0, limitVal);
      return { docs: matched.map((r) => ({ id: r.id, data: () => ({ ...r.data }) })), size: matched.length, empty: matched.length === 0 };
    },
  };
}

const mockDb = {
  collection: (name: string) => ({
    ...makeChain(name),
    doc: (id: string) => ({
      get: async () => {
        const r = (collections[name] || []).find((x) => x.id === id);
        return { exists: !!r, id, data: () => (r ? { ...r.data } : undefined) };
      },
      collection: (sub: string) => {
        const getSub = async () => {
          if (sub === 'warnings') state.warningsGets++;
          const docs = (sub === 'warnings' ? warningsByUser[id] || [] : []).map((r) => ({ id: r.id, data: () => ({ ...r.data }) }));
          return { docs, size: docs.length, empty: docs.length === 0 };
        };
        return { get: getSub, limit: () => ({ get: getSub }) };
      },
      set: async () => undefined,
    }),
  }),
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
  ensureAdminInitialized: jest.fn(() => true),
  admin: { firestore: { FieldPath: { documentId: () => '__name__' } } },
}));
jest.mock('firebase-admin/firestore', () => ({
  Timestamp: { now: () => ({ toDate: () => new Date('2026-01-01T00:00:00.000Z') }) },
}));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));
jest.mock('@/lib/server/identity-cache', () => ({ bustIdentity: jest.fn() }));
jest.mock('@/lib/server/user-contact', () => ({
  getUserContact: jest.fn(async (_db: any, uid: string) => ({ whatsappNumber: `wa-${uid}` })),
  resolveUserEmail: jest.fn(async (_db: any, uid: string) => `${uid}@example.test`),
  resolveUserEmails: jest.fn(async (_db: any, ids: string[]) => new Map(ids.map((id) => [id, `${id}@example.test`]))),
  setUserContact: jest.fn(async () => undefined),
  stripContactFields: (d: any) => d,
}));
// Seams OFF: the Firestore legs under test are the ones that run.
jest.mock('@/lib/supa-seams/profile', () => ({
  tryGetProfileUser: jest.fn(async () => ({ status: 'disabled' })),
  tryListUsersByManagerIds: jest.fn(async () => ({ status: 'disabled' })),
  tryGetUsersByIds: jest.fn(async () => ({ status: 'disabled' })),
  tryListProjectsForUser: jest.fn(async () => ({ status: 'disabled' })),
  tryListCertificatesForUser: jest.fn(async () => ({ status: 'disabled' })),
  tryListActiveChapters: jest.fn(async () => ({ status: 'disabled' })),
  tryGetSkillsByIds: jest.fn(async () => ({ status: 'disabled' })),
}));
jest.mock('@/lib/supa/seam-tasks-lists', () => ({
  listDocsViaSeam: jest.fn(async () => null),
}));
jest.mock('@/lib/supa/gamification', () => ({
  listBadgeDefinitionsFromSupa: jest.fn(async () => null),
}));
jest.mock('@/lib/server/identity-backend', () => ({
  useSupaIdentity: jest.fn(() => false),
  getIdentityBundleViaBackend: jest.fn(async () => ({ roles: { exists: false } })),
}));
// Shrink every read budget the route creates to 300 ms so D3 is
// observable in test time; the helper itself is the real one.
jest.mock('@/lib/server/read-deadline', () => {
  const actual = jest.requireActual('@/lib/server/read-deadline');
  return {
    ...actual,
    createReadBudget: (totalMs: number) => actual.createReadBudget(Math.min(totalMs, 300)),
  };
});

import { GET } from '@/app/api/profile/[userId]/route';

async function getProfile(userId: string, qs = '') {
  const res = await GET(new NextRequest(`http://localhost/api/profile/${userId}${qs}`), {
    params: Promise.resolve({ userId }),
  });
  return { res, body: await res.json() };
}

beforeEach(() => {
  state.authResult = { authenticated: false };
  state.warningsGets = 0;
  state.managerLimits = [];
  state.hangTasks = false;
});

describe('GET /api/profile/[userId] perf defects', () => {
  it('D1: an owner-warmed cache entry is NOT served to an anonymous requester', async () => {
    state.authResult = { authenticated: true, user: { userId: 'owner-1' } };
    const first = await getProfile('owner-1');
    expect(first.body.profile.email).toBe('owner-1@example.test');

    state.authResult = { authenticated: false };
    const second = await getProfile('owner-1');
    expect(second.body.profile.email).toBeUndefined();
    expect(second.body.profile.whatsappNumber).toBeUndefined();
  });

  it('D1b: cached extended warnings are NOT served to a non-owner', async () => {
    state.authResult = { authenticated: true, user: { userId: 'victim-1' } };
    const first = await getProfile('victim-1', '?sections=extended');
    expect(first.body.warnings.map((w: any) => w.id)).toEqual(['w-1']);

    state.authResult = { authenticated: false };
    const second = await getProfile('victim-1', '?sections=extended');
    expect(second.body.warnings).toEqual([]);
  });

  it('D2: warnings subcollection is not read for a public (non-owner, non-admin) extended view', async () => {
    state.authResult = { authenticated: false };
    const { body } = await getProfile('victim-1', '?sections=extended');
    expect(body.warnings).toEqual([]);
    expect(state.warningsGets).toBe(0);
  });

  it('D2b: warnings ARE read and returned for the owner', async () => {
    state.authResult = { authenticated: true, user: { userId: 'victim-1' } };
    const { body } = await getProfile('victim-1', '?sections=extended');
    expect(state.warningsGets).toBeGreaterThan(0);
    expect(body.warnings.map((w: any) => w.id)).toEqual(['w-1']);
  });

  it('D3: a hung tasks leg fails its section within the read budget instead of pinning the response', async () => {
    state.hangTasks = true;
    const started = Date.now();
    const { res, body } = await getProfile('owner-1', '?sections=extended');
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(5000);
    expect(body.sectionStatuses.tasks.success).toBe(false);
    expect(body.profile.displayName).toBe('Owner One');
  }, 15000);

  it('D4: the inline MyTeam legacy manager lookup is bounded (limit 500, parity with /api/profile/my-team)', async () => {
    const { body } = await getProfile('mgr-1', '?sections=extended');
    expect(body.myTeam.map((r: any) => r.id)).toEqual(['sub-1']);
    expect(state.managerLimits.length).toBeGreaterThan(0);
    expect(state.managerLimits.every((n) => n === 500)).toBe(true);
  });
});
