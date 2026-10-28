/**
 * @jest-environment node
 *
 * FIXED (security audit 2026-10-28, item 15): GET
 * /api/sourcing/download/[filename] previously had NO authentication, NO
 * authorisation, NO filename sanitisation and publicly cacheable
 * responses — anyone who knew or guessed a filename could download the
 * NDA-gated CAD packages under sourcing-cad-packages/.
 *
 * The route now applies, in order:
 *   1. the sibling sourcing routes' session pattern (Bearer ID token or
 *      __session cookie, verified via verifyIdTokenString) -> 401;
 *   2. the sourcing management gate used by GET /api/sourcing/inquiries
 *      and inquiries/[id]: superadmin only, isSuperAdmin(resolveUserRole(
 *      db, uid), uid) -> 403. The resolver runs in its documented
 *      two-argument form, so stored-role superadmins pass (the inquiries
 *      routes' legacy one-argument call is a separate pinned defect);
 *   3. filename validation against the upload path's own naming charset
 *      (get-upload-url mints `${uid}_${timestamp}_${sanitized}`,
 *      sanitized to [a-zA-Z0-9._-]) — separators / traversal -> 400;
 *   4. record binding: the name must be referenced by a
 *      sourcing_inquiries record's fileDownloadUrl in one of the URL
 *      forms the system itself produces -> otherwise 404, even when the
 *      object exists in the bucket;
 *   5. success serves the bytes with Cache-Control: private, no-store.
 *
 * Only the session and storage seams are mocked. Role resolution runs
 * through the REAL permissions/roles modules against an in-memory
 * FakeFirestore, so the gate outcomes describe production behaviour.
 * Firestore data reads against the real database: zero (all mocked).
 */

jest.mock('@/lib/auth/verifySession', () => ({
  extractBearerToken: (req: { headers: { get(name: string): string | null } }) => {
    const header = req.headers.get('authorization');
    return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  },
  verifyIdTokenString: jest.fn(async (token: string) => {
    if (token === 'invalid-token') throw new Error('bad token');
    return { uid: token };
  }),
}));

const mockDbHolder: { db: unknown } = { db: null };
const mockStorageHolder: { files: Map<string, { contentType: string; body: Buffer }> } = {
  files: new Map(),
};
jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDbHolder.db,
  getAdminStorage: () => ({
    bucket: (_name: string) => ({
      file: (path: string) => ({
        exists: async () => [mockStorageHolder.files.has(path)],
        getMetadata: async () => [
          { contentType: mockStorageHolder.files.get(path)?.contentType || 'application/octet-stream' },
        ],
        download: async () => [mockStorageHolder.files.get(path)?.body ?? Buffer.alloc(0)],
      }),
    }),
  }),
  admin: {},
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/sourcing/download/[filename]/route';
import { createFakeDb, type FakeDb } from '@/lib/server/__tests__/fake-firestore';
import { FOUNDER_UID } from '@/lib/roles';

// A recorded package name in the exact shape get-upload-url mints.
const RECORDED = 'engineer1_1720000000000_bracket.zip';
const RECORDED_PATH = `sourcing-cad-packages/${RECORDED}`;
const CAD_BYTES = Buffer.from('fake-cad-package-bytes');

function bearerReq(uid: string | null, filename: string) {
  return new NextRequest(`http://localhost/api/sourcing/download/${filename}`, {
    headers: uid ? { authorization: `Bearer ${uid}` } : {},
  });
}

function cookieReq(uid: string, filename: string) {
  return new NextRequest(`http://localhost/api/sourcing/download/${filename}`, {
    headers: { cookie: `__session=${uid}` },
  });
}

function params(filename: string) {
  return { params: Promise.resolve({ filename }) };
}

function seedRecordedPackage(db: FakeDb) {
  db.seed('sourcing_inquiries', 'inq-1', {
    fullName: 'Test Applicant',
    fileName: 'bracket.zip',
    fileDownloadUrl: `/api/sourcing/download/${RECORDED}`,
  });
  mockStorageHolder.files.set(RECORDED_PATH, {
    contentType: 'application/zip',
    body: CAD_BYTES,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDbHolder.db = createFakeDb();
  mockStorageHolder.files = new Map();
});

describe('FIXED: /api/sourcing/download authentication', () => {
  it('no token at all -> 401', async () => {
    const res = await GET(bearerReq(null, RECORDED), params(RECORDED));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Sign in required');
  });

  it('invalid token -> 401', async () => {
    const res = await GET(bearerReq('invalid-token', RECORDED), params(RECORDED));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Invalid session');
  });
});

describe('FIXED: /api/sourcing/download sourcing gate (superadmin)', () => {
  it('authenticated member without the sourcing gate -> 403, storage never reached', async () => {
    const db = mockDbHolder.db as FakeDb;
    seedRecordedPackage(db);
    db.seed('roles', 'member-1', { role: 'member' });
    db.seed('users', 'member-1', { role: 'member' });
    const res = await GET(bearerReq('member-1', RECORDED), params(RECORDED));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Forbidden: sourcing management only');
  });

  it('the Founder passes the gate and downloads a recorded package (200, private/no-store)', async () => {
    const db = mockDbHolder.db as FakeDb;
    seedRecordedPackage(db);
    const res = await GET(bearerReq(FOUNDER_UID, RECORDED), params(RECORDED));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${RECORDED}"`);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(CAD_BYTES);
  });

  it('a stored-role superadmin (founder_patron) passes the gate — the gate resolves real roles', async () => {
    const db = mockDbHolder.db as FakeDb;
    seedRecordedPackage(db);
    db.seed('roles', 'patron-1', { role: 'founder_patron' });
    const res = await GET(bearerReq('patron-1', RECORDED), params(RECORDED));
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(CAD_BYTES);
  });

  it('the __session cookie session (admin page link path) also downloads (200)', async () => {
    const db = mockDbHolder.db as FakeDb;
    seedRecordedPackage(db);
    const res = await GET(cookieReq(FOUNDER_UID, RECORDED), params(RECORDED));
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(CAD_BYTES);
  });
});

describe('FIXED: /api/sourcing/download filename validation + record binding', () => {
  it('traversal-style filename (..%2F..%2F) -> 400', async () => {
    const db = mockDbHolder.db as FakeDb;
    seedRecordedPackage(db);
    const res = await GET(
      bearerReq(FOUNDER_UID, '..%2F..%2Fsecret.txt'),
      params('..%2F..%2Fsecret.txt'),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid filename');
  });

  it('embedded path separator (sourcing-cad-packages%2F...) -> 400', async () => {
    const res = await GET(
      bearerReq(FOUNDER_UID, 'x'),
      params(`sourcing-cad-packages%2F${RECORDED}`),
    );
    expect(res.status).toBe(400);
  });

  it('bare ".." -> 400', async () => {
    const res = await GET(bearerReq(FOUNDER_UID, '..'), params('..'));
    expect(res.status).toBe(400);
  });

  it('unrecorded filename -> 404 even though the object exists in the bucket', async () => {
    const db = mockDbHolder.db as FakeDb;
    seedRecordedPackage(db);
    // An object that exists in storage but is referenced by NO record.
    const orphan = 'engineer1_1720000009999_orphan.zip';
    mockStorageHolder.files.set(`sourcing-cad-packages/${orphan}`, {
      contentType: 'application/zip',
      body: Buffer.from('orphan-bytes'),
    });
    const res = await GET(bearerReq(FOUNDER_UID, orphan), params(orphan));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('CAD package file not found');
  });

  it('recorded filename whose object is missing from storage -> 404', async () => {
    const db = mockDbHolder.db as FakeDb;
    db.seed('sourcing_inquiries', 'inq-1', {
      fileName: 'bracket.zip',
      fileDownloadUrl: `/api/sourcing/download/${RECORDED}`,
    });
    // Deliberately no storage object seeded.
    const res = await GET(bearerReq(FOUNDER_UID, RECORDED), params(RECORDED));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('CAD package file not found in storage');
  });

  it('a record referencing the package by its direct bucket URL also binds (200)', async () => {
    const db = mockDbHolder.db as FakeDb;
    db.seed('sourcing_inquiries', 'inq-2', {
      fileName: 'bracket.zip',
      fileDownloadUrl: `https://storage.googleapis.com/seds-pakistan.appspot.com/${RECORDED_PATH}`,
    });
    mockStorageHolder.files.set(RECORDED_PATH, {
      contentType: 'application/zip',
      body: CAD_BYTES,
    });
    const res = await GET(bearerReq(FOUNDER_UID, RECORDED), params(RECORDED));
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(CAD_BYTES);
  });
});
