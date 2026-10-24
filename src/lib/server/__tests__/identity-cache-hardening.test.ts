/**
 * @jest-environment node
 *
 * Read-Burn A hardening, T-A8 (security review S2-5 / S2-7, design
 * plan §2.3 items 3-4, §2.4):
 *
 * (1) Explicit-`now` bypass (C-3): resolveHolderRoles and
 *     hasServerPermissionForUser called with an injected `now` (the
 *     `now?: Date` sentinel - any supplied Date is explicit) must
 *     NEVER read the identity cache and NEVER store into it. Expiry
 *     derivation runs against the supplied clock.
 * (2) `loadedAt` pin (C-3, second half): stored entries carry the
 *     real store-time Date.now(), never a caller-supplied / injected
 *     clock. A future-dated injected `now` must not make an entry
 *     immortal; a past-dated one must not make it instantly stale.
 * (3) Immutability (C-4): bundle values and permission-doc data are
 *     shared across requests from a module-scoped cache, so mutating
 *     a returned bundle's additionalRoles (or a returned
 *     permission-doc data object) must not affect subsequent reads.
 *
 * Firestore is the repo CountingFirestore fake only - zero real
 * Firestore access.
 */

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  admin: {
    auth: () => ({
      verifyIdToken: async (token: string) => {
        const uid = token.startsWith('tok:') ? token.slice(4) : token;
        return { uid, email: `${uid}@example.com`, email_verified: true, name: uid };
      },
    }),
    firestore: {
      FieldValue: {
        serverTimestamp: () => 'ts',
        increment: (n: number) => ({ __increment: n }),
        delete: () => ({ __delete: true }),
      },
    },
  },
}));
jest.mock('firebase/auth', () => ({ getAuth: jest.fn() }));
jest.mock('@/firebase', () => ({ getFirebaseApp: jest.fn() }));
jest.mock('@/firebase/error-emitter', () => ({ errorEmitter: { emit: jest.fn() } }));
jest.mock('@/firebase/errors', () => ({
  FirestorePermissionError: class FirestorePermissionError extends Error {
    constructor() { super('permission-error'); }
  },
}));

import { CountingFirestore } from './helpers/counting-firestore';
import {
  IDENTITY_TTL_MS,
  getIdentityBundle,
  getPermissionDoc,
  resetIdentityCache,
  type IdentityBundle,
} from '../identity-cache';
import * as serverPerms from '../permissions';

const CHAPTER = 'seds-ist-chapter';
const CUSTOM = 'custom_poster_team_lead';
/** Grant expiry instant: after the real clock (2026-10), before 2028. */
const EXPIRY_ISO = '2027-01-01T00:00:00.000Z';

let counting: CountingFirestore;
let db: never;

function seedHolder() {
  counting.seed('roles', 'holder-x', {
    role: 'member',
    additionalRoles: [CUSTOM],
    expiresAt: EXPIRY_ISO,
    expiresRoleKey: CUSTOM,
    chapterId: CHAPTER,
  });
  counting.seed('users', 'holder-x', { role: 'member', isBanned: false, chapterId: CHAPTER });
  counting.seed('roleDefinitions', CUSTOM, {
    isCustom: true, name: 'Poster Team Lead', permissions: ['canManageTasks'],
  });
  counting.seed('roleDefinitions', 'member_basic', { name: 'Basic Member', permissions: [] });
  counting.seed('roleDefinitions', 'member', { name: 'Member', permissions: [] });
}

beforeEach(() => {
  resetIdentityCache();
  counting = new CountingFirestore();
  mockDbHolder.db = counting.asDb();
  db = counting.asDb();
  seedHolder();
});

// ==================================================================
// T-A8 (1) - explicit-now bypass: resolveHolderRoles
// ==================================================================

describe('T-A8 explicit-now bypass - resolveHolderRoles', () => {
  it('an explicit-now call reads the store fresh, never the warm cache', async () => {
    const warm = await serverPerms.resolveHolderRoles(db, 'holder-x');
    expect(warm.role).toBe('member');
    expect(warm.customRoles).toEqual([CUSTOM]);

    // Out-of-band change (direct store mutation, NO bust): the cached
    // bundle still says member + custom grant.
    counting.seed('roles', 'holder-x', { role: 'chapter_president', additionalRoles: [], chapterId: CHAPTER });

    counting.resetCounts();
    const explicit = await serverPerms.resolveHolderRoles(db, 'holder-x', new Date());
    // Fresh store state, not the cached bundle...
    expect(explicit.role).toBe('chapter_president');
    expect(explicit.customRoles).toEqual([]);
    // ...proven by real doc gets during the explicit-now call.
    expect(counting.docGetCount('roles', 'holder-x')).toBeGreaterThanOrEqual(1);
    expect(counting.docGetCount('users', 'holder-x')).toBeGreaterThanOrEqual(1);
  });

  it('an explicit-now call never stores: the warm cache answer is unchanged afterwards', async () => {
    const warm = await serverPerms.resolveHolderRoles(db, 'holder-x');
    expect(warm.customRoles).toEqual([CUSTOM]);

    counting.seed('roles', 'holder-x', { role: 'chapter_president', additionalRoles: [], chapterId: CHAPTER });
    const explicit = await serverPerms.resolveHolderRoles(db, 'holder-x', new Date());
    expect(explicit.role).toBe('chapter_president');

    // A default (no-now) call still serves the previously cached
    // bundle - the synthetic-clock load did not populate/overwrite it.
    counting.resetCounts();
    const after = await serverPerms.resolveHolderRoles(db, 'holder-x');
    expect(after.role).toBe('member');
    expect(after.customRoles).toEqual([CUSTOM]);
    expect(counting.docGetCount('roles', 'holder-x')).toBe(0);
    expect(counting.docGetCount('users', 'holder-x')).toBe(0);
  });

  it('expiry derivation runs against the injected clock, in both directions', async () => {
    // Injected clock BEFORE the expiry instant: grant alive.
    const before = await serverPerms.resolveHolderRoles(db, 'holder-x', new Date('2026-06-01T00:00:00.000Z'));
    expect(before.customRoles).toEqual([CUSTOM]);
    // Injected clock AFTER the expiry instant: grant dead, even
    // though the real clock has not reached the expiry yet.
    const after = await serverPerms.resolveHolderRoles(db, 'holder-x', new Date('2028-01-01T00:00:00.000Z'));
    expect(after.customRoles).toEqual([]);
    // Neither synthetic evaluation polluted the cache: the default
    // (real-clock) answer still sees the live grant.
    const real = await serverPerms.resolveHolderRoles(db, 'holder-x');
    expect(real.customRoles).toEqual([CUSTOM]);
  });
});

// ==================================================================
// T-A8 (1) - explicit-now bypass: hasServerPermissionForUser
// ==================================================================

describe('T-A8 explicit-now bypass - hasServerPermissionForUser', () => {
  it('an explicit-now call resolves holder roles fresh; a default call afterwards still uses the cache', async () => {
    const warm = await serverPerms.hasServerPermissionForUser(db, 'holder-x', 'canManageTasks');
    expect(warm).toBe(true); // via the held custom grant

    // Out-of-band: the grant is removed from the store, no bust.
    counting.seed('roles', 'holder-x', { role: 'member', additionalRoles: [], chapterId: CHAPTER });

    counting.resetCounts();
    const explicit = await serverPerms.hasServerPermissionForUser(db, 'holder-x', 'canManageTasks', new Date());
    expect(explicit).toBe(false); // fresh holder state: no custom grant
    expect(counting.docGetCount('roles', 'holder-x')).toBeGreaterThanOrEqual(1);

    // The bypass load was not stored: the default path still answers
    // from the warm bundle (grant present) with zero identity reads.
    counting.resetCounts();
    const after = await serverPerms.hasServerPermissionForUser(db, 'holder-x', 'canManageTasks');
    expect(after).toBe(true);
    expect(counting.docGetCount('roles', 'holder-x')).toBe(0);
    expect(counting.docGetCount('users', 'holder-x')).toBe(0);
  });

  it('an explicit-now call in the future sees the grant as expired; the default call does not', async () => {
    const warm = await serverPerms.hasServerPermissionForUser(db, 'holder-x', 'canManageTasks');
    expect(warm).toBe(true);

    const future = await serverPerms.hasServerPermissionForUser(
      db, 'holder-x', 'canManageTasks', new Date('2028-01-01T00:00:00.000Z'),
    );
    expect(future).toBe(false);

    const after = await serverPerms.hasServerPermissionForUser(db, 'holder-x', 'canManageTasks');
    expect(after).toBe(true);
  });
});

// ==================================================================
// T-A8 (2) - loadedAt pin
// ==================================================================

describe('T-A8 loadedAt pin - stored entries carry real store-time, never the injected clock', () => {
  it('permission-doc cache: a future-dated injected `now` does not make the entry immortal', async () => {
    let loads = 0;
    const loader = async () => {
      loads++;
      return { exists: true, data: { permissions: [`perm-${loads}`] } };
    };
    const futureNow = Date.now() + 10 * 365 * 24 * 3600 * 1000;
    const first = await getPermissionDoc('permissions', 'pin_slug', loader, { now: futureNow });
    expect(first.data?.permissions).toEqual(['perm-1']);
    expect(loads).toBe(1);

    // Real store-time + TTL has passed (real clock comparison): the
    // entry must be reloaded. If the injected future `now` had been
    // stored as loadedAt, the age would be negative forever and this
    // read would hit the stale entry.
    const reloaded = await getPermissionDoc('permissions', 'pin_slug', loader, { now: Date.now() + IDENTITY_TTL_MS + 1_000 });
    expect(loads).toBe(2);
    expect(reloaded.data?.permissions).toEqual(['perm-2']);
  });

  it('permission-doc cache: a past-dated injected `now` does not make the entry instantly stale', async () => {
    let loads = 0;
    const loader = async () => {
      loads++;
      return { exists: true, data: { permissions: ['canManageTasks'] } };
    };
    await getPermissionDoc('roleDefinitions', 'pin_slug', loader, { now: 0 });
    expect(loads).toBe(1);

    // Immediately afterwards on the real clock the entry is fresh:
    // it was stored with the real store-time, not with `now: 0`.
    const warm = await getPermissionDoc('roleDefinitions', 'pin_slug', loader);
    expect(loads).toBe(1);
    expect(warm.data?.permissions).toEqual(['canManageTasks']);
  });

  it('identity bundle via permissions.ts: loadedAt is the real clock at load time', async () => {
    const before = Date.now();
    const bundle = await serverPerms.getIdentityBundleCached(db, 'holder-x');
    const after = Date.now();
    expect(bundle.loadedAt).toBeGreaterThanOrEqual(before);
    expect(bundle.loadedAt).toBeLessThanOrEqual(after);
  });

  it('identity cache unit level: a loader-supplied clock is never what expiry is measured from after a synthetic-clock read', async () => {
    // A read performed under an injected future comparison clock must
    // not extend the entry's life: once the REAL store-time + TTL has
    // passed, the entry reloads.
    const t0 = Date.now();
    let loads = 0;
    const loader = async (): Promise<IdentityBundle> => {
      loads++;
      return {
        roles: { exists: true, role: `role-${loads}`, additionalRoles: undefined, expiresAt: undefined, expiresRoleKey: undefined, chapterId: null },
        users: { exists: true, role: `role-${loads}`, displayRole: undefined, additionalRoles: undefined, isBanned: false, chapterId: null },
        loadedAt: Date.now(),
      };
    };
    const first = await getIdentityBundle('pin-user', loader, { now: t0 + 10 * 365 * 24 * 3600 * 1000 });
    expect(first.roles?.role).toBe('role-1');
    const reloaded = await getIdentityBundle('pin-user', loader, { now: t0 + IDENTITY_TTL_MS + 1_000 });
    expect(loads).toBe(2);
    expect(reloaded.roles?.role).toBe('role-2');
  });
});

// ==================================================================
// T-A8 (3) - immutability (C-4)
// ==================================================================

/** Mutation attempts must never throw OUT of the test: a frozen value
 * throws on mutation in strict mode, a copy absorbs it - both are
 * acceptable shapes; what matters is the next read is unaffected. */
function attemptMutation(fn: () => void): void {
  try { fn(); } catch { /* frozen - acceptable */ }
}

describe('T-A8 immutability - identity bundle', () => {
  it('mutating a returned bundle\'s additionalRoles does not affect subsequent reads (unit level)', async () => {
    const loader = async (): Promise<IdentityBundle> => ({
      roles: { exists: true, role: 'member', additionalRoles: [CUSTOM], expiresAt: undefined, expiresRoleKey: undefined, chapterId: null },
      users: { exists: true, role: 'member', displayRole: undefined, additionalRoles: [CUSTOM], isBanned: false, chapterId: null },
      loadedAt: Date.now(),
    });
    const first = await getIdentityBundle('immutable-user', loader);
    attemptMutation(() => { (first.roles!.additionalRoles as string[]).push('custom_evil'); });
    attemptMutation(() => { (first.users!.additionalRoles as string[]).push('custom_evil'); });
    attemptMutation(() => { first.users!.isBanned = true; });

    let reloads = 0;
    const second = await getIdentityBundle('immutable-user', async () => { reloads++; return loader(); });
    expect(reloads).toBe(0); // served from the cache...
    expect(second.roles?.additionalRoles).toEqual([CUSTOM]); // ...uncontaminated
    expect(second.users?.additionalRoles).toEqual([CUSTOM]);
    expect(second.users?.isBanned).toBe(false);
  });

  it('mutating a bundle obtained via permissions.ts does not change holder resolution or ban state', async () => {
    const bundle = await serverPerms.getIdentityBundleCached(db, 'holder-x');
    expect(bundle.roles?.additionalRoles).toEqual([CUSTOM]);
    attemptMutation(() => { (bundle.roles!.additionalRoles as string[]).push('custom_evil'); });
    attemptMutation(() => { (bundle.users!.additionalRoles as string[]).push('custom_evil'); });
    attemptMutation(() => { bundle.users!.isBanned = true; });

    const holder = await serverPerms.resolveHolderRoles(db, 'holder-x');
    expect(holder.customRoles).toEqual([CUSTOM]); // no custom_evil, grant intact

    const identity = await serverPerms.resolveIdentityForAuth(db, 'holder-x');
    expect(identity.isBanned).toBe(false);
    expect(identity.role).toBe('member');
  });

  it('mutating the array handed out by a derivation does not contaminate the cache', async () => {
    const holder = await serverPerms.resolveHolderRoles(db, 'holder-x');
    holder.customRoles.push('custom_evil');
    const again = await serverPerms.resolveHolderRoles(db, 'holder-x');
    expect(again.customRoles).toEqual([CUSTOM]);
  });
});

describe('T-A8 immutability - permission-doc data', () => {
  it('mutating a returned permission-doc data object does not affect subsequent reads (unit level)', async () => {
    const loader = async () => ({ exists: true, data: { permissions: ['canManageTasks'] } });
    const first = await getPermissionDoc('roleDefinitions', 'immutable_slug', loader);
    attemptMutation(() => { (first.data!.permissions as string[]).push('canManageUsers'); });
    attemptMutation(() => { first.data!.canManageUsers = true; });

    let reloads = 0;
    const second = await getPermissionDoc('roleDefinitions', 'immutable_slug', async () => { reloads++; return loader(); });
    expect(reloads).toBe(0);
    expect(second.data?.permissions).toEqual(['canManageTasks']);
    expect(second.data?.canManageUsers).toBeUndefined();
  });

  it('mutating permission-doc data obtained through the cache does not change hasServerPermission answers', async () => {
    counting.seed('roleDefinitions', 'chapter_president', {
      name: 'Chapter President', permissions: ['canManageTasks'],
    });
    const before = await serverPerms.hasServerPermission('chapter_president', 'canManageUsers');
    expect(before).toBe(false);

    // Reach the SAME cached entry the permission check reads (same
    // scope partition: hasServerPermission scopes by its getDb()).
    const entry = await getPermissionDoc(
      'roleDefinitions', 'chapter_president',
      async () => { throw new Error('loader must not run - entry is cached'); },
      { scope: mockDbHolder.db },
    );
    expect(entry.exists).toBe(true);
    attemptMutation(() => { (entry.data!.permissions as string[]).push('canManageUsers'); });
    attemptMutation(() => { entry.data!.canManageUsers = true; });

    const after = await serverPerms.hasServerPermission('chapter_president', 'canManageUsers');
    expect(after).toBe(false);
    const stillGranted = await serverPerms.hasServerPermission('chapter_president', 'canManageTasks');
    expect(stillGranted).toBe(true);
  });
});
