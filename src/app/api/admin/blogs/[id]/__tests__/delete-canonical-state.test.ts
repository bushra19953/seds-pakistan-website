/**
 * @jest-environment node
 *
 * Issue 11: the REST DELETE is the single canonical blog delete. These
 * tests pin the exact stored state it produces, because the edit page
 * now routes through this handler instead of writing the flag itself:
 * a soft delete is { deleted: true, deletedAt: <set>, status:
 * 'archived' } — flag AND a non-published terminal status together.
 *
 * Same mocking pattern as the sibling route-parity suite: only auth
 * (withAuth) and firebase-admin are mocked; the real permissions
 * resolver runs against FakeFirestore.
 */

const HOLDER = 'holder-1';
const CUSTOM = 'custom_verify_design_aide';

const state = {
  authContext: null as any,
};

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
import { DELETE } from '../route';

function seedHolderWithBlog(db: FakeDb) {
  db.seed('roles', HOLDER, {
    role: 'member',
    additionalRoles: [CUSTOM],
  });
  db.seed('roleDefinitions', CUSTOM, {
    isCustom: true,
    permissions: ['canManageBlogs'],
  });
  db.seed('blogs', 'blog-1', {
    title: 'Post',
    slug: 'post',
    authorId: 'someone-else',
    status: 'published',
    content: 'Body',
  });
}

function req() {
  return new NextRequest('http://localhost/api/admin/blogs/blog-1', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
}

const ctx = { params: Promise.resolve({ id: 'blog-1' }) };

beforeEach(() => {
  jest.clearAllMocks();
  state.authContext = {
    user: { uid: HOLDER },
    userId: HOLDER,
    email: 'holder@example.test',
    displayName: 'Holder One',
    emailVerified: true,
    role: 'member',
  };
  mockDbHolder.db = createFakeDb();
});

describe('DELETE /api/admin/blogs/[id] canonical stored state (Issue 11)', () => {
  it('writes deleted:true AND status:archived AND a deletedAt timestamp', async () => {
    const db = mockDbHolder.db as FakeDb;
    seedHolderWithBlog(db);

    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(200);

    const rows = (db as any)._docsIn('blogs');
    const stored = rows.find((r: any) => r.id === 'blog-1')?.data;
    expect(stored).toBeTruthy();
    expect(stored.deleted).toBe(true);
    expect(stored.status).toBe('archived');
    expect(stored.deletedAt).toBeTruthy();
    // The rest of the document is untouched by the delete.
    expect(stored.title).toBe('Post');
    expect(stored.slug).toBe('post');
  });
});
