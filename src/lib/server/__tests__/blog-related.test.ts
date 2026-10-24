/**
 * @jest-environment node
 *
 * Defect: the canonical post page hardcoded related=[] even though the
 * related-posts computation existed (in GET /api/blogs/[slug]).
 * getRelatedBlogs in the server data layer mirrors that computation:
 * same category, published, newest first, up to 4, excluding the post
 * itself and soft-deleted docs.
 *
 * Only firebase-admin is mocked; the fetcher runs against FakeFirestore.
 */

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDbHolder.db,
}));

import { createFakeDb, type FakeDb } from '@/lib/server/__tests__/fake-firestore';
import { getRelatedBlogs } from '../blog-server';
import type { EmorationalBlogPost } from '@/lib/blog-types';

/** FakeDb snapshots lack forEach, which getRelatedBlogs calls. */
function withSnapshotForEach(db: FakeDb): FakeDb {
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
  (db as any).collection = (name: string) => wrapQuery(origCollection(name));
  return db;
}

function seed(db: FakeDb) {
  db.seed('blogs', 'main-post', {
    title: 'Main Post',
    status: 'published',
    categoryId: 'cat-a',
    slug: 'main-post',
    publishedAt: new Date('2026-01-15T00:00:00Z'),
  });
  db.seed('blogs', 'rel-new', {
    title: 'Related New',
    status: 'published',
    categoryId: 'cat-a',
    slug: 'rel-new',
    thumbnailUrl: 'https://example.com/new.jpg',
    publishedAt: new Date('2026-03-01T00:00:00Z'),
  });
  db.seed('blogs', 'rel-old', {
    title: 'Related Old',
    status: 'published',
    categoryId: 'cat-a',
    slug: 'rel-old',
    publishedAt: new Date('2026-02-01T00:00:00Z'),
  });
  // Newest in the category, but soft-deleted: must never be related.
  db.seed('blogs', 'ghost-post', {
    title: 'Ghost Post',
    status: 'published',
    deleted: true,
    categoryId: 'cat-a',
    slug: 'ghost-post',
    publishedAt: new Date('2026-04-01T00:00:00Z'),
  });
  db.seed('blogs', 'other-cat', {
    title: 'Other Category',
    status: 'published',
    categoryId: 'cat-b',
    slug: 'other-cat',
    publishedAt: new Date('2026-03-15T00:00:00Z'),
  });
  db.seed('blogs', 'draft-rel', {
    title: 'Draft In Category',
    status: 'draft',
    categoryId: 'cat-a',
    slug: 'draft-rel',
    publishedAt: new Date('2026-03-20T00:00:00Z'),
  });
}

const mainBlog = {
  id: 'main-post',
  categoryId: 'cat-a',
} as unknown as EmorationalBlogPost;

beforeEach(() => {
  jest.clearAllMocks();
  mockDbHolder.db = withSnapshotForEach(createFakeDb());
  seed(mockDbHolder.db as FakeDb);
});

describe('getRelatedBlogs', () => {
  it('returns same-category published posts newest-first, excluding self, deleted and drafts', async () => {
    const related = await getRelatedBlogs(mainBlog);
    expect(related.map((r) => r.id)).toEqual(['rel-new', 'rel-old']);
  });

  it('serializes publishedAt to an ISO string for the client boundary', async () => {
    const related = await getRelatedBlogs(mainBlog);
    expect(related[0]).toEqual({
      id: 'rel-new',
      title: 'Related New',
      slug: 'rel-new',
      thumbnailUrl: 'https://example.com/new.jpg',
      publishedAt: '2026-03-01T00:00:00.000Z',
    });
  });

  it('without a category, returns published posts across categories (still excluding self and deleted)', async () => {
    const related = await getRelatedBlogs({ id: 'main-post', categoryId: '' } as unknown as EmorationalBlogPost);
    const ids = related.map((r) => r.id);
    expect(ids).toContain('other-cat');
    expect(ids).toContain('rel-new');
    expect(ids).not.toContain('main-post');
    expect(ids).not.toContain('ghost-post');
    expect(ids).not.toContain('draft-rel');
  });
});
