/**
 * @jest-environment node
 *
 * Issue 8 read-side mapping tests for the public blog APIs.
 *
 * The list, slug, and latest responses synthesize `authorUid` from the
 * stored document. UI writers (admin console, public page) store the
 * author as `authorUid`; the REST create route stores `authorId`. Both
 * spellings must surface as the real author UID. Before the fix only
 * `authorId` was read, so every UI-created post came back with an empty
 * authorUid and the ?author= filter matched nothing for those posts.
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
import { GET as slugGET } from '../[slug]/route';
import { GET as latestGET } from '../latest/route';

/**
 * FakeDb snapshots expose docs/empty/size but no forEach, which the slug
 * and latest handlers call (real QuerySnapshots have it). Wrap query
 * objects so get() augments the snapshot — same shim style as the
 * withAdd wrapper in the sibling route-parity suite.
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

function seedPublished(db: FakeDb) {
  db.seed('blogs', 'ui-post', {
    title: 'UI Post',
    content: 'Body from the UI writer',
    authorUid: 'ui-author',
    authorName: 'UI Author',
    status: 'published',
    slug: 'ui-post',
  });
  db.seed('blogs', 'rest-post', {
    title: 'REST Post',
    content: 'Body from the REST writer',
    authorId: 'rest-author',
    authorName: 'REST Author',
    status: 'published',
    slug: 'rest-post',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDbHolder.db = withSnapshotForEach(createFakeDb());
  seedPublished(mockDbHolder.db as FakeDb);
});

describe('GET /api/blogs authorUid mapping', () => {
  it('returns the real authorUid for a UI-created post (authorUid only)', async () => {
    const res = await listGET(new NextRequest('http://localhost/api/blogs'));
    expect(res.status).toBe(200);
    const { blogs } = await res.json();
    const ui = blogs.find((b: any) => b.id === 'ui-post');
    expect(ui).toBeDefined();
    expect(ui.authorUid).toBe('ui-author');
  });

  it('returns the real authorUid for a legacy REST-created post (authorId only)', async () => {
    const res = await listGET(new NextRequest('http://localhost/api/blogs'));
    expect(res.status).toBe(200);
    const { blogs } = await res.json();
    const rest = blogs.find((b: any) => b.id === 'rest-post');
    expect(rest).toBeDefined();
    expect(rest.authorUid).toBe('rest-author');
  });

  it('the ?author= filter matches UI-created posts by their authorUid', async () => {
    const res = await listGET(new NextRequest('http://localhost/api/blogs?author=ui-author'));
    expect(res.status).toBe(200);
    const { blogs } = await res.json();
    expect(blogs.map((b: any) => b.id)).toEqual(['ui-post']);
  });
});

describe('GET /api/blogs/[slug] authorUid mapping', () => {
  it('returns the real authorUid for a UI-created post (authorUid only)', async () => {
    const res = await slugGET(new NextRequest('http://localhost/api/blogs/ui-post'), {
      params: Promise.resolve({ slug: 'ui-post' }),
    });
    expect(res.status).toBe(200);
    const { blog } = await res.json();
    expect(blog.authorUid).toBe('ui-author');
  });

  it('returns the real authorUid for a legacy REST-created post (authorId only)', async () => {
    const res = await slugGET(new NextRequest('http://localhost/api/blogs/rest-post'), {
      params: Promise.resolve({ slug: 'rest-post' }),
    });
    expect(res.status).toBe(200);
    const { blog } = await res.json();
    expect(blog.authorUid).toBe('rest-author');
  });
});

describe('GET /api/blogs/latest authorUid mapping', () => {
  it('returns the real authorUid for both stored spellings', async () => {
    const res = await latestGET(new NextRequest('http://localhost/api/blogs/latest'));
    expect(res.status).toBe(200);
    const { blogs } = await res.json();
    const byId = new Map(blogs.map((b: any) => [b.id, b.authorUid]));
    expect(byId.get('ui-post')).toBe('ui-author');
    expect(byId.get('rest-post')).toBe('rest-author');
  });
});
