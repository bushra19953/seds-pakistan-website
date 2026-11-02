/**
 * @jest-environment node
 *
 * Pins for the wave-2 perf cache on GET /api/blogs/[slug] (the public
 * post read — blog post pages were the worst LCP surface in the
 * wave-1 vitals baseline): in-process TTL cache + in-flight dedupe +
 * last-good stale shelter (src/lib/server/blog-public-cache.ts).
 *
 * Contract pinned here:
 *  - a repeat fetch of the same slug inside the TTL costs ONE
 *    backend round (slug query + related), body and Cache-Control
 *    header identical;
 *  - distinct slugs are distinct entries;
 *  - a backend failure after a success serves the last-good body
 *    with X-Served-Stale: last-good;
 *  - a backend failure with NO last-good stays the loud 500;
 *  - a definitive 404 (unknown slug, or a post that is no longer
 *    public) is NEVER cached and FORGETS the last-good entry — an
 *    unpublished post must not be resurrected by a later failure.
 *
 * The cache is inert under NODE_ENV=test unless the suite opts in
 * (hierarchy precedent); this suite opts in.
 */

const counters = { queryGet: 0, docGet: 0 };
let queryHandler: (clauses: any[][]) => any;
let docHandler: (id: string) => any;
let fakeDb: any;

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => fakeDb,
}));

jest.mock('@/lib/server/blog-supa', () => ({
  blogSupaEnabled: () => false,
  blogDateToDate: (v: any) => (v ? new Date(v) : null),
  supaDocData: (row: any) => row?.data ?? row,
  supaFindBlogBySlug: jest.fn(async () => null),
  supaGetBlog: jest.fn(async () => null),
  supaListBlogs: jest.fn(async () => []),
}));

import { GET } from '@/app/api/blogs/[slug]/route';
import {
  __enableBlogPublicCacheForTests,
  __resetBlogPublicCacheForTests,
} from '@/lib/server/blog-public-cache';
import { resetPublicStaleCache } from '@/lib/server/public-stale-cache';

function req(url: string): any {
  return { url, headers: new Headers() };
}

function getPost(slug: string): Promise<any> {
  return GET(req(`http://localhost/api/blogs/${slug}`), {
    params: Promise.resolve({ slug }),
  });
}

const ts = (iso: string) => ({ toDate: () => new Date(iso) });

function postData(over: Record<string, any> = {}): Record<string, any> {
  return {
    title: 'Hello World',
    content: 'body',
    authorId: 'author-1',
    authorName: 'Amina',
    status: 'published',
    createdAt: ts('2026-10-01T00:00:00.000Z'),
    updatedAt: ts('2026-10-02T00:00:00.000Z'),
    publishedAt: ts('2026-10-03T00:00:00.000Z'),
    tags: [],
    slug: 'hello-world',
    categoryId: 'cat-1',
    ...over,
  };
}

function snap(docs: any[]): any {
  return {
    size: docs.length,
    docs,
    empty: docs.length === 0,
    forEach: (fn: (d: any) => void) => docs.forEach(fn),
  };
}

function makeQuery(clauses: any[][]): any {
  return {
    where: (f: string, op: string, v: any) => makeQuery([...clauses, [f, op, v]]),
    orderBy: () => makeQuery(clauses),
    limit: () => makeQuery(clauses),
    get: async () => {
      counters.queryGet += 1;
      return queryHandler(clauses);
    },
  };
}

function makeDb(): any {
  return {
    collection: jest.fn(() => ({
      ...makeQuery([]),
      doc: (id: string) => ({
        get: async () => {
          counters.docGet += 1;
          return docHandler(id);
        },
      }),
    })),
  };
}

const isSlugClause = (clauses: any[][]) =>
  clauses.some(([f, , v]) => f === 'slug' && v === 'hello-world');

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  __enableBlogPublicCacheForTests();
  __resetBlogPublicCacheForTests();
  resetPublicStaleCache();
  counters.queryGet = 0;
  counters.docGet = 0;
  fakeDb = makeDb();
  // Default world: the slug query finds the published post; the
  // related query finds one other published post; no doc-id lookups.
  queryHandler = (clauses: any[][]) => {
    if (isSlugClause(clauses)) {
      return snap([{ id: 'post-1', data: () => postData() }]);
    }
    return snap([
      { id: 'post-2', data: () => postData({ title: 'Related', slug: 'related' }) },
    ]);
  };
  docHandler = () => ({ exists: false, id: 'nope', data: () => ({}) });
});

describe('GET /api/blogs/[slug] cache', () => {
  it('serves a repeat fetch from memory: one backend round, same body and header', async () => {
    const first = await getPost('hello-world');
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe(
      's-maxage=600, stale-while-revalidate=86400'
    );
    const firstBody = await first.json();
    expect(firstBody.blog.slug).toBe('hello-world');
    const afterFirst = counters.queryGet;
    expect(afterFirst).toBeGreaterThan(0);

    const second = await getPost('hello-world');
    expect(second.status).toBe(200);
    expect(second.headers.get('X-Served-Stale')).toBeNull();
    expect(await second.json()).toEqual(firstBody);
    expect(counters.queryGet).toBe(afterFirst);
  });

  it('keys entries by slug: a different slug is a different entry', async () => {
    queryHandler = (clauses: any[][]) => {
      const slugClause = clauses.find(([f]) => f === 'slug');
      if (slugClause) {
        const slug = slugClause[2] as string;
        return snap([
          { id: `id-${slug}`, data: () => postData({ slug, title: slug }) },
        ]);
      }
      return snap([]);
    };
    const a = await getPost('hello-world');
    expect(a.status).toBe(200);
    const before = counters.queryGet;
    const b = await getPost('another-post');
    expect(b.status).toBe(200);
    expect((await b.json()).blog.slug).toBe('another-post');
    expect(counters.queryGet).toBeGreaterThan(before);
  });

  it('serves the last-good body with X-Served-Stale when the backend fails after a success', async () => {
    const first = await getPost('hello-world');
    const firstBody = await first.json();
    __resetBlogPublicCacheForTests(); // expire fresh entry, keep last-good
    // Backend down: slug query finds nothing (its errors are swallowed
    // into an empty snapshot by the route), the doc-id read throws.
    queryHandler = () => snap([]);
    docHandler = () => {
      throw new Error('RESOURCE_EXHAUSTED');
    };
    const res = await getPost('hello-world');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Served-Stale')).toBe('last-good');
    expect(await res.json()).toEqual(firstBody);
  });

  it('stays a loud 500 when the backend fails with no last-good on hand', async () => {
    queryHandler = () => snap([]);
    docHandler = () => {
      throw new Error('RESOURCE_EXHAUSTED');
    };
    const res = await getPost('hello-world');
    expect(res.status).toBe(500);
    expect(res.headers.get('X-Served-Stale')).toBeNull();
    expect((await res.json()).error).toBeTruthy();
  });

  it('never caches a 404: an unknown slug re-consults the backend', async () => {
    queryHandler = () => snap([]);
    docHandler = () => ({ exists: false, id: 'ghost', data: () => ({}) });
    const first = await getPost('ghost');
    expect(first.status).toBe(404);
    const docGetsAfterFirst = counters.docGet;
    const second = await getPost('ghost');
    expect(second.status).toBe(404);
    expect(counters.docGet).toBeGreaterThan(docGetsAfterFirst);
  });

  it('a definitive 404 forgets the last-good: an unpublished post is not resurrected by a later failure', async () => {
    const first = await getPost('hello-world');
    expect(first.status).toBe(200);
    __resetBlogPublicCacheForTests(); // expire fresh entry, keep last-good
    // The post is unpublished: the slug query now returns a draft.
    queryHandler = (clauses: any[][]) => {
      if (isSlugClause(clauses)) {
        return snap([{ id: 'post-1', data: () => postData({ status: 'draft' }) }]);
      }
      return snap([]);
    };
    const unpub = await getPost('hello-world');
    expect(unpub.status).toBe(404);
    // Backend now fails hard — the route must NOT serve the stale 200.
    queryHandler = () => snap([]);
    docHandler = () => {
      throw new Error('RESOURCE_EXHAUSTED');
    };
    const res = await getPost('hello-world');
    expect(res.status).toBe(500);
    expect(res.headers.get('X-Served-Stale')).toBeNull();
  });
});
