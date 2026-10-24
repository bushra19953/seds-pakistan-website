/**
 * @jest-environment node
 *
 * Issue 11 read-side guard tests for GET /api/blogs/[slug].
 *
 * The route is unauthenticated, so it may only serve a post that is
 * BOTH status 'published' AND not soft-deleted. Every other state —
 * draft, archived, published-but-deleted — must behave as not found,
 * on both lookup paths (by slug and by document ID fallback).
 *
 * Only firebase-admin is mocked; the real handler runs against an
 * in-memory FakeFirestore.
 */

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDbHolder.db,
}));

import { NextRequest } from 'next/server';
import { createFakeDb, type FakeDb } from '@/lib/server/__tests__/fake-firestore';
import { GET } from '../route';

/**
 * FakeDb query snapshots lack forEach(), which the route's related-posts
 * code calls. Wrap the db so every query snapshot gains forEach over its
 * docs (chained query objects returned by where/orderBy/limit are
 * re-wrapped as they are produced).
 */
function withSnapshotForEach<T extends object>(obj: T): T {
  return new Proxy(obj, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: any[]) => {
        const result = value.apply(target, args);
        if (result && typeof result.then === 'function') {
          return result.then((snap: any) => {
            if (snap && Array.isArray(snap.docs) && typeof snap.forEach !== 'function') {
              snap.forEach = (cb: any) => snap.docs.forEach(cb);
            }
            return snap;
          });
        }
        if (result && typeof result === 'object' && typeof result.get === 'function') {
          return withSnapshotForEach(result);
        }
        return result;
      };
    },
  });
}

function shimDb(db: FakeDb): FakeDb {
  const orig = db.collection.bind(db);
  (db as any).collection = (name: string) => withSnapshotForEach(orig(name));
  return db;
}

function seed(db: FakeDb) {
  db.seed('blogs', 'pub-1', {
    title: 'Public Post',
    slug: 'public-post',
    status: 'published',
    content: 'Public body',
    authorId: 'author-1',
  });
  db.seed('blogs', 'draft-1', {
    title: 'Draft Post',
    slug: 'draft-post',
    status: 'draft',
    content: 'Draft body',
    authorId: 'author-1',
  });
  db.seed('blogs', 'del-1', {
    title: 'Deleted Post',
    slug: 'deleted-post',
    status: 'published',
    deleted: true,
    deletedAt: new Date(),
    content: 'Deleted body',
    authorId: 'author-1',
  });
  db.seed('blogs', 'arch-1', {
    title: 'Archived Post',
    slug: 'archived-post',
    status: 'archived',
    deleted: true,
    deletedAt: new Date(),
    content: 'Archived body',
    authorId: 'author-1',
  });
  // Reachable only through the document-ID fallback: no doc carries
  // slug 'by-id-1' / 'by-id-2'.
  db.seed('blogs', 'by-id-1', {
    title: 'By Id Public',
    slug: 'some-other-slug',
    status: 'published',
    content: 'By id body',
    authorId: 'author-1',
  });
  db.seed('blogs', 'by-id-2', {
    title: 'By Id Deleted',
    slug: 'another-slug',
    status: 'published',
    deleted: true,
    deletedAt: new Date(),
    content: 'By id deleted body',
    authorId: 'author-1',
  });
}

function req(slug: string) {
  return new NextRequest(`http://localhost/api/blogs/${slug}`, { method: 'GET' });
}

const ctxFor = (slug: string) => ({ params: Promise.resolve({ slug }) });

beforeEach(() => {
  jest.clearAllMocks();
  const db = shimDb(createFakeDb());
  seed(db);
  mockDbHolder.db = db;
});

describe('GET /api/blogs/[slug] public guard (Issue 11)', () => {
  it('serves a published, non-deleted post by slug with 200', async () => {
    const res = await GET(req('public-post'), ctxFor('public-post'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.blog.slug).toBe('public-post');
    expect(body.blog.title).toBe('Public Post');
  });

  it('404s a draft post by slug', async () => {
    const res = await GET(req('draft-post'), ctxFor('draft-post'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Blog post not found' });
  });

  it('404s a published-but-deleted post by slug', async () => {
    const res = await GET(req('deleted-post'), ctxFor('deleted-post'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Blog post not found' });
  });

  it('404s an archived post by slug', async () => {
    const res = await GET(req('archived-post'), ctxFor('archived-post'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Blog post not found' });
  });

  it('serves a published, non-deleted post via the document-ID fallback', async () => {
    const res = await GET(req('by-id-1'), ctxFor('by-id-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.blog.id).toBe('by-id-1');
  });

  it('404s a deleted post via the document-ID fallback', async () => {
    const res = await GET(req('by-id-2'), ctxFor('by-id-2'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Blog post not found' });
  });
});
