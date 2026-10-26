/**
 * @jest-environment node
 *
 * Route tests for GET /api/profile/[userId] Supabase migration (G4):
 * flag OFF = Firestore baseline, flag ON = users/roles reads served by
 * the mocked seam adapter, flag ON + adapter error = Firestore fallback
 * byte-identical. Tasks inclusion is pinned assignee-only in every mode
 * (the route's task reads are NOT migrated). Zero live reads. */

import { NextRequest } from 'next/server';

type Row = { id: string; data: Record<string, any> };
const ts = (iso: string) => ({ toDate: () => new Date(iso) });

const state = { authResult: { authenticated: false } as any, userDocGets: 0 };

const users: Row[] = [
  { id: 'off-1', data: { displayName: 'Firestore User', displayRole: 'member', role: 'member', points: 3 } },
  { id: 'on-1', data: { displayName: 'Firestore Shadow', displayRole: 'member', role: 'member', points: 1 } },
  { id: 'err-1', data: { displayName: 'Fallback User', displayRole: 'member', role: 'member', points: 9 } },
  { id: 'team-1', data: { displayName: 'Team Lead', displayRole: 'member', role: 'member' } },
];
const collections: Record<string, Row[]> = {
  users,
  roles: [],
  projects: [],
  tasks: [
    { id: 't-mine', data: { title: 'Mine', assigneeId: 'off-1' } },
    { id: 't-array', data: { title: 'Array', assigneeIds: ['off-1'] } },
    { id: 't-other', data: { title: 'Other', assigneeId: 'someone-else' } },
    { id: 't-on', data: { title: 'OnTask', assigneeId: 'on-1' } },
  ],
  certificates: [],
  chapters: [],
  badges: [],
  skills: [],
  reporting_relationships: [],
};
const warningsByUser: Record<string, Row[]> = {};

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
        if (name === 'users') state.userDocGets++;
        const r = (collections[name] || []).find((x) => x.id === id);
        return { exists: !!r, id, data: () => (r ? { ...r.data } : undefined) };
      },
      collection: (sub: string) => ({
        get: async () => {
          const docs = (sub === 'warnings' ? warningsByUser[id] || [] : []).map((r) => ({ id: r.id, data: () => ({ ...r.data }) }));
          return { docs, size: docs.length, empty: docs.length === 0 };
        },
      }),
    }),
  }),
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
  ensureAdminInitialized: jest.fn(() => true),
  admin: { firestore: { FieldPath: { documentId: () => '__name__' } } },
}));
jest.mock('firebase-admin/firestore', () => ({
  Timestamp: { now: () => ts('2026-01-01T00:00:00.000Z') },
}));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));
jest.mock('@/lib/server/identity-cache', () => ({ bustIdentity: jest.fn() }));

import { GET } from '@/app/api/profile/[userId]/route';
import { setAdapterForTests, resetAdapterForTests, type SupaAdapter } from '@/lib/supa-seams/profile';

const supaUsers: Record<string, any> = {
  'on-1': { id: 'on-1', displayName: 'Supa User', displayRole: 'member', role: 'member', points: 42, termsAcceptedAt: '2026-01-15T00:00:00.000Z', agreedToTermsAt: '2026-01-15T00:00:00.000Z' },
  'team-1': { id: 'team-1', displayName: 'Team Lead', displayRole: 'member', role: 'member' },
  'sub-supa': { id: 'sub-supa', displayName: 'Supa Sub', displayRole: 'member', role: 'member', managerId: 'team-1' },
};
function fakeAdapter(fail = false): SupaAdapter {
  const boom = async () => { throw new Error('supa down'); };
  return {
    getDoc: fail ? (boom as any) : async (coll: string, id: string) => (coll === 'users' ? supaUsers[id] ?? null : null),
    listDocs: fail ? (boom as any) : async (coll: string, opts: any) => {
      if (coll !== 'users') return [];
      const mgr = opts?.where?.find((w: any) => w[0] === 'managerId')?.[2] as string[];
      return Object.values(supaUsers).filter((u: any) => mgr?.includes(String(u.managerId)));
    },
    countDocs: async () => 0,
    setDoc: async (_c: string, id: string, data: any) => ({ id, ...data }),
    updateDoc: async (_c: string, id: string, data: any) => ({ id, ...data }),
    deleteDoc: async () => undefined,
    rpc: async () => { throw new Error('unexpected rpc'); },
    tx: async () => { throw new Error('unexpected tx'); },
  };
}

async function getProfile(userId: string, qs = '') {
  const res = await GET(new NextRequest(`http://localhost/api/profile/${userId}${qs}`), {
    params: Promise.resolve({ userId }),
  });
  return { res, body: await res.json() };
}

beforeEach(() => {
  state.authResult = { authenticated: false };
  state.userDocGets = 0;
  delete process.env.SUPA_SURFACES;
  resetAdapterForTests();
});
afterAll(() => {
  delete process.env.SUPA_SURFACES;
  resetAdapterForTests();
});

describe('GET /api/profile/[userId] supa migration', () => {
  it('flag OFF: Firestore serves the profile; tasks stay assignee-only', async () => {
    setAdapterForTests(fakeAdapter());
    const { res, body } = await getProfile('off-1');
    expect(res.status).toBe(200);
    expect(body.profile.displayName).toBe('Firestore User');
    expect(body.profile.points).toBe(3);
    expect(body.tasks.map((t: any) => t.id).sort()).toEqual(['t-array', 't-mine']);
    expect(state.userDocGets).toBeGreaterThan(0);
  });

  it('flag ON: users doc served by Supa (Firestore user doc NOT read for the shell); tasks unchanged', async () => {
    process.env.SUPA_SURFACES = 'profile';
    setAdapterForTests(fakeAdapter());
    const { body } = await getProfile('on-1');
    expect(body.profile.displayName).toBe('Supa User');
    expect(body.profile.points).toBe(42);
    expect(state.userDocGets).toBe(0);
    expect(body.tasks.map((t: any) => t.id)).toEqual(['t-on']);
    // termsAcceptedAt: ISO in jsonb -> Timestamp JSON shape of Firestore today
    expect(body.profile.termsAcceptedAt).toEqual({ _seconds: 1768435200, _nanoseconds: 0 });
    expect(body.profile.termsAccepted).toBe(true);
  });

  it('flag ON + adapter error: Firestore fallback, identical to flag OFF', async () => {
    process.env.SUPA_SURFACES = 'profile';
    setAdapterForTests(fakeAdapter(true));
    const { res, body } = await getProfile('err-1');
    expect(res.status).toBe(200);
    expect(body.profile.displayName).toBe('Fallback User');
    expect(body.profile.points).toBe(9);
    expect(body.sectionStatuses.profile).toEqual({ success: true });
  });

  it('flag ON: unknown user in Supa -> 200 with profile_not_found (not a Firestore read)', async () => {
    process.env.SUPA_SURFACES = 'profile';
    setAdapterForTests(fakeAdapter());
    const { res, body } = await getProfile('ghost-supa');
    expect(res.status).toBe(200);
    expect(body.profile).toBeNull();
    expect(body.sectionStatuses.profile).toEqual({ success: false, error: 'User not found', errorCode: 'profile_not_found' });
    expect(state.userDocGets).toBe(0);
  });

  it('flag ON: inline MyTeam legacy users come from Supa (managerId list + by-ids detail)', async () => {
    process.env.SUPA_SURFACES = 'profile';
    setAdapterForTests(fakeAdapter());
    const { body } = await getProfile('team-1', '?sections=extended');
    expect(body.myTeam).toEqual([
      expect.objectContaining({ id: 'sub-supa', displayName: 'Supa Sub', isDirectReport: true }),
    ]);
  });
});
