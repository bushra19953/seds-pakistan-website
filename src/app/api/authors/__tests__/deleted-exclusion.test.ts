/**
 * @jest-environment node
 *
 * Defect: GET /api/authors enumerated published posts by status alone,
 * so a legacy flag-only delete (status still 'published',
 * deleted: true) was listed in an author's posts and counted toward
 * their postCount, even though the post page itself 404s.
 *
 * Both branches (single author by ?id=, and the all-authors roll-up)
 * must exclude docs with deleted === true.
 *
 * Only firebase-admin is mocked; the handler runs against FakeFirestore.
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

import { NextRequest } from 'next/server';
import { createFakeDb, type FakeDb } from '@/lib/server/__tests__/fake-firestore';
import { GET } from '../route';

/** FakeDb snapshots lack forEach, which the all-authors branch calls. */
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

/** Firestore Timestamps, as the handler calls .toDate() on them. */
function ts(iso: string) {
  return { toDate: () => new Date(iso) };
}

function seed(db: FakeDb) {
  db.seed('users', 'user-doc-1', {
    uid: 'author-1',
    name: 'Author One',
  });
  db.seed('blogs', 'normal-post', {
    title: 'Normal Post',
    content: 'A regular published post',
    authorUid: 'author-1',
    authorName: 'Author One',
    status: 'published',
    slug: 'normal-post',
    publishedAt: ts('2026-01-01T00:00:00Z'),
  });
  db.seed('blogs', 'ghost-post', {
    title: 'Ghost Post',
    content: 'Soft-deleted but still marked published',
    authorUid: 'author-1',
    authorName: 'Author One',
    status: 'published',
    deleted: true,
    slug: 'ghost-post',
    publishedAt: ts('2026-02-01T00:00:00Z'),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDbHolder.db = withSnapshotForEach(createFakeDb());
  seed(mockDbHolder.db as FakeDb);
});

describe('GET /api/authors deleted exclusion', () => {
  it('single-author branch lists only the non-deleted published post', async () => {
    const res = await GET(new NextRequest('http://localhost/api/authors?id=author-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.posts.map((p: any) => p.id)).toEqual(['normal-post']);
    expect(body.postCount).toBe(1);
  });

  it('all-authors branch does not count the deleted post toward postCount', async () => {
    const res = await GET(new NextRequest('http://localhost/api/authors'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const author = body.authors.find((a: any) => a.id === 'author-1');
    expect(author).toBeDefined();
    expect(author.postCount).toBe(1);
  });
});
