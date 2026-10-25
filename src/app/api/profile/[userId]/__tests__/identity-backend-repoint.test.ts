/**
 * @jest-environment node
 *
 * Identity migration re-point (IDENTITY_DEPENDENCY_MAP.md 5.1):
 * GET /api/profile/[userId]'s caller-identity read - the route's own
 * uncached roles/{requesterUid}.get(), consumed at exactly one place:
 *   requesterRoleForProfile = snap.exists ? snap.data()?.role : 'member'
 * which drives isProfileAdmin, which gates whether a non-owner
 * requester sees the owner's email / whatsappNumber.
 *
 * Field-consumption audit: ONLY exists + role are consumed from the
 * snapshot; both are inside the identity bundle's roles projection
 * (exists, role, additionalRoles, expiresAt, expiresRoleKey,
 * chapterId), so the flag-ON shim loses no field.
 *
 * Mocked at the identity-backend module boundary:
 *  - flag OFF -> the direct Firestore roles get runs (counted), the
 *    backend is never called; admin visibility matches today's role.
 *  - flag ON  -> the bundle supplies the caller's role (Firestore
 *    roles get count stays 0, even when the Firestore doc disagrees);
 *    admin visibility follows the BUNDLE role.
 *  - flag ON + backend throws -> simulates the dispatcher's internal
 *    Firestore fallback also failing; the route degrades exactly as
 *    today's throwing Firestore get does (snap null -> 'member'):
 *    HTTP 200, profile served, sensitive fields withheld.
 */

const REQUESTER = 'requester-1';

const state = {
  rolesGetCount: 0,
  rolesData: undefined as Record<string, unknown> | undefined,
};

jest.mock('firebase-admin/firestore', () => ({
  Timestamp: { now: () => ({ toDate: () => new Date() }) },
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDbHolder.db,
  admin: {
    firestore: { FieldPath: { documentId: () => '__name__' } },
  },
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => ({
    authenticated: true,
    user: { userId: REQUESTER, role: 'member' },
  })),
}));

jest.mock('@/lib/server/identity-backend', () => ({
  useSupaIdentity: jest.fn(() => false),
  getIdentityBundleViaBackend: jest.fn(),
  getPermissionDocViaBackend: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/profile/[userId]/route';
import {
  useSupaIdentity,
  getIdentityBundleViaBackend,
} from '@/lib/server/identity-backend';

const mockUseSupa = useSupaIdentity as unknown as jest.Mock;
const mockGetBundle = getIdentityBundleViaBackend as unknown as jest.Mock;

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

const emptyQuery = async () => ({ empty: true, docs: [], size: 0 });
const queryChain = () => ({ limit: () => ({ get: emptyQuery }), get: emptyQuery });

function makeDb(ownerId: string) {
  const ownerData = {
    displayName: 'Owner Person',
    email: 'owner@example.com',
    whatsappNumber: '+92-300-0000000',
    displayRole: 'member',
    role: 'member',
  };
  return {
    collection: (name: string) => {
      if (name === 'users') {
        return {
          doc: (id: string) => ({
            get: async () =>
              id === ownerId
                ? { exists: true, id, data: () => ownerData }
                : { exists: false, id, data: () => undefined },
            collection: () => ({ get: async () => ({ docs: [] }) }),
          }),
          where: queryChain,
        };
      }
      if (name === 'roles') {
        return {
          doc: (id: string) => ({
            get: async () => {
              state.rolesGetCount++;
              const data = state.rolesData;
              return { exists: data !== undefined, id, data: () => data };
            },
          }),
        };
      }
      return { where: queryChain, doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }) };
    },
  };
}

// The route has a module-level profile cache keyed by userId:sections,
// so every case uses a distinct owner id to stay independent.
let ownerSeq = 0;
async function fetchProfile() {
  const ownerId = `owner-${++ownerSeq}`;
  mockDbHolder.db = makeDb(ownerId);
  const req = new NextRequest(`http://localhost/api/profile/${ownerId}`);
  const res = await GET(req, { params: Promise.resolve({ userId: ownerId }) });
  return { res, json: await res.json() };
}

beforeEach(() => {
  jest.clearAllMocks();
  state.rolesGetCount = 0;
  state.rolesData = { role: 'member' };
  mockUseSupa.mockReturnValue(false);
});

describe('profile caller roles read: identity-backend re-point', () => {
  it('flag OFF: Firestore roles doc (admin role) is used, backend never called, sensitive fields visible', async () => {
    state.rolesData = { role: 'president_chapter' };
    const { res, json } = await fetchProfile();
    expect(res.status).toBe(200);
    expect(json.profile.email).toBe('owner@example.com');
    expect(json.profile.whatsappNumber).toBe('+92-300-0000000');
    expect(state.rolesGetCount).toBe(1);
    expect(mockGetBundle).not.toHaveBeenCalled();
  });

  it('flag OFF: Firestore roles doc (member) withholds sensitive fields, as today', async () => {
    state.rolesData = { role: 'member' };
    const { res, json } = await fetchProfile();
    expect(res.status).toBe(200);
    expect(json.profile.email).toBeUndefined();
    expect(json.profile.whatsappNumber).toBeUndefined();
    expect(state.rolesGetCount).toBe(1);
    expect(mockGetBundle).not.toHaveBeenCalled();
  });

  it('flag ON: bundle role wins over the Firestore doc; Firestore roles get is skipped', async () => {
    mockUseSupa.mockReturnValue(true);
    mockGetBundle.mockResolvedValue(bundleWith('president_chapter'));
    state.rolesData = { role: 'member' }; // would withhold if the Firestore path ran
    const { res, json } = await fetchProfile();
    expect(res.status).toBe(200);
    expect(json.profile.email).toBe('owner@example.com');
    expect(json.profile.whatsappNumber).toBe('+92-300-0000000');
    expect(mockGetBundle).toHaveBeenCalledTimes(1);
    expect(mockGetBundle).toHaveBeenCalledWith(REQUESTER);
    expect(state.rolesGetCount).toBe(0);
  });

  it('flag ON: bundle with no roles doc -> member, sensitive fields withheld (matches flag OFF missing-doc)', async () => {
    mockUseSupa.mockReturnValue(true);
    mockGetBundle.mockResolvedValue(bundleWith(undefined, false));
    state.rolesData = { role: 'president_chapter' }; // would expose if the Firestore path ran
    const { res, json } = await fetchProfile();
    expect(res.status).toBe(200);
    expect(json.profile.email).toBeUndefined();
    expect(json.profile.whatsappNumber).toBeUndefined();
    expect(state.rolesGetCount).toBe(0);
  });

  it('flag ON + backend throws: route still answers 200 with today\'s member fallback (fields withheld)', async () => {
    mockUseSupa.mockReturnValue(true);
    mockGetBundle.mockRejectedValue(new Error('backend down after fallback'));
    const { res, json } = await fetchProfile();
    expect(res.status).toBe(200);
    expect(json.profile.displayName).toBe('Owner Person');
    expect(json.profile.email).toBeUndefined();
    expect(json.profile.whatsappNumber).toBeUndefined();
    expect(state.rolesGetCount).toBe(0);
  });
});
