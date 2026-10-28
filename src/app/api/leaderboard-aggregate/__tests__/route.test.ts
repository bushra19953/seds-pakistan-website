/**
 * @jest-environment node
 *
 * GET /api/leaderboard-aggregate — the pinned entry contract.
 *
 * The pinned row (Founder and Patron-in-Chief) used to be resolved in
 * the browser via a direct users/{uid} Firestore read. The security
 * rules deny user-doc reads to signed-out visitors (verified live
 * 2026-10-28: anonymous GET users/{founderUid} -> 403, chapters and
 * badges -> 200), so the pin silently vanished for the public. The pin
 * is now resolved server-side and returned as `pinned` on the Overall
 * first page. Proven here against a mocked Admin SDK:
 *  - with no settings doc, the founder fallback uid is pinned;
 *  - a settings/leaderboard presidentUid wins over the fallback;
 *  - page 2 and chapter views carry no pinned entry;
 *  - a missing pinned user doc yields an empty pinned array, never an
 *    error.
 */
import { NextRequest } from 'next/server';

const FOUNDER_UID = 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';

interface FakeState {
  settings: Record<string, any> | null;
  users: Map<string, Record<string, any>>;
  chapters: Map<string, Record<string, any>>;
}

const mockState: FakeState = {
  settings: null,
  users: new Map(),
  chapters: new Map(),
};

function makeDocSnap(id: string, data: Record<string, any> | undefined) {
  return {
    id,
    exists: data !== undefined,
    data: () => data,
  };
}

function makeFakeDb(state: FakeState) {
  const docGet = (collectionName: string, id: string) => {
    if (collectionName === 'settings' && id === 'leaderboard') {
      return Promise.resolve(makeDocSnap(id, state.settings ?? undefined));
    }
    if (collectionName === 'users') {
      return Promise.resolve(makeDocSnap(id, state.users.get(id)));
    }
    if (collectionName === 'chapters') {
      return Promise.resolve(makeDocSnap(id, state.chapters.get(id)));
    }
    return Promise.resolve(makeDocSnap(id, undefined));
  };
  const usersQuery: any = {
    where: () => usersQuery,
    orderBy: () => usersQuery,
    offset: () => usersQuery,
    limit: () => usersQuery,
    get: () => Promise.resolve({ docs: [] }),
    count: () => ({ get: () => Promise.resolve({ data: () => ({ count: 0 }) }) }),
  };
  return {
    collection: (name: string) => ({
      doc: (id: string) => ({ get: () => docGet(name, id) }),
      ...(name === 'users' ? usersQuery : {}),
      where: usersQuery.where,
      orderBy: usersQuery.orderBy,
      offset: usersQuery.offset,
      limit: usersQuery.limit,
      get: usersQuery.get,
      count: usersQuery.count,
    }),
  };
}

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => makeFakeDb(mockState),
}));

jest.mock('@/lib/supa/gamification', () => ({
  listLeaderboardFromSupa: jest.fn(async () => null),
}));

import { GET } from '../route';

function req(url: string) {
  return new NextRequest(url);
}

describe('GET /api/leaderboard-aggregate pinned entry', () => {
  beforeEach(() => {
    mockState.settings = null;
    mockState.users = new Map([
      [FOUNDER_UID, { displayName: 'Muhammad Zubair Mongol', displayRole: 'founder_patron', points: 40, chapterId: 'seds-ist-chapter' }],
      ['some-president', { displayName: 'Pat President', displayRole: 'president_national', points: 12 }],
    ]);
    mockState.chapters = new Map([
      ['seds-ist-chapter', { name: 'IST Chapter' }],
    ]);
  });

  test('pins the founder fallback uid on page 1 when no settings doc exists', async () => {
    const res = await GET(req('http://localhost/api/leaderboard-aggregate?page=1'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(Array.isArray(body.pinned)).toBe(true);
    expect(body.pinned).toHaveLength(1);
    expect(body.pinned[0].id).toBe(FOUNDER_UID);
    expect(body.pinned[0].displayName).toBe('Muhammad Zubair Mongol');
    expect(body.pinned[0].role).toBe('founder_patron');
    expect(body.pinned[0].chapter).toEqual({ name: 'IST Chapter' });
  });

  test('a settings presidentUid wins over the fallback', async () => {
    mockState.settings = { presidentUid: 'some-president' };
    const res = await GET(req('http://localhost/api/leaderboard-aggregate?page=1'));
    const body = await res.json();
    expect(body.pinned).toHaveLength(1);
    expect(body.pinned[0].id).toBe('some-president');
  });

  test('no pinned entry on page 2 or in a chapter view', async () => {
    const resPage2 = await GET(req('http://localhost/api/leaderboard-aggregate?page=2'));
    expect((await resPage2.json()).pinned).toEqual([]);
    const resChapter = await GET(req('http://localhost/api/leaderboard-aggregate?page=1&chapterId=seds-ist-chapter'));
    expect((await resChapter.json()).pinned).toEqual([]);
  });

  test('missing pinned user doc yields an empty array, not an error', async () => {
    mockState.users = new Map();
    const res = await GET(req('http://localhost/api/leaderboard-aggregate?page=1'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.pinned).toEqual([]);
  });
});
