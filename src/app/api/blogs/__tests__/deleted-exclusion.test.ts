/**
 * @jest-environment node
 *
 * Defect: the public blog list endpoints filtered on status alone, so a
 * legacy flag-only delete (status still 'published', deleted: true)
 * surfaced in lists while its post page returned 404.
 *
 * GET /api/blogs (primary AND in-memory fallback paths) and
 * GET /api/blogs/latest must exclude docs with deleted === true while
 * keeping every non-deleted published post.
 *
 * Only firebase-admin is mocked; the handlers run against FakeFirestore.
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
import { GET as listGET } from '../route';
import { GET as latestGET } from '../latest/route';

/**
 * FakeDb snapshots expose docs/empty/size but no forEach, which the
 * latest handler calls (real QuerySnapshots have it). Same shim style
 * as the sibling author-field-mapping suite.
 */
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

/**
 * Like withSnapshotForEach, but any query chain that starts with
 * where() throws on get(). The list route's primary query is the only
 * where-chain it runs; its fallback reads the bare collection with
 * limit() only, so this forces the fallback path deterministically.
 */
function withFailingPrimaryQuery(db: FakeDb): FakeDb {
  const wrapQuery = (q: any, poisoned: boolean): any =>
    new Proxy(q, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === 'get' && typeof value === 'function') {
          if (poisoned) {
            return async () => {
              throw new Error('simulated primary query failure');
            };
          }
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
          const nextPoisoned = poisoned || prop === 'where';
          return (...args: any[]) => wrapQuery(value.apply(target, args), nextPoisoned);
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const origCollection = db.collection.bind(db);
  (db as any).collection = (name: string) => wrapQuery(origCollection(name), false);
  return db;
}

/** Firestore Timestamps, as the handlers call .toDate() on them. */
function ts(iso: string) {
  return { toDate: () => new Date(iso) };
}

function seedBlogs(db: FakeDb) {
  db.seed('blogs', 'normal-post', {
    title: 'Normal Post',
    content: 'A regular published post',
    authorUid: 'author-1',
    authorName: 'Author One',
    status: 'published',
    slug: 'normal-post',
    publishedAt: ts('2026-01-01T00:00:00Z'),
  });
  // Legacy flag-only delete: status never flipped, only the flag set.
  // Its publishedAt is the newest, so it would top every list if leaked.
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
  db.seed('blogs', 'draft-post', {
    title: 'Draft Post',
    content: 'Not published',
    authorUid: 'author-1',
    authorName: 'Author One',
    status: 'draft',
    slug: 'draft-post',
    publishedAt: ts('2026-03-01T00:00:00Z'),
  });
}

describe('GET /api/blogs deleted exclusion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDbHolder.db = withSnapshotForEach(createFakeDb());
    seedBlogs(mockDbHolder.db as FakeDb);
  });

  it('primary path excludes a published doc with deleted: true and keeps the normal published doc', async () => {
    const res = await listGET(new NextRequest('http://localhost/api/blogs'));
    expect(res.status).toBe(200);
    const { blogs } = await res.json();
    const ids = blogs.map((b: any) => b.id);
    expect(ids).toContain('normal-post');
    expect(ids).not.toContain('ghost-post');
    expect(ids).not.toContain('draft-post');
  });

  it('fallback path (primary query failure) also excludes deleted and unpublished docs', async () => {
    mockDbHolder.db = withFailingPrimaryQuery(createFakeDb());
    seedBlogs(mockDbHolder.db as FakeDb);
    const res = await listGET(new NextRequest('http://localhost/api/blogs'));
    expect(res.status).toBe(200);
    const { blogs } = await res.json();
    const ids = blogs.map((b: any) => b.id);
    expect(ids).toContain('normal-post');
    expect(ids).not.toContain('ghost-post');
    expect(ids).not.toContain('draft-post');
  });
});

describe('GET /api/blogs/latest deleted exclusion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDbHolder.db = withSnapshotForEach(createFakeDb());
    seedBlogs(mockDbHolder.db as FakeDb);
  });

  it('excludes a published doc with deleted: true and keeps the normal published doc', async () => {
    const res = await latestGET(new NextRequest('http://localhost/api/blogs/latest?limit=3'));
    expect(res.status).toBe(200);
    const { blogs } = await res.json();
    const ids = blogs.map((b: any) => b.id);
    expect(ids).toContain('normal-post');
    expect(ids).not.toContain('ghost-post');
    expect(ids).not.toContain('draft-post');
  });
});
