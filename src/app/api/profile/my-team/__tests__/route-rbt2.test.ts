/**
 * @jest-environment node
 *
 * RBT2 tests for GET /api/profile/my-team:
 * - EVERY Firestore leg in the BFS carries a limit() (the pre-RBT2
 *   route had none; one founder call fanned out to ~700+ reads).
 * - The returned team shape is unchanged for a realistic org tree
 *   (relationship + legacy-manager reports, depths, direct flags,
 *   counts, currentUser).
 * Seams are forced OFF here so the bounded Firestore path is what
 * runs; seam-first behaviour is covered by the seam suites.
 */

type Row = { id: string; data: Record<string, any> };

const users: Row[] = [
  { id: 'boss-1', data: { displayName: 'Boss', displayRole: 'president_national', role: 'president_national' } },
  { id: 'rel-1', data: { displayName: 'Rel Report', displayRole: 'member', role: 'member', chapterId: 'ch-1' } },
  { id: 'legacy-1', data: { displayName: 'Legacy Report', displayRole: 'member', role: 'member', managerId: 'boss-1', chapterId: 'ch-1' } },
  { id: 'sub-1', data: { displayName: 'Sub Report', displayRole: 'member', role: 'member', managerId: 'rel-1' } },
];
const rels: Row[] = [
  { id: 'r1', data: { managerId: 'boss-1', subordinateId: 'rel-1', type: 'direct' } },
];
const collections: Record<string, Row[]> = {
  users,
  reporting_relationships: rels,
};

const state = { unboundedGets: [] as string[], limitsSeen: [] as number[] };

function matches(r: Row, field: string, op: string, value: any): boolean {
  if (field === '__name__') return op === 'in' ? (value as string[]).includes(r.id) : r.id === value;
  const v = r.data[field];
  if (op === '==') return v === value;
  if (op === 'in') return (value as any[]).includes(v);
  return true;
}

function makeChain(coll: string, filters: Array<[string, string, any]> = [], limitVal: number | null = null): any {
  return {
    where: (f: string, op: string, v: any) => makeChain(coll, [...filters, [f, op, v]], limitVal),
    limit: (n: number) => { state.limitsSeen.push(n); return makeChain(coll, filters, n); },
    get: async () => {
      if (limitVal === null) state.unboundedGets.push(coll);
      let matched = (collections[coll] || []).filter((r) => filters.every(([f, op, v]) => matches(r, f, op, v)));
      if (limitVal !== null) matched = matched.slice(0, limitVal);
      return { docs: matched.map((r) => ({ id: r.id, data: () => ({ ...r.data }) })), size: matched.length, empty: matched.length === 0 };
    },
    doc: (id: string) => ({
      get: async () => {
        const r = (collections[coll] || []).find((x) => x.id === id);
        return { exists: !!r, id, data: () => (r ? { ...r.data } : undefined) };
      },
    }),
  };
}

const mockDb = { collection: (name: string) => makeChain(name) };

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
  ensureAdminInitialized: jest.fn(() => true),
  admin: { firestore: { FieldPath: { documentId: () => '__name__' } } },
}));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => ({
    authenticated: true,
    user: { userId: 'boss-1', role: 'president_national' },
  })),
}));
jest.mock('@/lib/server/user-contact', () => ({
  resolveUserEmails: jest.fn(async (db: any, ids: string[]) =>
    new Map(ids.map((id) => [id, `${id}@example.test`]))),
}));
jest.mock('@/lib/supa-seams/profile', () => ({
  tryGetProfileUser: jest.fn(async () => ({ status: 'disabled' })),
  tryListUsersByManagerIds: jest.fn(async () => ({ status: 'disabled' })),
  tryGetUsersByIds: jest.fn(async () => ({ status: 'disabled' })),
}));
jest.mock('@/lib/supa/seam-tasks-lists', () => ({
  listDocsViaSeam: jest.fn(async () => null),
}));

import { GET } from '@/app/api/profile/my-team/route';
import { NextRequest } from 'next/server';

describe('GET /api/profile/my-team RBT2 bounds', () => {
  beforeEach(() => {
    state.unboundedGets = [];
    state.limitsSeen = [];
  });

  test('no unbounded Firestore gets; team shape unchanged', async () => {
    const res = await GET(new NextRequest('http://localhost/api/profile/my-team'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(state.unboundedGets).toEqual([]);
    expect(state.limitsSeen.length).toBeGreaterThan(0);
    expect(state.limitsSeen.every((n) => n === 500)).toBe(true);

    expect(body.totalCount).toBe(3);
    expect(body.directCount).toBe(2);
    expect(body.indirectCount).toBe(1);
    const byId = Object.fromEntries(body.reports.map((r: any) => [r.id, r]));
    expect(byId['rel-1']).toMatchObject({ displayName: 'Rel Report', depth: 0, isDirectReport: true, relationType: 'direct', email: 'rel-1@example.test', chapterId: 'ch-1' });
    expect(byId['legacy-1']).toMatchObject({ displayName: 'Legacy Report', depth: 0, isDirectReport: true, managerId: 'boss-1' });
    expect(byId['sub-1']).toMatchObject({ displayName: 'Sub Report', depth: 1, isDirectReport: false });
    expect(body.currentUser).toEqual({ id: 'boss-1', displayName: 'Boss', role: 'president_national' });
  });
});
