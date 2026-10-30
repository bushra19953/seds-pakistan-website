/**
 * @jest-environment node
 *
 * Perf tests for GET /api/profile/my-team (profile data-path fix,
 * 2026-10-31; skill: performance / addyosmani web-quality-skills).
 *
 * DEFECTS (pre-fix):
 *  M1 NO SERVER CACHE: the route recomputed the full BFS on every
 *     hit while two components on the same profile page (my-team.tsx
 *     and team-tasks.tsx) both call it, and its own response already
 *     promised browsers `private, max-age=30`. The route must serve
 *     repeat calls for the same user from a short-TTL in-process
 *     cache (the response is scoped to the authenticated user, so a
 *     per-user key is exact, not shared).
 *  M2 NO READ DEADLINE: the BFS had no wall-clock budget at all (the
 *     inline profile-route copy at least had a 3 s soft check), so a
 *     hung leg pinned the request indefinitely.
 *
 * Seams are forced OFF (same as the RBT2 suite) so the Firestore BFS
 * is what runs. Zero live reads.
 */

type Row = { id: string; data: Record<string, any> };

const users: Row[] = [
  { id: 'boss-1', data: { displayName: 'Boss', displayRole: 'president_national', role: 'president_national' } },
  { id: 'rel-1', data: { displayName: 'Rel Report', displayRole: 'member', role: 'member', chapterId: 'ch-1' } },
  { id: 'legacy-1', data: { displayName: 'Legacy Report', displayRole: 'member', role: 'member', managerId: 'boss-1', chapterId: 'ch-1' } },
];
const rels: Row[] = [
  { id: 'r1', data: { managerId: 'boss-1', subordinateId: 'rel-1', type: 'direct' } },
];
const collections: Record<string, Row[]> = {
  users,
  reporting_relationships: rels,
};

const state = { collectionGets: 0, hangUsers: false };

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
    limit: (n: number) => makeChain(coll, filters, n),
    get: async () => {
      state.collectionGets++;
      if (coll === 'users' && state.hangUsers) return new Promise(() => {});
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
  resolveUserEmails: jest.fn(async (_db: any, ids: string[]) =>
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
// Shrink every read budget the route creates to 300 ms (M2).
jest.mock('@/lib/server/read-deadline', () => {
  const actual = jest.requireActual('@/lib/server/read-deadline');
  return {
    ...actual,
    createReadBudget: (totalMs: number) => actual.createReadBudget(Math.min(totalMs, 300)),
  };
});

import { GET } from '@/app/api/profile/my-team/route';
import { NextRequest } from 'next/server';

beforeEach(() => {
  state.collectionGets = 0;
  state.hangUsers = false;
});

describe('GET /api/profile/my-team perf', () => {
  // M2 runs FIRST: it must execute before any successful call has
  // populated the per-user cache, or the hang would be masked by it.
  test('M2: a hung users leg cannot pin the route past its read budget', async () => {
    state.hangUsers = true;
    const started = Date.now();
    const res = await GET(new NextRequest('http://localhost/api/profile/my-team'));
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(5000);
    // Loud, not fake: either a 500, or a 200 explicitly marked as
    // deadline-truncated. A silent complete-looking team is a fail.
    if (res.status === 200) {
      const body = await res.json();
      expect(body.deadlineExceeded).toBe(true);
    } else {
      expect(res.status).toBe(500);
    }
  }, 15000);

  test('M1: a repeat call for the same user is served from the server cache (no new collection gets)', async () => {
    const first = await GET(new NextRequest('http://localhost/api/profile/my-team'));
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.totalCount).toBe(2);
    const getsAfterFirst = state.collectionGets;
    expect(getsAfterFirst).toBeGreaterThan(0);

    const second = await GET(new NextRequest('http://localhost/api/profile/my-team'));
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody).toEqual(firstBody);
    expect(state.collectionGets).toBe(getsAfterFirst);
  });
});
