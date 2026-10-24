/**
 * @jest-environment node
 *
 * Integration add-on (wave-1): GET /api/authors read the blog author only
 * via the legacy `authorId` spelling. UI writers (admin console, public
 * page) store `authorUid`, so UI-created posts were missing from the
 * single-author listing and their authors were undercounted (or absent)
 * in the all-authors listing. Same field-dialect defect the blog-rest
 * branch fixed in the public blog APIs; fixed here the same way: accept
 * `authorUid`, fall back to legacy `authorId`.
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

/**
 * FakeDb snapshots expose docs/empty/size but no forEach, which the
 * all-authors branch calls (real QuerySnapshots have it). Same shim
 * style as the sibling blog author-field-mapping suite.
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

function seed(db: FakeDb) {
  db.seed('users', 'user-doc-1', {
    uid: 'author-1',
    name: 'Test Author',
    bio: 'Bio',
    role: 'contributor',
  });
  // UI-created post: author stored as authorUid only.
  db.seed('blogs', 'ui-post', {
    title: 'UI Post',
    content: 'Body from the UI writer',
    authorUid: 'author-1',
    authorName: 'Test Author',
    status: 'published',
    slug: 'ui-post',
  });
  // Legacy REST-created post: author stored as authorId only.
  db.seed('blogs', 'rest-post', {
    title: 'REST Post',
    content: 'Body from the REST writer',
    authorId: 'author-1',
    authorName: 'Test Author',
    status: 'published',
    slug: 'rest-post',
  });
  // Draft by the same author must never be listed.
  db.seed('blogs', 'draft-post', {
    title: 'Draft Post',
    content: 'Unpublished',
    authorUid: 'author-1',
    authorName: 'Test Author',
    status: 'draft',
    slug: 'draft-post',
  });
  // Another author's published post.
  db.seed('blogs', 'other-post', {
    title: 'Other Post',
    content: 'Someone else',
    authorUid: 'someone-else',
    authorName: 'Other Author',
    status: 'published',
    slug: 'other-post',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDbHolder.db = withSnapshotForEach(createFakeDb());
  seed(mockDbHolder.db as FakeDb);
});

describe('GET /api/authors?id= (single author)', () => {
  it('lists both the UI-created (authorUid) and legacy (authorId) posts', async () => {
    const res = await GET(new NextRequest('http://localhost/api/authors?id=author-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.author.id).toBe('user-doc-1');
    expect(body.postCount).toBe(2);
    expect(body.posts.map((p: any) => p.id).sort()).toEqual(['rest-post', 'ui-post']);
  });

  it('still 404s for an unknown author id', async () => {
    const res = await GET(new NextRequest('http://localhost/api/authors?id=nobody'));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/authors (all authors)', () => {
  it('counts UI-created posts toward their author', async () => {
    const res = await GET(new NextRequest('http://localhost/api/authors'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const mine = body.authors.find((a: any) => a.id === 'author-1');
    expect(mine).toBeDefined();
    expect(mine.postCount).toBe(2);
    const other = body.authors.find((a: any) => a.id === 'someone-else');
    expect(other).toBeDefined();
    expect(other.postCount).toBe(1);
  });
});
