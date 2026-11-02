/**
 * @jest-environment node
 *
 * Pins for the wave-2 perf cache on GET /api/blogs (the public list):
 * in-process TTL cache + in-flight dedupe + last-good stale shelter
 * (src/lib/server/blog-public-cache.ts, hierarchy + mission-board
 * pattern). The /api/blogs origin read was the Blog LCP driver
 * (wave-1 vitals: ~3.2 s TTFB, uncached at the origin — the route's
 * s-maxage header never helped because Render free has no shared
 * cache in front).
 *
 * Contract pinned here:
 *  - a repeat identical request inside the TTL is served from memory
 *    (the backend query runs ONCE) with the route's existing
 *    Cache-Control header and a byte-identical body;
 *  - distinct query params are distinct entries;
 *  - concurrent identical requests share ONE backend leg;
 *  - a backend failure after a success serves the last-good body
 *    with X-Served-Stale: last-good (never a fake empty);
 *  - a backend failure with NO last-good stays the loud 500;
 *  - an error response is never cached (recovery is visible on the
 *    very next request).
 *
 * The cache is inert under NODE_ENV=test unless the suite opts in
 * (the hierarchy precedent — the pre-existing blog suites call the
 * handler repeatedly with different fixtures and stay untouched);
 * this suite opts in and resets the fresh layer per test.
 */

const mockQueryGet = jest.fn();
let fakeDb: any;

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => fakeDb,
}));

jest.mock('@/lib/server/blog-supa', () => ({
  blogSupaEnabled: () => false,
  blogDateToDate: (v: any) => (v ? new Date(v) : null),
  supaListBlogs: jest.fn(async () => {
    throw new Error('supa disabled in this suite');
  }),
  supaDocData: (row: any) => row?.data ?? row,
  mirrorBlogCreate: jest.fn(async () => undefined),
  setBlogPrimaryFirst: jest.fn(async () => false),
}));

jest.mock('@/lib/auth-middleware', () => ({
  withAuth: (_req: any, fn: any) => fn({ userId: 'admin-1' }),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => true),
}));

import { GET } from '@/app/api/blogs/route';
import {
  __enableBlogPublicCacheForTests,
  __resetBlogPublicCacheForTests,
} from '@/lib/server/blog-public-cache';
import { resetPublicStaleCache } from '@/lib/server/public-stale-cache';

function req(url: string): any {
  return { url, headers: new Headers() };
}

const ts = (iso: string) => ({ toDate: () => new Date(iso) });

function postDoc(id: string, over: Record<string, any> = {}): any {
  return {
    id,
    data: () => ({
      title: `Post ${id}`,
      content: 'body',
      authorId: 'author-1',
      authorName: 'Amina',
      status: 'published',
      createdAt: ts('2026-10-01T00:00:00.000Z'),
      updatedAt: ts('2026-10-02T00:00:00.000Z'),
      publishedAt: ts('2026-10-03T00:00:00.000Z'),
      tags: [],
      slug: `post-${id}`,
      categoryId: 'cat-1',
      ...over,
    }),
  };
}

function snap(docs: any[]): any {
  return { size: docs.length, docs, empty: docs.length === 0 };
}

function makeDb(): any {
  const query: any = {
    where: jest.fn(() => query),
    limit: jest.fn(() => query),
    orderBy: jest.fn(() => query),
    get: (...args: any[]) => mockQueryGet(...args),
  };
  return { collection: jest.fn(() => query) };
}

const LIST_URL = 'http://localhost/api/blogs?limit=12';
const SUCCESS_HEADER = 's-maxage=600, stale-while-revalidate=86400';

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  __enableBlogPublicCacheForTests();
  __resetBlogPublicCacheForTests();
  resetPublicStaleCache();
  fakeDb = makeDb();
  mockQueryGet.mockResolvedValue(snap([postDoc('b1'), postDoc('b2')]));
});

describe('GET /api/blogs cache', () => {
  it('serves a repeat identical request from memory: one backend leg, same body, same header', async () => {
    const first = await GET(req(LIST_URL));
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe(SUCCESS_HEADER);
    const firstBody = await first.json();
    expect(firstBody.blogs).toHaveLength(2);
    expect(mockQueryGet).toHaveBeenCalledTimes(1);

    const second = await GET(req(LIST_URL));
    expect(second.status).toBe(200);
    expect(second.headers.get('Cache-Control')).toBe(SUCCESS_HEADER);
    expect(second.headers.get('X-Served-Stale')).toBeNull();
    expect(await second.json()).toEqual(firstBody);
    expect(mockQueryGet).toHaveBeenCalledTimes(1);
  });

  it('keys entries by query params: a different limit is a different entry', async () => {
    await GET(req(LIST_URL));
    expect(mockQueryGet).toHaveBeenCalledTimes(1);
    const other = await GET(req('http://localhost/api/blogs?limit=5'));
    expect(other.status).toBe(200);
    expect(mockQueryGet).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent identical requests into one backend leg', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mockQueryGet.mockImplementation(async () => {
      await gate;
      return snap([postDoc('b1')]);
    });
    const p1 = GET(req(LIST_URL));
    const p2 = GET(req(LIST_URL));
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(mockQueryGet).toHaveBeenCalledTimes(1);
  });

  it('serves the last-good body with X-Served-Stale when the backend fails after a success', async () => {
    const first = await GET(req(LIST_URL));
    const firstBody = await first.json();
    // Expire the fresh TTL entry only; the last-good shelter stays.
    __resetBlogPublicCacheForTests();
    // Total backend failure: primary query AND its fallback both throw.
    mockQueryGet.mockRejectedValue(new Error('RESOURCE_EXHAUSTED'));
    const res = await GET(req(LIST_URL));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Served-Stale')).toBe('last-good');
    expect(await res.json()).toEqual(firstBody);
  });

  it('stays a loud 500 when the backend fails with no last-good on hand', async () => {
    mockQueryGet.mockRejectedValue(new Error('RESOURCE_EXHAUSTED'));
    const res = await GET(req(LIST_URL));
    expect(res.status).toBe(500);
    expect(res.headers.get('X-Served-Stale')).toBeNull();
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.blogs).toBeUndefined();
  });

  it('never caches an error: recovery is visible on the very next request', async () => {
    mockQueryGet.mockRejectedValue(new Error('RESOURCE_EXHAUSTED'));
    const failed = await GET(req(LIST_URL));
    expect(failed.status).toBe(500);
    mockQueryGet.mockResolvedValue(snap([postDoc('b9')]));
    const recovered = await GET(req(LIST_URL));
    expect(recovered.status).toBe(200);
    const body = await recovered.json();
    expect(body.blogs.map((b: any) => b.id)).toEqual(['b9']);
  });

  it('an invalid limit still 400s and is never cached', async () => {
    const bad = await GET(req('http://localhost/api/blogs?limit=0'));
    expect(bad.status).toBe(400);
    expect(mockQueryGet).not.toHaveBeenCalled();
  });
});
