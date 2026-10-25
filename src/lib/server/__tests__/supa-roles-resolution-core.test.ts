/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION — ROLES+PERMISSIONS cluster contract tests (group 1:
 * resolution core). Written against the CURRENT base tree
 * (feat/integration-wave3 @ 4d5a1e16) with Firestore mocked; ZERO live reads.
 *
 * These contracts must survive the migration byte-for-byte: when the
 * implementer branches (feat/supa-roles-1..4) route the same reads through
 * src/lib/supa behind useSupa('roles'), every answer below must be identical
 * flag-OFF, flag-ON (Supabase mocked) and flag-ON-with-Supabase-error
 * (Firestore fallback). The flag-state matrix lives in the companion suite
 * supa-roles-flag-states.test.ts.
 *
 * Sources pinned:
 * - src/lib/server/permissions.ts: hasServerPermission walk order
 *   (roleDefinitions tier BEFORE permissions tier, first existing doc wins,
 *   winning array is authoritative), blanket slugs, custom-subject rules.
 * - loadIdentityBundle projection shape (via getIdentityBundleCached):
 *   roles {exists, role, additionalRoles, expiresAt, expiresRoleKey,
 *   chapterId}, users {exists, role, displayRole, additionalRoles,
 *   isBanned, chapterId}, loadedAt.
 * - src/lib/server/identity-cache.ts: IDENTITY_TTL_MS = 30_000, cold/warm,
 *   in-flight dedupe, errors never cached, exists:false IS cached.
 */

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  admin: {
    firestore: {
      FieldValue: { serverTimestamp: () => 'ts', delete: () => 'del' },
    },
  },
}));

import {
  hasServerPermission,
  hasServerPermissionForUser,
  resolveCanonicalRole,
  resolveHolderRoles,
  resolveIdentityForAuth,
  resolveUserRole,
  getIdentityBundleCached,
  isChapterScopedRole,
} from '../permissions';
import {
  getIdentityBundle,
  getPermissionDoc,
  bustIdentity,
  resetIdentityCache,
  IDENTITY_TTL_MS,
  type IdentityBundle,
} from '../identity-cache';

// ---------------------------------------------------------------------------
// Counting in-memory Firestore fake (doc gets only — the core's read surface)
// ---------------------------------------------------------------------------

type DocData = Record<string, unknown>;

class CountingDb {
  store = new Map<string, Map<string, DocData>>();
  counts = new Map<string, number>();
  throwOnGet = false;

  seed(col: string, id: string, data: DocData) {
    if (!this.store.has(col)) this.store.set(col, new Map());
    this.store.get(col)!.set(id, { ...data });
  }
  docGets(col?: string, id?: string): number {
    if (col && id) return this.counts.get(`${col}/${id}`) ?? 0;
    let n = 0;
    for (const [k, v] of this.counts) if (!col || k.startsWith(`${col}/`)) n += v;
    return n;
  }
  collection(name: string) {
    const self = this;
    return {
      doc: (id: string) => ({
        get: async () => {
          self.counts.set(`${name}/${id}`, (self.counts.get(`${name}/${id}`) ?? 0) + 1);
          if (self.throwOnGet) throw new Error('RESOURCE_EXHAUSTED: fake');
          const data = self.store.get(name)?.get(id);
          return {
            exists: data !== undefined,
            id,
            data: () => (data ? { ...data } : undefined),
          };
        },
      }),
    };
  }
}

let fake: CountingDb;
const db = () => fake as never;

beforeEach(() => {
  resetIdentityCache();
  fake = new CountingDb();
  mockDbHolder.db = fake;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const CUSTOM = 'custom_poster_team_lead';
const CHAPTER = 'seds-ist-chapter';

// ---------------------------------------------------------------------------
// loadIdentityBundle shape (group 1 deliverable 2)
// ---------------------------------------------------------------------------

describe('loadIdentityBundle shape (via getIdentityBundleCached)', () => {
  it('projects exactly the field-scoped bundle shape', async () => {
    fake.seed('roles', 'u1', {
      role: 'chapter_president',
      additionalRoles: ['chapter_events_chair'],
      expiresAt: '2030-01-01T00:00:00.000Z',
      expiresRoleKey: 'chapter_events_chair',
      chapterId: CHAPTER,
      secretField: 'must-not-project',
    });
    fake.seed('users', 'u1', {
      role: 'member',
      displayRole: 'Member',
      additionalRoles: [],
      isBanned: true,
      chapterId: CHAPTER,
      email: 'must-not-project@example.com',
    });
    const bundle = await getIdentityBundleCached(db(), 'u1');
    expect(Object.keys(bundle).sort()).toEqual(['loadedAt', 'roles', 'users']);
    expect(typeof bundle.loadedAt).toBe('number');
    expect(bundle.roles).toEqual({
      exists: true,
      role: 'chapter_president',
      additionalRoles: ['chapter_events_chair'],
      expiresAt: '2030-01-01T00:00:00.000Z',
      expiresRoleKey: 'chapter_events_chair',
      chapterId: CHAPTER,
    });
    expect(bundle.users).toEqual({
      exists: true,
      role: 'member',
      displayRole: 'Member',
      additionalRoles: [],
      isBanned: true,
      chapterId: CHAPTER,
    });
    // One parallel load: exactly one get per identity doc.
    expect(fake.docGets('roles', 'u1')).toBe(1);
    expect(fake.docGets('users', 'u1')).toBe(1);
  });

  it('missing docs project exists:false; isBanned is true only for === true', async () => {
    fake.seed('users', 'u2', { role: 'member', isBanned: 'yes' });
    const bundle = await getIdentityBundleCached(db(), 'u2');
    expect(bundle.roles?.exists).toBe(false);
    expect(bundle.roles?.role).toBeUndefined();
    expect(bundle.users?.exists).toBe(true);
    expect(bundle.users?.isBanned).toBe(false);
  });

  it('the cached bundle is frozen and additionalRoles is not the snapshot array', async () => {
    const held = ['chapter_events_chair'];
    fake.seed('roles', 'u3', { role: 'member', additionalRoles: held });
    fake.seed('users', 'u3', {});
    const bundle = await getIdentityBundleCached(db(), 'u3');
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.roles)).toBe(true);
    expect(bundle.roles?.additionalRoles).not.toBe(held);
    expect(bundle.roles?.additionalRoles).toEqual(held);
  });
});

// ---------------------------------------------------------------------------
// resolveCanonicalRole / resolveIdentityForAuth / resolveHolderRoles
// ---------------------------------------------------------------------------

describe('canonical role resolution', () => {
  it('roles/{uid} is the source of truth over the users mirror', async () => {
    fake.seed('roles', 'u1', { role: 'chapter_president' });
    fake.seed('users', 'u1', { role: 'member' });
    await expect(resolveCanonicalRole(db(), 'u1')).resolves.toBe('chapter_president');
  });

  it('falls back to users.role, then users.displayRole, only when roles primary is missing/blank', async () => {
    fake.seed('users', 'a', { role: 'chair_events' });
    await expect(resolveCanonicalRole(db(), 'a')).resolves.toBe('chapter_events_chair');
    fake.seed('users', 'b', { displayRole: 'chair_events' });
    await expect(resolveCanonicalRole(db(), 'b')).resolves.toBe('chapter_events_chair');
    fake.seed('roles', 'c', { role: '   ' });
    fake.seed('users', 'c', { role: 'member' });
    await expect(resolveCanonicalRole(db(), 'c')).resolves.toBe('member');
  });

  it('empty uid resolves guest; no docs at all resolves guest via empty record', async () => {
    await expect(resolveCanonicalRole(db(), '')).resolves.toBe('guest');
    expect(fake.docGets()).toBe(0);
    await expect(resolveHolderRoles(db(), '')).resolves.toEqual({ role: 'guest', customRoles: [] });
  });

  it('a stored custom primary is returned verbatim (never floored to member_basic)', async () => {
    fake.seed('roles', 'u1', { role: CUSTOM });
    fake.seed('users', 'u1', {});
    await expect(resolveCanonicalRole(db(), 'u1')).resolves.toBe(CUSTOM);
  });

  it('resolveIdentityForAuth derives role and ban from the same single bundle load', async () => {
    fake.seed('roles', 'u1', { role: 'member' });
    fake.seed('users', 'u1', { isBanned: true });
    await expect(resolveIdentityForAuth(db(), 'u1')).resolves.toEqual({
      role: 'member',
      isBanned: true,
    });
    expect(fake.docGets('roles', 'u1') + fake.docGets('users', 'u1')).toBe(2);
    // Warm: a second derivation in the TTL window reads nothing.
    await resolveIdentityForAuth(db(), 'u1');
    expect(fake.docGets('roles', 'u1') + fake.docGets('users', 'u1')).toBe(2);
  });

  it('resolveUserRole: 1-arg (string) shape stays deny-all null; db shape delegates', async () => {
    await expect(resolveUserRole('u1' as never)).resolves.toBeNull();
    fake.seed('roles', 'u1', { role: 'member' });
    fake.seed('users', 'u1', {});
    await expect(resolveUserRole(db(), 'u1')).resolves.toBe('member');
    await expect(resolveUserRole(db(), '')).resolves.toBeNull();
  });

  it('resolveHolderRoles: custom grants come only from additionalRoles; expired grant contributes nothing', async () => {
    const past = new Date(Date.now() - 60_000);
    fake.seed('roles', 'u1', {
      role: 'member',
      additionalRoles: [CUSTOM, 'chapter_events_chair', 42],
      expiresAt: past,
      expiresRoleKey: CUSTOM,
    });
    fake.seed('users', 'u1', {});
    // Explicit caller clock bypasses the cache (now sentinel).
    const resolved = await resolveHolderRoles(db(), 'u1', new Date());
    expect(resolved.role).toBe('member');
    expect(resolved.customRoles).toEqual([]);
    // Without the expiry fields the same grant is live.
    fake.seed('roles', 'u2', { role: 'member', additionalRoles: [CUSTOM] });
    fake.seed('users', 'u2', {});
    await expect(resolveHolderRoles(db(), 'u2', new Date())).resolves.toEqual({
      role: 'member',
      customRoles: [CUSTOM],
    });
  });

  it('isChapterScopedRole: global set bypasses; unknown/null default to scoped', () => {
    expect(isChapterScopedRole('founder_patron')).toBe(false);
    expect(isChapterScopedRole('president_national')).toBe(false);
    expect(isChapterScopedRole('member')).toBe(true);
    expect(isChapterScopedRole(null)).toBe(true);
    expect(isChapterScopedRole(undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasServerPermission — walk order and per-fixture outcomes
// ---------------------------------------------------------------------------

describe('hasServerPermission walk order', () => {
  it('null / undefined / empty role is false with zero doc reads', async () => {
    await expect(hasServerPermission(null, 'canManageTasks')).resolves.toBe(false);
    await expect(hasServerPermission(undefined, 'canManageTasks')).resolves.toBe(false);
    await expect(hasServerPermission('', 'canManageTasks')).resolves.toBe(false);
    expect(fake.docGets()).toBe(0);
  });

  it('superadmin and founder_patron blanket-true BEFORE any doc read', async () => {
    await expect(hasServerPermission('superadmin', 'canManagePermissions')).resolves.toBe(true);
    await expect(hasServerPermission('founder_patron', 'canManageRoles')).resolves.toBe(true);
    expect(fake.docGets()).toBe(0);
  });

  it('roleDefinitions BEFORE permissions: the winning definition array is authoritative (no fallthrough)', async () => {
    fake.seed('roleDefinitions', 'chapter_president', { permissions: ['canManageTasks'] });
    fake.seed('permissions', 'chapter_president', { canManageTasks: false, canManageEvents: true });
    await expect(hasServerPermission('chapter_president', 'canManageTasks')).resolves.toBe(true);
    // The permissions doc grants it, the winning definition array does not:
    // the array wins and the answer is false.
    await expect(hasServerPermission('chapter_president', 'canManageEvents')).resolves.toBe(false);
  });

  it('a definition doc boolean is consulted ONLY alongside an array; without an array it falls through', async () => {
    // Code pin (permissions.ts roleDefinitions tier): the boolean-field
    // check lives INSIDE the Array.isArray(data.permissions) branch, so a
    // doc carrying a boolean but no array does not answer from it.
    fake.seed('roleDefinitions', 'chapter_president', {
      permissions: ['canManageEvents'],
      canManageTasks: true,
      canManageEvents: false,
    });
    // Array present: boolean field breaks the array miss -> true.
    await expect(hasServerPermission('chapter_president', 'canManageTasks')).resolves.toBe(true);
    // Array hit wins over the contradicting boolean field.
    await expect(hasServerPermission('chapter_president', 'canManageEvents')).resolves.toBe(true);
    // No array at all: the boolean is invisible; permissions tier/static decide.
    resetIdentityCache();
    fake.store.delete('roleDefinitions');
    fake.seed('roleDefinitions', 'chapter_president', { canManageTasks: true });
    await expect(hasServerPermission('chapter_president', 'canManageTasks')).resolves.toBe(false);
  });

  it('a definition doc without array/boolean falls through to the permissions tier', async () => {
    fake.seed('roleDefinitions', 'chapter_president', { name: 'Chapter President' });
    fake.seed('permissions', 'chapter_president', { canManageTasks: true });
    await expect(hasServerPermission('chapter_president', 'canManageTasks')).resolves.toBe(true);
    await expect(hasServerPermission('chapter_president', 'canManageEvents')).resolves.toBe(false);
  });

  it('first hit wins across candidates: canonical doc precedes the legacy-token doc', async () => {
    // chair_events -> canonical chapter_events_chair; the legacy token's
    // docs are reverse-expanded candidates AFTER the canonical slug.
    fake.seed('roleDefinitions', 'chapter_events_chair', { permissions: ['canManageEvents'] });
    fake.seed('roleDefinitions', 'chair_events', { permissions: ['canManageTasks'] });
    await expect(hasServerPermission('chair_events', 'canManageEvents')).resolves.toBe(true);
    await expect(hasServerPermission('chair_events', 'canManageTasks')).resolves.toBe(false);
    // Same order in the permissions tier.
    resetIdentityCache();
    fake.store.delete('roleDefinitions');
    fake.seed('permissions', 'chapter_events_chair', { canManageTasks: false });
    fake.seed('permissions', 'chair_events', { canManageTasks: true });
    await expect(hasServerPermission('chair_events', 'canManageTasks')).resolves.toBe(false);
  });

  it('static config is the last fallback when no doc exists in either tier', async () => {
    await expect(hasServerPermission('returning_officer', 'canRunElections')).resolves.toBe(true);
    await expect(hasServerPermission('returning_officer', 'canManageTasks')).resolves.toBe(false);
    await expect(hasServerPermission('national_general_secretary', 'canManageAgm')).resolves.toBe(true);
    await expect(hasServerPermission('member', 'canManageTasks')).resolves.toBe(false);
  });

  it('no db (getDb null) falls back to the static config map', async () => {
    mockDbHolder.db = null;
    await expect(hasServerPermission('returning_officer', 'canRunElections')).resolves.toBe(true);
    await expect(hasServerPermission('member', 'canRunElections')).resolves.toBe(false);
  });

  it('a throwing Firestore get falls back to static config and is never cached as exists:false', async () => {
    fake.throwOnGet = true;
    await expect(hasServerPermission('returning_officer', 'canRunElections')).resolves.toBe(true);
    await expect(hasServerPermission('chapter_president', 'canManageTasks')).resolves.toBe(false);
    // Recovery: once reads succeed, the real doc answer appears (the throw
    // left no cached {exists:false} behind to shadow it).
    fake.throwOnGet = false;
    fake.seed('roleDefinitions', 'chapter_president', { permissions: ['canManageTasks'] });
    await expect(hasServerPermission('chapter_president', 'canManageTasks')).resolves.toBe(true);
  });
});

describe('hasServerPermission — custom subjects', () => {
  it('missing custom definition is deny-by-absence, even when member_basic grants the key', async () => {
    fake.seed('roleDefinitions', 'member_basic', { permissions: ['canManageTasks'] });
    await expect(hasServerPermission(CUSTOM, 'canManageTasks')).resolves.toBe(false);
  });

  it('reserved keys are stripped for custom subjects even if the definition array lists them', async () => {
    fake.seed('roleDefinitions', CUSTOM, {
      permissions: ['canManageTasks', 'canManageRoles', 'canManagePermissions'],
    });
    await expect(hasServerPermission(CUSTOM, 'canManageTasks')).resolves.toBe(true);
    await expect(hasServerPermission(CUSTOM, 'canManageRoles')).resolves.toBe(false);
    await expect(hasServerPermission(CUSTOM, 'canManagePermissions')).resolves.toBe(false);
  });

  it('the superadmin blanket never widens to a custom slug', async () => {
    fake.seed('roleDefinitions', CUSTOM, { permissions: [] });
    await expect(hasServerPermission(CUSTOM, 'canAccessAdmin')).resolves.toBe(false);
  });
});

describe('hasServerPermissionForUser — holder union', () => {
  it('unions the primary answer with held custom grants', async () => {
    fake.seed('roles', 'holder', { role: 'member', additionalRoles: [CUSTOM] });
    fake.seed('users', 'holder', {});
    fake.seed('roleDefinitions', CUSTOM, { permissions: ['canManageTasks'] });
    await expect(hasServerPermissionForUser(db(), 'holder', 'canManageTasks')).resolves.toBe(true);
    await expect(hasServerPermissionForUser(db(), 'holder', 'canManageEvents')).resolves.toBe(false);
    await expect(hasServerPermissionForUser(db(), '', 'canManageTasks')).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// identity-cache behavior (30s TTL, cold/warm, dedupe, errors never cached)
// ---------------------------------------------------------------------------

describe('identity cache', () => {
  const bundle = (loadedAt: number, banned = false): IdentityBundle => ({
    roles: { exists: true, role: 'member', additionalRoles: [], expiresAt: undefined, expiresRoleKey: undefined, chapterId: CHAPTER },
    users: { exists: true, role: 'member', displayRole: undefined, additionalRoles: [], isBanned: banned, chapterId: CHAPTER },
    loadedAt,
  });

  it('pins the program-wide TTL at 30_000ms', () => {
    expect(IDENTITY_TTL_MS).toBe(30_000);
  });

  it('cold loads once, warm (inside TTL) loads zero, expiry reloads', async () => {
    const scope = {};
    let calls = 0;
    const t0 = 5_000_000;
    const loader = async () => bundle(t0 + calls++ * 31_000);
    const cold = await getIdentityBundle('u', loader, { scope, now: t0 });
    expect(calls).toBe(1);
    const warm = await getIdentityBundle('u', loader, { scope, now: t0 + 29_999 });
    expect(calls).toBe(1);
    expect(warm).toBe(cold);
    await getIdentityBundle('u', loader, { scope, now: t0 + 30_000 });
    expect(calls).toBe(2);
  });

  it('concurrent loads for one uid share a single in-flight loader run', async () => {
    const scope = {};
    let calls = 0;
    let release!: (b: IdentityBundle) => void;
    const gate = new Promise<IdentityBundle>((r) => { release = r; });
    const loader = () => { calls++; return gate; };
    const p1 = getIdentityBundle('u', loader, { scope });
    const p2 = getIdentityBundle('u', loader, { scope });
    expect(p1).toBe(p2);
    release(bundle(Date.now()));
    await expect(p1).resolves.toBe(await p2);
    expect(calls).toBe(1);
  });

  it('loader errors are never cached: the next call retries the loader', async () => {
    const scope = {};
    let calls = 0;
    const loader = async () => {
      calls++;
      if (calls === 1) throw new Error('RESOURCE_EXHAUSTED: fake');
      return bundle(Date.now());
    };
    await expect(getIdentityBundle('u', loader, { scope })).rejects.toThrow('RESOURCE_EXHAUSTED');
    await expect(getIdentityBundle('u', loader, { scope })).resolves.toBeTruthy();
    expect(calls).toBe(2);
  });

  it('a throwing permission-doc get is never converted into a cached exists:false', async () => {
    const scope = {};
    let calls = 0;
    const loader = async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return { exists: true, data: { canManageTasks: true } };
    };
    await expect(getPermissionDoc('permissions', 'x', loader, { scope })).rejects.toThrow('boom');
    await expect(getPermissionDoc('permissions', 'x', loader, { scope })).resolves.toEqual({
      exists: true,
      data: { canManageTasks: true },
    });
    expect(calls).toBe(2);
  });

  it('a successful exists:false permission doc IS cached within the TTL', async () => {
    const scope = {};
    let calls = 0;
    const loader = async () => { calls++; return { exists: false, data: undefined }; };
    await getPermissionDoc('roleDefinitions', 'nope', loader, { scope });
    await getPermissionDoc('roleDefinitions', 'nope', loader, { scope });
    expect(calls).toBe(1);
  });

  it('bustIdentity forces a reload for that uid only', async () => {
    const scope = {};
    let calls = 0;
    const loader = async () => { calls++; return bundle(Date.now()); };
    await getIdentityBundle('u', loader, { scope });
    bustIdentity('other');
    await getIdentityBundle('u', loader, { scope });
    expect(calls).toBe(1);
    bustIdentity('u');
    await getIdentityBundle('u', loader, { scope });
    expect(calls).toBe(2);
  });

  it('permission-doc answers are cached across hasServerPermission calls (warm = 0 doc gets)', async () => {
    fake.seed('roleDefinitions', 'chapter_president', { permissions: ['canManageTasks'] });
    await hasServerPermission('chapter_president', 'canManageTasks');
    const afterCold = fake.docGets();
    expect(afterCold).toBeGreaterThan(0);
    await hasServerPermission('chapter_president', 'canManageTasks');
    expect(fake.docGets()).toBe(afterCold);
  });
});
