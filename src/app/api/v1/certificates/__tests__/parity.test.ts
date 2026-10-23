/**
 * @jest-environment node
 *
 * Parity tests for the v1 certificate routes (Family F, F11-F14):
 *   PATCH/DELETE /api/v1/certificates/[id], POST /api/v1/certificates/issue,
 *   POST /api/v1/certificates/bulk-issue.
 *
 * Each gate used to derive the caller's role from a raw roles/{uid} read
 * (D-RAWREAD) feeding hasServerPermission; it now calls
 * hasServerPermissionForUser(db, decoded.uid, 'canManageCertificates').
 * These tests run the REAL permissions module over an in-memory Firestore.
 *
 * Canonical holder fixture: primary `member` + additionalRoles
 * ['custom_verify_design_aide'] + roleDefinitions/custom_verify_design_aide
 * { isCustom: true, permissions: ['canManageCertificates'] }.
 */

import { NextRequest } from 'next/server';
import { createFakeFirestore, type FakeFirestore } from '@/lib/finance/__tests__/fake-firestore';

const mockHolder: { db: FakeFirestore | null } = { db: null };
const mockState = { uid: 'holder-1' };

const mockDecoded = () => ({
  uid: mockState.uid,
  name: 'Holder One',
  email: 'holder@example.com',
});

jest.mock('@/lib/server/firebase-admin', () => ({
  admin: {
    auth: () => ({
      verifyIdToken: async () => mockDecoded(),
    }),
    firestore: {
      Timestamp: {
        now: () => new Date(),
        fromDate: (d: Date) => d,
      },
      FieldValue: {
        serverTimestamp: () => new Date(),
        delete: () => ({ __delete: true }),
      },
    },
  },
  getDb: () => mockHolder.db,
  ensureAdminInitialized: () => true,
  getAdminDiagnostics: () => ({}),
}));

jest.mock('@/lib/auth/verifySession', () => ({
  verifyIdTokenString: async () => mockDecoded(),
  toSessionErrorResponse: () => null,
}));

import { PATCH, DELETE } from '@/app/api/v1/certificates/[id]/route';
import { POST as issuePOST } from '@/app/api/v1/certificates/issue/route';
import { POST as bulkPOST } from '@/app/api/v1/certificates/bulk-issue/route';

const CUSTOM = 'custom_verify_design_aide';
const KEY = 'canManageCertificates';

function req(url: string, method: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let db: FakeFirestore;
let savedSalt: string | undefined;
let savedProject: string | undefined;

beforeEach(() => {
  savedSalt = process.env.CERTIFICATE_SALT;
  savedProject = process.env.FIREBASE_PROJECT_ID;
  process.env.CERTIFICATE_SALT = 'parity-test-salt';
  delete process.env.FIREBASE_PROJECT_ID;
  delete process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

  db = createFakeFirestore() as never;
  mockHolder.db = db;
  mockState.uid = 'holder-1';

  db.__seed('roleDefinitions', CUSTOM, { isCustom: true, permissions: [KEY] });
  db.__seed('roles', 'holder-1', { role: 'member', additionalRoles: [CUSTOM] });
  db.__seed('roles', 'expired-1', {
    role: 'member',
    additionalRoles: [CUSTOM],
    expiresAt: new Date('2020-01-01T00:00:00.000Z'),
    expiresRoleKey: CUSTOM,
  });
  db.__seed('roles', 'plain-1', { role: 'member' });

  db.__seed('users', 'target-1', { displayName: 'Target One' });
  db.__seed('certificates', 'cert-1', {
    code: 'CODE-1',
    title: 'Old Title',
    userId: 'target-1',
    status: 'issued',
  });
  db.__seed('certificate_public', 'CODE-1', { title: 'Old Title' });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  if (savedSalt === undefined) delete process.env.CERTIFICATE_SALT;
  else process.env.CERTIFICATE_SALT = savedSalt;
  if (savedProject === undefined) delete process.env.FIREBASE_PROJECT_ID;
  else process.env.FIREBASE_PROJECT_ID = savedProject;
  (console.error as jest.Mock).mockRestore?.();
  (console.warn as jest.Mock).mockRestore?.();
  (console.log as jest.Mock).mockRestore?.();
});

describe('certificates [id] parity (F11/F12)', () => {
  it('PATCH: custom holder is admitted and the update lands', async () => {
    const res = await PATCH(
      req('http://localhost/api/v1/certificates/cert-1', 'PATCH', { title: 'New Title' }),
      { params: Promise.resolve({ id: 'cert-1' }) }
    );
    expect(res.status).toBe(200);
    expect(db.__doc('certificates', 'cert-1')?.title).toBe('New Title');
  });

  it('DELETE: custom holder is admitted and the certificate is deleted', async () => {
    const res = await DELETE(
      req('http://localhost/api/v1/certificates/cert-1', 'DELETE'),
      { params: Promise.resolve({ id: 'cert-1' }) }
    );
    expect(res.status).toBe(200);
    expect(db.__doc('certificates', 'cert-1')).toBeUndefined();
  });

  it('PATCH: expired custom grant is denied with the original 403 body', async () => {
    mockState.uid = 'expired-1';
    const res = await PATCH(
      req('http://localhost/api/v1/certificates/cert-1', 'PATCH', { title: 'New Title' }),
      { params: Promise.resolve({ id: 'cert-1' }) }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: insufficient privileges' });
    expect(db.__doc('certificates', 'cert-1')?.title).toBe('Old Title');
  });

  it('DELETE: caller with no grant is denied with the original 403 body', async () => {
    mockState.uid = 'plain-1';
    const res = await DELETE(
      req('http://localhost/api/v1/certificates/cert-1', 'DELETE'),
      { params: Promise.resolve({ id: 'cert-1' }) }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: insufficient privileges' });
    expect(db.__doc('certificates', 'cert-1')).toBeDefined();
  });
});

describe('certificates issue parity (F14)', () => {
  it('POST: custom holder can issue a certificate', async () => {
    const res = await issuePOST(
      req('http://localhost/api/v1/certificates/issue', 'POST', {
        userId: 'target-1',
        title: 'Fixture Award',
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.code).toBeTruthy();
  });

  it('POST: expired custom grant is denied with the original 403 body', async () => {
    mockState.uid = 'expired-1';
    const res = await issuePOST(
      req('http://localhost/api/v1/certificates/issue', 'POST', {
        userId: 'target-1',
        title: 'Fixture Award',
      })
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: insufficient privileges' });
  });
});

describe('certificates bulk-issue parity (F13)', () => {
  it('POST: custom holder can bulk-issue', async () => {
    const res = await bulkPOST(
      req('http://localhost/api/v1/certificates/bulk-issue', 'POST', {
        userIds: ['target-1'],
        certificateData: { title: 'Fixture Award' },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issued).toBe(1);
    expect(body.failed).toBe(0);
  });

  it('POST: caller with no grant is denied with the original 403 body', async () => {
    mockState.uid = 'plain-1';
    const res = await bulkPOST(
      req('http://localhost/api/v1/certificates/bulk-issue', 'POST', {
        userIds: ['target-1'],
        certificateData: { title: 'Fixture Award' },
      })
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: insufficient privileges' });
  });
});
