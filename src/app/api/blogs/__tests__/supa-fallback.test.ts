/**
 * @jest-environment node
 *
 * HOTFIX (fix/supa-read-fallback): the blog surface's Supabase reads
 * filter on data fields through the adapter, whose PostgREST
 * translation silently matches nothing in production — the routes
 * received an EMPTY list (not an error) and served it, so /blog
 * showed "No blog posts found" and every post page 404'd while
 * Firestore holds 5 published posts. The routes already fell back
 * on adapter ERRORS; they must also fall back on EMPTY results.
 *
 *  - GET /api/blogs, Supa empty   -> Firestore rows served (fails
 *    on the unmodified tree: the route returns { blogs: [] }).
 *  - GET /api/blogs, Supa rows    -> served as-is (guard).
 *  - GET /api/blogs/[slug], Supa miss -> Firestore post served
 *    (fails unmodified: 404).
 *  - getRelatedBlogs, Supa empty  -> Firestore related served
 *    (fails unmodified: []).
 */

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDbHolder.db,
  admin: {
    firestore: {
      FieldValue: { serverTimestamp: () => 'ts', delete: () => 'del' },
    },
  },
}));

const adapterHolder: { rows: any[] } = { rows: [] };
jest.mock('@/lib/supa', () => {
  const actual = jest.requireActual('@/lib/supa');
  return {
    ...actual,
    useSupa: (surface: string) => surface === 'blog',
    getSupaClient: () => ({}),
    getSupaAdapter: () => ({
      listDocs: jest.fn(async () => adapterHolder.rows),
      getDoc: jest.fn(async () => null),
      countDocs: jest.fn(async () => adapterHolder.rows.length),
      setDoc: jest.fn(async () => ({})),
      updateDoc: jest.fn(async () => ({})),
      deleteDoc: jest.fn(async () => undefined),
    }),
  };
});

import { NextRequest } from 'next/server';
import { createFakeDb } from '@/lib/server/__tests__/fake-firestore';
import { GET as listGET } from '../route';
import { GET as slugGET } from '../[slug]/route';
import { getRelatedBlogs } from '@/lib/server/blog-server';

/**
 * FakeDb snapshots expose docs/empty/size but no forEach, which the
 * slug route and blog-server call (real QuerySnapshots have it).
 * Same shim as the sibling deleted-exclusion suite.
 */
function withSnapshotForEach(db: any): any {
  const wrapQuery = (q: any): any =>
    new Proxy(q, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === 'get' && typeof value === 'function') {
          return async (...args: any[]) => {
            const snap = await value.apply(target, args);
            if (snap && Array.isArray(snap.docs) && typeof snap.forEach !== 'function') {
              snap.forEach = (cb: (doc: any) => void) => snap.docs.forEach(cb);
            }
            return snap;
          };
        }
        if (
          (prop === 'where' || prop === 'orderBy' || prop === 'limit' || prop === 'startAfter') &&
          typeof value === 'function'
        ) {
          return (...args: any[]) => wrapQuery(value.apply(target, args));
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const origCollection = db.collection.bind(db);
  db.collection = (name: string) => wrapQuery(origCollection(name));
  return db;
}

function seedFirestore() {
  const db = withSnapshotForEach(createFakeDb());
  db.seed('blogs', 'fs-blog-1', {
    title: 'Firestore Post One',
    content: 'first post body',
    slug: 'fs-post-one',
    status: 'published',
    categoryId: 'general',
    authorUid: 'author-1',
    authorName: 'Author One',
    summary: 'one',
    publishedAt: null,
    createdAt: null,
    updatedAt: null,
  });
  db.seed('blogs', 'fs-blog-2', {
    title: 'Firestore Post Two',
    content: 'second post body',
    slug: 'fs-post-two',
    status: 'published',
    categoryId: 'general',
    authorUid: 'author-1',
    authorName: 'Author One',
    summary: 'two',
    publishedAt: null,
    createdAt: null,
    updatedAt: null,
  });
  db.seed('blogs', 'fs-blog-draft', {
    title: 'Firestore Draft',
    content: 'draft body',
    slug: 'fs-draft',
    status: 'draft',
    categoryId: 'general',
    authorUid: 'author-1',
    authorName: 'Author One',
    summary: '',
    publishedAt: null,
    createdAt: null,
    updatedAt: null,
  });
  return db;
}

beforeEach(() => {
  mockDbHolder.db = seedFirestore();
  adapterHolder.rows = [];
});

afterEach(() => {
  mockDbHolder.db = null;
  adapterHolder.rows = [];
});

describe('blog Supabase-empty fallback (hotfix)', () => {
  it('GET /api/blogs: Supa empty -> Firestore published posts served', async () => {
    const res = await listGET(new NextRequest('http://localhost/api/blogs'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.blogs.map((b: any) => b.id).sort();
    expect(ids).toEqual(['fs-blog-1', 'fs-blog-2']);
  });

  it('GET /api/blogs: Supa rows present -> served as-is, Firestore not leaked (guard)', async () => {
    adapterHolder.rows = [
      {
        id: 'supa-blog-1',
        title: 'Supa Post',
        content: 'supa body',
        slug: 'supa-post',
        status: 'published',
        categoryId: 'general',
        authorUid: 'author-9',
        authorName: 'Supa Author',
        summary: 's',
        publishedAt: '2026-10-01T00:00:00.000Z',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
    ];
    const res = await listGET(new NextRequest('http://localhost/api/blogs'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.blogs.map((b: any) => b.id)).toEqual(['supa-blog-1']);
  });

  it('GET /api/blogs/[slug]: Supa miss -> Firestore post served instead of 404', async () => {
    const res = await slugGET(new NextRequest('http://localhost/api/blogs/fs-post-one'), {
      params: Promise.resolve({ slug: 'fs-post-one' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.blog.id).toBe('fs-blog-1');
    expect(body.blog.title).toBe('Firestore Post One');
  });

  it('getRelatedBlogs: Supa empty -> Firestore related posts served', async () => {
    const related = await getRelatedBlogs({
      id: 'fs-blog-1',
      categoryId: 'general',
    } as any);
    expect(related.map((r: any) => r.id)).toEqual(['fs-blog-2']);
  });
});
