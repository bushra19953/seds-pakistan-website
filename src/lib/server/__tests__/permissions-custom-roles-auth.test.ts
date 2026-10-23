/**
 * @jest-environment node
 *
 * PERM-RESOLUTION (Custom Roles Fix Program) - the verifyAuthentication
 * leg of the one-answer contract.
 *
 * Contracts Section 4.4: "verifyAuthentication must not pre-floor a
 * custom slug to member_basic before permission checks see it" and the
 * mainstream path "extends that read to surface held custom slugs
 * alongside the canonical role". SEC-13: claims.role is never an
 * authorization input.
 *
 * What is pinned here:
 * - A custom-grant holder authenticates, and their AuthContext role is
 *   their catalog PRIMARY (contracts K2: the primary slot always holds
 *   a catalog key; the custom grant lives in additionalRoles).
 * - The permission answer reachable from the auth path (the user-scoped
 *   holder resolution of plan section 5, or custom slugs surfaced on
 *   the AuthContext) EQUALS the raw-token hasServerPermission answer -
 *   with the SEC-11 shadow fixture present. If neither exists, the
 *   agreement test fails as MISSING IMPLEMENTATION.
 * - A forged claims.role changes nothing (SEC-13 characterisation:
 *   passes before and after).
 */

const mockDbHolder: { db: unknown } = { db: null };
const mockClaimsHolder: { extra: Record<string, unknown> } = { extra: {} };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  admin: {
    auth: () => ({
      verifyIdToken: async () => ({
        uid: 'holder-uid',
        email: 'holder@example.com',
        email_verified: true,
        name: 'Holder',
        ...mockClaimsHolder.extra,
      }),
    }),
    firestore: {
      FieldValue: { serverTimestamp: () => 'ts', delete: () => 'del' },
    },
  },
}));
jest.mock('firebase/auth', () => ({ getAuth: jest.fn() }));
jest.mock('@/firebase', () => ({ getFirebaseApp: jest.fn() }));
jest.mock('@/firebase/error-emitter', () => ({
  errorEmitter: { emit: jest.fn() },
}));
jest.mock('@/firebase/errors', () => ({
  FirestorePermissionError: class FirestorePermissionError extends Error {
    constructor() {
      super('permission-error');
    }
  },
}));

import { NextRequest } from 'next/server';
import { FakeFirestore } from '../../__tests__/helpers/fake-firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import * as serverPerms from '../permissions';
import type { PermissionKey } from '@/config/permissions.config';

const CUSTOM = 'custom_poster_team_lead';
const CHAPTER = 'seds-ist-chapter';
const HOLDER = 'holder-uid';

type UserScopedFn = (
  db: unknown,
  uid: string,
  permission: PermissionKey,
) => Promise<boolean>;
const hasServerPermissionForUser = (
  serverPerms as unknown as Record<string, unknown>
).hasServerPermissionForUser as UserScopedFn | undefined;

function request(): NextRequest {
  return new NextRequest('http://localhost/api/test', {
    headers: { authorization: 'Bearer test-token' },
  });
}

let fake: FakeFirestore;
beforeEach(() => {
  fake = new FakeFirestore();
  mockDbHolder.db = fake.asDb();
  mockClaimsHolder.extra = {};
  fake.seed('roleDefinitions', CUSTOM, {
    isCustom: true,
    parentRoleKey: 'chapter_design_chair',
    chapterId: CHAPTER,
    name: 'Poster Team Lead',
    permissions: ['canManageTasks'],
  });
  // SEC-11 shadow fixture.
  fake.seed('roleDefinitions', 'member_basic', {
    name: 'Basic Member',
    permissions: ['canManageTasks', 'canManageEvents', 'canManageUsers'],
  });
  fake.seed('roles', HOLDER, {
    role: 'member',
    additionalRoles: [CUSTOM],
    chapterId: CHAPTER,
  });
  fake.seed('users', HOLDER, { isBanned: false });
});

/** Every role token the AuthContext surfaces for permission checks. */
function surfacedTokens(user: Record<string, unknown>): string[] {
  const tokens: string[] = [];
  if (typeof user.role === 'string') tokens.push(user.role);
  for (const field of [
    'customRoles',
    'heldCustomRoles',
    'customRoleSlugs',
    'additionalRoles',
  ]) {
    const value = user[field];
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string') tokens.push(entry);
      }
    }
  }
  return tokens;
}

describe('verifyAuthentication - custom grant holder', () => {
  it('authenticates and carries the catalog primary as the auth role (K2)', async () => {
    const result = await verifyAuthentication(request());
    expect(result.authenticated).toBe(true);
    expect(result.user?.userId).toBe(HOLDER);
    expect(result.user?.role).toBe('member');
  });

  it('the auth path gives the SAME answer as the raw-token path', async () => {
    const result = await verifyAuthentication(request());
    expect(result.authenticated).toBe(true);
    const user = result.user as unknown as Record<string, unknown>;

    for (const key of ['canManageTasks', 'canManageEvents'] as PermissionKey[]) {
      const rawToken = await serverPerms.hasServerPermission(CUSTOM, key);
      let authPath: boolean;
      if (typeof hasServerPermissionForUser === 'function') {
        authPath = await hasServerPermissionForUser(fake.asDb(), HOLDER, key);
      } else {
        const tokens = surfacedTokens(user);
        if (!tokens.some((t) => t.startsWith('custom_'))) {
          throw new Error(
            'MISSING IMPLEMENTATION: verifyAuthentication surfaces no custom ' +
              'slugs and no user-scoped holder resolution exists (contracts ' +
              '4.4 / plan section 5) - the auth path still pre-floors the ' +
              'custom grant to the primary alone',
          );
        }
        authPath = false;
        for (const token of tokens) {
          if (await serverPerms.hasServerPermission(token, key)) authPath = true;
        }
      }
      expect(authPath).toBe(rawToken);
    }
    // And the agreed answer is the definition's answer, not the shadow's.
    await expect(serverPerms.hasServerPermission(CUSTOM, 'canManageTasks')).resolves.toBe(true);
    await expect(serverPerms.hasServerPermission(CUSTOM, 'canManageEvents')).resolves.toBe(false);
  });

  it('SEC-13: a forged claims.role is ignored - the role still resolves from Firestore', async () => {
    mockClaimsHolder.extra = { role: 'superadmin' };
    const result = await verifyAuthentication(request());
    expect(result.authenticated).toBe(true);
    expect(result.user?.role).toBe('member');
  });
});
