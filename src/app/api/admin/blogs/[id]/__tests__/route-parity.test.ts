/**
 * @jest-environment node
 *
 * Family B parity tests for /api/admin/blogs/[id] (B1 GET, B2 PUT, B3 DELETE).
 *
 * The gates now resolve through hasServerPermissionForUser, so a holder
 * whose PRIMARY role is the plain catalog role `member` and whose custom
 * grant (canManageBlogs) sits in additionalRoles (contracts K2) is
 * admitted; an expired grant and a missing grant keep the original 403
 * bodies byte-identical. PUT/DELETE remain OR-ed with authorship: the
 * isAuthor arm is untouched by the conversion.
 *
 * The REAL @/lib/server/permissions resolver runs against an in-memory
 * FakeFirestore (the parity claim is a Firestore-shape claim). Only
 * auth (withAuth) and firebase-admin are mocked. Auth mocks use the
 * real AuthContext shape (userId, NOT uid).
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
import { GET, PUT, DELETE } from '../route';

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
  db.seed('blogs', 'blog-1', { title: 'Post', authorId: 'someone-else', status: 'draft' });
}

function req(method: string, body?: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/admin/blogs/blog-1', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const ctx = { params: Promise.resolve({ id: 'blog-1' }) };

beforeEach(() => {
  jest.clearAllMocks();
  state.authContext = authContextFor(HOLDER);
  mockDbHolder.db = createFakeDb();
});

describe('B1 GET /api/admin/blogs/[id] parity', () => {
  it('custom canManageBlogs holder is allowed', async () => {
    seedHolder(mockDbHolder.db as FakeDb);
    const res = await GET(req('GET'), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe('blog-1');
  });

  it('expired grant is denied with the original 403 body', async () => {
    seedHolder(mockDbHolder.db as FakeDb, true);
    const res = await GET(req('GET'), ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Unauthorized: Insufficient permissions.' });
  });

  it('no grant is denied unchanged', async () => {
    const db = mockDbHolder.db as FakeDb;
    db.seed('roles', HOLDER, { role: 'member' });
    db.seed('blogs', 'blog-1', { title: 'Post', authorId: 'someone-else' });
    const res = await GET(req('GET'), ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Unauthorized: Insufficient permissions.' });
  });
});

describe('B2 PUT /api/admin/blogs/[id] parity (authorship OR)', () => {
  it('custom holder (not the author) is allowed via the permission operand', async () => {
    seedHolder(mockDbHolder.db as FakeDb);
    const res = await PUT(req('PUT', { title: 'Edited' }), ctx);
    expect(res.status).toBe(200);
  });

  it('author without any grant is still allowed via the untouched isAuthor arm', async () => {
    const db = mockDbHolder.db as FakeDb;
    db.seed('roles', HOLDER, { role: 'member' });
    db.seed('blogs', 'blog-1', { title: 'Post', authorId: HOLDER });
    const res = await PUT(req('PUT', { title: 'Edited' }), ctx);
    expect(res.status).toBe(200);
  });

  it('expired grant + not author is denied with the original 403 body', async () => {
    seedHolder(mockDbHolder.db as FakeDb, true);
    const res = await PUT(req('PUT', { title: 'Edited' }), ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Unauthorized: You do not have permission to edit this post.',
    });
  });
});

describe('B3 DELETE /api/admin/blogs/[id] parity (authorship OR)', () => {
  it('custom holder (not the author) is allowed via the permission operand', async () => {
    seedHolder(mockDbHolder.db as FakeDb);
    const res = await DELETE(req('DELETE'), ctx);
    expect(res.status).toBe(200);
  });

  it('expired grant + not author is denied with the original 403 body', async () => {
    seedHolder(mockDbHolder.db as FakeDb, true);
    const res = await DELETE(req('DELETE'), ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Unauthorized: You do not have permission to delete this post.',
    });
  });
});
