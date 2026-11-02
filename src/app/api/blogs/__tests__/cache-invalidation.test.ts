/**
 * @jest-environment node
 *
 * Pins for the wave-2 perf cache invalidation contract: every in-app
 * blog write path busts the public read cache (src/lib/server/
 * blog-public-cache.ts) synchronously after its write, so an admin
 * create / update / delete is visible on the public list and post
 * routes on the very next request — the 120 s TTL only bounds
 * out-of-band edits (console / client-SDK writers).
 *
 * Write paths covered:
 *  - POST /api/admin/blogs            (create)
 *  - PUT /api/admin/blogs/[id]        (update)
 *  - DELETE /api/admin/blogs/[id]     (soft delete)
 * (POST /api/blogs shares the list route module; its invalidation
 * rides the same exported hook.)
 */

const counters = { queryGet: 0, docGet: 0, add: 0, update: 0 };
let fakeDb: any;

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => fakeDb,
}));

jest.mock('@/lib/server/blog-supa', () => ({
  blogSupaEnabled: () => false,
  blogDateToDate: (v: any) => (v ? new Date(v) : null),
  supaDocData: (row: any) => row?.data ?? row,
  supaListBlogs: jest.fn(async () => {
    throw new Error('supa disabled in this suite');
  }),
  supaFindBlogBySlug: jest.fn(async () => null),
  supaGetBlog: jest.fn(async () => null),
  mirrorBlogCreate: jest.fn(async () => undefined),
  mirrorBlogUpdate: jest.fn(async () => undefined),
  setBlogPrimaryFirst: jest.fn(async () => false),
  updateBlogPrimaryFirst: jest.fn(async () => false),
}));

jest.mock('@/lib/auth-middleware', () => ({
  withAuth: (_req: any, fn: any) => fn({ userId: 'admin-1' }),
  verifyAuthentication: jest.fn(async () => ({
    authenticated: true,
    user: { userId: 'admin-1' },
  })),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => true),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => new Date() },
  Timestamp: { fromDate: (d: Date) => d },
}));

import { GET as listGET } from '@/app/api/blogs/route';
import { GET as postGET } from '@/app/api/blogs/[slug]/route';
import { POST as adminCreate } from '@/app/api/admin/blogs/route';
import { PUT as adminUpdate, DELETE as adminDelete } from '@/app/api/admin/blogs/[id]/route';
import {
  __enableBlogPublicCacheForTests,
  __resetBlogPublicCacheForTests,
} from '@/lib/server/blog-public-cache';
import { resetPublicStaleCache } from '@/lib/server/public-stale-cache';

function req(url: string, body?: unknown): any {
  return {
    url,
    headers: new Headers(),
    json: async () => body ?? {},
  };
}

const ts = (iso: string) => ({ toDate: () => new Date(iso) });

function postData(over: Record<string, any> = {}): Record<string, any> {
  return {
    title: 'Hello World',
    content: 'body',
    authorId: 'admin-1',
    authorUid: 'admin-1',
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
      if (clauses.some(([f]) => f === 'slug')) {
        return snap([{ id: 'post-1', data: () => postData() }]);
      }
      return snap([
        { id: 'post-1', data: () => postData() },
        { id: 'post-2', data: () => postData({ title: 'Second', slug: 'second' }) },
      ]);
    },
  };
}

function makeDb(): any {
  return {
    collection: jest.fn(() => ({
      ...makeQuery([]),
      add: async () => {
        counters.add += 1;
        return { id: 'new-1' };
      },
      doc: (id: string) => ({
        get: async () => {
          counters.docGet += 1;
          return { exists: true, id, data: () => postData() };
        },
        update: async () => {
          counters.update += 1;
        },
      }),
    })),
  };
}

const LIST_URL = 'http://localhost/api/blogs?limit=12';
const POST_URL = 'http://localhost/api/blogs/hello-world';

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
  counters.add = 0;
  counters.update = 0;
  fakeDb = makeDb();
});

describe('blog write paths bust the public cache', () => {
  it('POST /api/admin/blogs invalidates the cached list', async () => {
    await listGET(req(LIST_URL));
    await listGET(req(LIST_URL));
    expect(counters.queryGet).toBe(1); // second read served from cache

    const created = await adminCreate(
      req('http://localhost/api/admin/blogs', {
        title: 'Fresh Post',
        body: 'fresh content',
        status: 'published',
      })
    );
    expect(created.status).toBe(201);
    expect(counters.add).toBe(1);

    await listGET(req(LIST_URL));
    expect(counters.queryGet).toBe(2); // invalidated: backend re-read
  });

  it('PUT /api/admin/blogs/[id] invalidates the cached post', async () => {
    const getPost = () =>
      postGET(req(POST_URL), { params: Promise.resolve({ slug: 'hello-world' }) });
    await getPost();
    const afterPrime = counters.queryGet;
    await getPost();
    expect(counters.queryGet).toBe(afterPrime); // cached

    const updated = await adminUpdate(
      req('http://localhost/api/admin/blogs/post-1', {
        title: 'Hello World (edited)',
        status: 'published',
      }),
      { params: Promise.resolve({ id: 'post-1' }) }
    );
    expect(updated.status).toBe(200);
    expect(counters.update).toBe(1);

    await getPost();
    expect(counters.queryGet).toBeGreaterThan(afterPrime); // invalidated
  });

  it('DELETE /api/admin/blogs/[id] invalidates the cached list', async () => {
    await listGET(req(LIST_URL));
    await listGET(req(LIST_URL));
    expect(counters.queryGet).toBe(1);

    const deleted = await adminDelete(req('http://localhost/api/admin/blogs/post-1'), {
      params: Promise.resolve({ id: 'post-1' }),
    });
    expect(deleted.status).toBe(200);
    expect(counters.update).toBe(1);

    await listGET(req(LIST_URL));
    expect(counters.queryGet).toBe(2);
  });
});
