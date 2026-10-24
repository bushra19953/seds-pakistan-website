/**
 * @jest-environment node
 *
 * Slug backfill for PUT /api/admin/blogs/[id].
 *
 * The admin form writes through the client SDK, but this route is the
 * server-side update path for every other writer, and it used to spread
 * the request body verbatim: a save carrying an empty slug persisted the
 * empty slug, and a slugless record stayed slugless (and therefore
 * unreachable publicly) forever. The handler now resolves the slug the
 * same way every other write path does (src/lib/blog-slug.ts):
 * provided slug wins, stored slug is kept, otherwise derive from the
 * effective title.
 *
 * Pattern follows route-parity.test.ts in this directory: the REAL
 * permissions resolver runs against FakeFirestore; only auth and
 * firebase-admin are mocked.
 */

const HOLDER = 'holder-1';
const CUSTOM = 'custom_verify_design_aide';

const state = {
  authContext: null as any,
};

function authContextFor(uid: string) {
  return {
    user: { uid },
    userId: uid,
    email: 'holder@example.test',
    displayName: 'Holder One',
    emailVerified: true,
    role: 'member',
  };
}

jest.mock('@/lib/auth-middleware', () => ({
  withAuth: jest.fn(async (_req: unknown, handler: any) => handler(state.authContext)),
}));

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
import { PUT } from '../route';

function seedHolderWithBlog(db: FakeDb, blogData: Record<string, unknown>) {
  db.seed('roles', HOLDER, {
    role: 'member',
    additionalRoles: [CUSTOM],
  });
  db.seed('roleDefinitions', CUSTOM, {
    isCustom: true,
    permissions: ['canManageBlogs'],
  });
  db.seed('blogs', 'blog-1', blogData);
}

function req(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/admin/blogs/blog-1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({ id: 'blog-1' }) };

function storedBlog(db: FakeDb) {
  return db.read('blogs', 'blog-1');
}

beforeEach(() => {
  jest.clearAllMocks();
  state.authContext = authContextFor(HOLDER);
  mockDbHolder.db = createFakeDb();
});

describe('PUT /api/admin/blogs/[id] slug resolution', () => {
  it('publishing a slugless record (slug: null, as the old form create stored it) fills the slug from the title', async () => {
    const db = mockDbHolder.db as FakeDb;
    seedHolderWithBlog(db, {
      title: 'Guide Recheck Draft 2026-10-24',
      authorUid: 'someone-else',
      status: 'draft',
      slug: null,
    });

    // Exactly the payload shape the admin edit form sends on publish.
    const res = await PUT(
      req({ title: 'Guide Recheck Draft 2026-10-24', slug: '', status: 'published' }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(storedBlog(db)?.slug).toBe('guide-recheck-draft-2026-10-24');
    expect(storedBlog(db)?.status).toBe('published');
  });

  it('a record with no slug field at all derives one on save, even without a slug key in the body', async () => {
    const db = mockDbHolder.db as FakeDb;
    seedHolderWithBlog(db, {
      title: 'Legacy Post Title',
      authorUid: 'someone-else',
      status: 'draft',
    });

    const res = await PUT(req({ status: 'published' }), ctx);

    expect(res.status).toBe(200);
    expect(storedBlog(db)?.slug).toBe('legacy-post-title');
  });

  it('derives from the title being saved when a slugless record is renamed', async () => {
    const db = mockDbHolder.db as FakeDb;
    seedHolderWithBlog(db, {
      title: 'Old Title',
      authorUid: 'someone-else',
      status: 'draft',
      slug: '',
    });

    const res = await PUT(req({ title: 'Renamed Post', slug: '' }), ctx);

    expect(res.status).toBe(200);
    expect(storedBlog(db)?.slug).toBe('renamed-post');
  });

  it('an empty incoming slug never strips the slug a record already has', async () => {
    const db = mockDbHolder.db as FakeDb;
    seedHolderWithBlog(db, {
      title: 'Renamed Title',
      authorUid: 'someone-else',
      status: 'published',
      slug: 'existing-slug',
    });

    const res = await PUT(req({ title: 'Renamed Title', slug: '' }), ctx);

    expect(res.status).toBe(200);
    expect(storedBlog(db)?.slug).toBe('existing-slug');
  });

  it('a save without a slug key leaves an existing slug untouched', async () => {
    const db = mockDbHolder.db as FakeDb;
    seedHolderWithBlog(db, {
      title: 'Some Title',
      authorUid: 'someone-else',
      status: 'draft',
      slug: 'existing-slug',
    });

    const res = await PUT(req({ status: 'published' }), ctx);

    expect(res.status).toBe(200);
    expect(storedBlog(db)?.slug).toBe('existing-slug');
  });

  it('an explicit slug in the body is stored exactly', async () => {
    const db = mockDbHolder.db as FakeDb;
    seedHolderWithBlog(db, {
      title: 'Some Title',
      authorUid: 'someone-else',
      status: 'draft',
      slug: 'old-slug',
    });

    const res = await PUT(req({ slug: 'brand-new-slug' }), ctx);

    expect(res.status).toBe(200);
    expect(storedBlog(db)?.slug).toBe('brand-new-slug');
  });
});
