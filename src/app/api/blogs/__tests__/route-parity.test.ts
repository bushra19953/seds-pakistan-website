/**
 * @jest-environment node
 *
 * Family B parity test for POST /api/blogs (B4, canManageBlogs).
 *
 * The gate now resolves through hasServerPermissionForUser: a holder
 * whose PRIMARY role is `member` with canManageBlogs granted via a
 * custom role in additionalRoles (contracts K2) can create a post; an
 * expired grant and a missing grant keep the original 403 body.
 *
 * The REAL @/lib/server/permissions resolver runs against FakeFirestore.
 * Only auth (withAuth) and firebase-admin are mocked. Auth mocks use
 * the real AuthContext shape (userId, NOT uid).
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
import { POST } from '../route';

function seedHolder(db: FakeDb, expired = false) {
  db.seed('roles', HOLDER, {
    role: 'member',
    additionalRoles: [CUSTOM],
    ...(expired
      ? { expiresAt: new Date(Date.now() - 60_000), expiresRoleKey: CUSTOM }
      : {}),
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

function req() {
  return new NextRequest('http://localhost/api/blogs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Hello', content: 'Body text', authorId: HOLDER }),
  });
}

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
  mockDbHolder.db = withAdd(createFakeDb());
});

describe('B4 POST /api/blogs parity', () => {
  it('custom canManageBlogs holder can create a blog post', async () => {
    seedHolder(mockDbHolder.db as FakeDb);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe('Blog post created successfully');
  });

  it('expired grant is denied with the original 403 body', async () => {
    seedHolder(mockDbHolder.db as FakeDb, true);
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Unauthorized: Insufficient permissions to create blog posts.',
    });
  });

  it('no grant is denied unchanged', async () => {
    (mockDbHolder.db as FakeDb).seed('roles', HOLDER, { role: 'member' });
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Unauthorized: Insufficient permissions to create blog posts.',
    });
  });
});
