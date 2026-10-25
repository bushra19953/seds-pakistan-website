/**
 * @jest-environment node
 *
 * Identity migration re-point (IDENTITY_DEPENDENCY_MAP.md 5.2):
 * checkPositionManagementPermission's fallback roles/{uid} read.
 *
 * Mocked at the identity-backend module boundary:
 *  - flag OFF -> the direct Firestore roles/{uid}.get() runs (counted),
 *    the backend is never called, and the verdict is today's.
 *  - flag ON  -> getIdentityBundleViaBackend(uid) supplies the roles
 *    answer (Firestore roles get count stays 0) and the downstream
 *    verdict (hasServerPermissionForUser, pinned, mocked here) is
 *    unchanged.
 *  - flag ON + backend throws -> simulates the dispatcher's internal
 *    Firestore fallback also failing; the route must degrade exactly
 *    as today's throwing Firestore get does: the helper's catch
 *    returns false and POST answers 403 (never a 500).
 *
 * The custom-claims arm above the fallback read is pinned and
 * untouched: claims stay empty in every case below, so every case
 * exercises the fallback path.
 */

const HOLDER = 'holder-1';

const state = {
  claims: {} as Record<string, unknown>,
  permission: true,
  rolesGetCount: 0,
};

jest.mock('@/lib/server/consent-gate', () => ({
  assertConsentFor: jest.fn(async () => ({ mode: 'hard', outcome: 'consented' })),
  isCategoryBRole: jest.fn(async () => false),
  canonicaliseRoleKey: (k: string) => String(k ?? '').trim().toLowerCase(),
  consentGateHttpError: () => ({ status: 500, body: { error: 'CONSENT_CHECK_UNAVAILABLE' } }),
}));

jest.mock('@/lib/auth/verifySession', () => ({
  extractBearerToken: () => 'token-1',
  verifyIdTokenString: jest.fn(async () => {
    const pid =
      process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'test-proj';
    return { uid: 'holder-1', iss: `https://securetoken.google.com/${pid}`, aud: pid };
  }),
  SessionError: class SessionError extends Error {
    statusCode = 401;
  },
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => state.permission),
}));

jest.mock('@/lib/server/identity-backend', () => ({
  useSupaIdentity: jest.fn(() => false),
  getIdentityBundleViaBackend: jest.fn(),
  getPermissionDocViaBackend: jest.fn(),
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  admin: {
    auth: () => ({
      getUser: async () => ({ customClaims: state.claims }),
    }),
    firestore: {
      Timestamp: { fromMillis: (ms: number) => ({ toMillis: () => ms }) },
    },
  },
  getDb: () => mockDbHolder.db,
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/positions/route';
import {
  useSupaIdentity,
  getIdentityBundleViaBackend,
} from '@/lib/server/identity-backend';
import { hasServerPermissionForUser } from '@/lib/server/permissions';

const mockUseSupa = useSupaIdentity as unknown as jest.Mock;
const mockGetBundle = getIdentityBundleViaBackend as unknown as jest.Mock;
const mockHasPermission = hasServerPermissionForUser as unknown as jest.Mock;

function bundleWith(role: unknown, exists = true) {
  return {
    roles: {
      exists,
      role,
      additionalRoles: undefined,
      expiresAt: undefined,
      expiresRoleKey: undefined,
      chapterId: undefined,
    },
    users: {
      exists: true,
      role,
      displayRole: undefined,
      additionalRoles: undefined,
      isBanned: false,
      chapterId: undefined,
    },
    loadedAt: 123,
  };
}

function makeDb() {
  const docs: Record<string, any> = {
    'users/user-1': { displayName: 'Test User', email: 'u@example.com' },
    [`roles/${HOLDER}`]: { role: 'member' },
  };
  return {
    docs,
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          if (name === 'roles') state.rolesGetCount++;
          const data = docs[`${name}/${id}`];
          return { exists: data !== undefined, id, data: () => data };
        },
        update: async () => undefined,
        delete: async () => undefined,
      }),
      add: async (data: any) => {
        docs[`${name}/pos-new`] = data;
        return { id: 'pos-new' };
      },
    }),
  };
}

function createReq() {
  return new NextRequest('http://localhost/api/positions', {
    method: 'POST',
    body: JSON.stringify({ role: 'chair_events', userId: 'user-1', startDate: '2026-10-21' }),
    headers: { Authorization: 'Bearer token-1', 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  state.claims = {};
  state.permission = true;
  state.rolesGetCount = 0;
  mockUseSupa.mockReturnValue(false);
  mockDbHolder.db = makeDb();
});

describe('positions fallback roles read: identity-backend re-point', () => {
  it('flag OFF: Firestore roles get is used, backend never called, verdict is today\'s (allow)', async () => {
    const res = await POST(createReq());
    expect(res.status).toBe(200);
    expect(state.rolesGetCount).toBe(1);
    expect(mockGetBundle).not.toHaveBeenCalled();
    expect(mockHasPermission).toHaveBeenCalledWith(expect.anything(), HOLDER, 'canManagePositions');
  });

  it('flag OFF: downstream deny keeps the original 403', async () => {
    state.permission = false;
    const res = await POST(createReq());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Forbidden: insufficient privileges to manage positions',
    });
    expect(state.rolesGetCount).toBe(1);
    expect(mockGetBundle).not.toHaveBeenCalled();
  });

  it('flag ON: roles answer comes from the bundle, Firestore roles get is skipped, verdict matches', async () => {
    mockUseSupa.mockReturnValue(true);
    mockGetBundle.mockResolvedValue(bundleWith('president_chapter'));
    const res = await POST(createReq());
    expect(res.status).toBe(200);
    expect(mockGetBundle).toHaveBeenCalledTimes(1);
    expect(mockGetBundle).toHaveBeenCalledWith(HOLDER);
    expect(state.rolesGetCount).toBe(0);
    expect(mockHasPermission).toHaveBeenCalledWith(expect.anything(), HOLDER, 'canManagePositions');
  });

  it('flag ON: bundle with no roles doc still reaches the downstream check and matches its verdict (deny)', async () => {
    mockUseSupa.mockReturnValue(true);
    mockGetBundle.mockResolvedValue(bundleWith(undefined, false));
    state.permission = false;
    const res = await POST(createReq());
    expect(res.status).toBe(403);
    expect(state.rolesGetCount).toBe(0);
    expect(mockGetBundle).toHaveBeenCalledWith(HOLDER);
  });

  it('flag ON + backend throws: degrades exactly like today\'s throwing Firestore get (403, no 500, downstream not reached)', async () => {
    mockUseSupa.mockReturnValue(true);
    mockGetBundle.mockRejectedValue(new Error('backend down after fallback'));
    const res = await POST(createReq());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Forbidden: insufficient privileges to manage positions',
    });
    expect(mockHasPermission).not.toHaveBeenCalled();
  });
});
