/**
 * @jest-environment node
 *
 * Slug parity pins for POST /api/blogs (the REST create path).
 *
 * This route always derived the slug from the title when none was
 * provided - it is the reference behavior the admin form paths diverged
 * from. These tests pin that behavior so the shared-helper extraction
 * (src/lib/blog-slug.ts) cannot silently change it:
 * - no slug provided -> title-derived slug is stored;
 * - explicit slug provided -> stored exactly.
 *
 * Mocking pattern follows route-parity.test.ts in this directory.
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
import { POST } from '../route';

function seedHolder(db: FakeDb) {
  db.seed('roles', HOLDER, {
    role: 'member',
    additionalRoles: [CUSTOM],
  });
  db.seed('roleDefinitions', CUSTOM, {
    isCustom: true,
    permissions: ['canManageBlogs'],
  });
}

/** FakeDb has no collection.add(); shim it onto each collection ref. */
function withAdd(db: FakeDb): FakeDb {
  const orig = db.collection.bind(db);
  (db as any).collection = (name: string) => {
    const col: any = orig(name);
    if (!col.add) {
      col.add = async (data: Record<string, unknown>) => {
        const ref = col.doc();
        await ref.set(data);
        return ref;
      };
    }
    return col;
  };
  return db;
}

function req(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/blogs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  state.authContext = authContextFor(HOLDER);
  mockDbHolder.db = withAdd(createFakeDb());
  seedHolder(mockDbHolder.db as FakeDb);
});

describe('POST /api/blogs slug behavior (reference path)', () => {
  it('derives the slug from the title when no slug is provided', async () => {
    const res = await POST(
      req({ title: 'Hello World Post', content: 'Body text', authorId: HOLDER }),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.slug).toBe('hello-world-post');
    const stored = (mockDbHolder.db as FakeDb).all('blogs');
    expect(stored).toHaveLength(1);
    expect(stored[0].data.slug).toBe('hello-world-post');
  });

  it('derives the slug when the slug is an empty string', async () => {
    const res = await POST(
      req({ title: 'Hello World Post', content: 'Body text', authorId: HOLDER, slug: '' }),
    );

    expect(res.status).toBe(200);
    expect((await res.json()).slug).toBe('hello-world-post');
  });

  it('keeps an explicitly provided slug exactly', async () => {
    const res = await POST(
      req({
        title: 'Hello World Post',
        content: 'Body text',
        authorId: HOLDER,
        slug: 'my-explicit-slug',
      }),
    );

    expect(res.status).toBe(200);
    expect((await res.json()).slug).toBe('my-explicit-slug');
    const stored = (mockDbHolder.db as FakeDb).all('blogs');
    expect(stored[0].data.slug).toBe('my-explicit-slug');
  });
});
