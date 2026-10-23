/**
 * @jest-environment node
 *
 * PERM-RESOLUTION (Custom Roles Fix Program) - one permission answer.
 *
 * Contract sources:
 * - globals/contracts.md Section 4.4 (BINDING): when the role token under
 *   check slug-normalises to a custom_ slug, the candidate list is
 *   [customSlug, ...today's candidates] and the custom slug is tried FIRST
 *   in both store reads; its roleDefinitions permissions array is
 *   authoritative; the member_basic floor must NEVER precede a custom slug;
 *   an expired custom grant contributes NOTHING; verifyAuthentication must
 *   not pre-floor a custom slug.
 * - items/perm-resolution/plan.md section 4 (T1-T12) and section 2
 *   (R1-R6), reconciled with contracts K2 (custom roles live ONLY in
 *   additionalRoles; the primary slot always holds a catalog key).
 * - Security review SEC-03 point 4 (resolution-time reserved-key strip),
 *   SEC-04 (the 'superadmin' blanket-true must not widen to custom slugs),
 *   SEC-11 (member_basic shadowing), SEC-13 (claims are never an
 *   authorization input - pinned in the companion auth suite).
 *
 * Holder-level answers (a custom grant sits in additionalRoles per K2) are
 * exercised through the user-scoped entry point the plan's section 5
 * names: hasServerPermissionForUser(db, uid, permission), which loads
 * roles/{uid} once and returns the UNION of per-subject answers. If that
 * export does not exist yet, those tests fail with an explicit
 * MISSING IMPLEMENTATION marker (see test-status.md).
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

import { FakeFirestore } from '../../__tests__/helpers/fake-firestore';
import * as serverPerms from '../permissions';
import type { PermissionKey } from '@/config/permissions.config';

const hasServerPermission = serverPerms.hasServerPermission;
const resolveCanonicalRole = serverPerms.resolveCanonicalRole;
type UserScopedFn = (
  db: unknown,
  uid: string,
  permission: PermissionKey,
) => Promise<boolean>;
const hasServerPermissionForUser = (
  serverPerms as unknown as Record<string, unknown>
).hasServerPermissionForUser as UserScopedFn | undefined;

const CUSTOM = 'custom_poster_team_lead';
const CHAPTER = 'seds-ist-chapter';
const HOLDER = 'holder-uid';

const ALL_KEYS: PermissionKey[] = [
  'canAccessAdmin',
  'canManageTasks',
  'canManageEvents',
  'canManageUsers',
  'canManageRoles',
  'canManagePermissions',
];

function customDef(permissions: string[], extra: Record<string, unknown> = {}) {
  return {
    isCustom: true,
    parentRoleKey: 'chapter_design_chair',
    chapterId: CHAPTER,
    name: 'Poster Team Lead',
    label: 'Poster Team Lead',
    permissions,
    ...extra,
  };
}

/** The SEC-11 hazard fixture: a member_basic definition WITH an array. */
function seedMemberBasicShadow(fake: FakeFirestore) {
  fake.seed('roleDefinitions', 'member_basic', {
    name: 'Basic Member',
    permissions: ['canManageTasks', 'canManageEvents', 'canManageUsers'],
  });
}

function tsLike(d: Date) {
  return {
    seconds: Math.floor(d.getTime() / 1000),
    nanoseconds: 0,
    toDate: () => d,
    toMillis: () => d.getTime(),
  };
}

let fake: FakeFirestore;
beforeEach(() => {
  fake = new FakeFirestore();
  mockDbHolder.db = fake.asDb();
});

// ---------------------------------------------------------------------------
// hasServerPermission - custom subject (plan T1-T6)
// ---------------------------------------------------------------------------

describe('hasServerPermission - custom subject', () => {
  it('T1: the custom definition array is authoritative for its own slug', async () => {
    fake.seed('roleDefinitions', CUSTOM, customDef(['canManageTasks']));
    await expect(hasServerPermission(CUSTOM, 'canManageTasks')).resolves.toBe(true);
    // A key absent from the array is denied - no fallthrough to floor/static.
    await expect(hasServerPermission(CUSTOM, 'canManageEvents')).resolves.toBe(false);
  });

  it('T2 (SEC-11): a member_basic definition WITH an array cannot shadow the custom doc', async () => {
    fake.seed('roleDefinitions', CUSTOM, customDef(['canManageEvents']));
    seedMemberBasicShadow(fake);
    // The custom doc wins outright: its own grant resolves true...
    await expect(hasServerPermission(CUSTOM, 'canManageEvents')).resolves.toBe(true);
    // ...and the floor doc's grants never bleed into the custom subject.
    await expect(hasServerPermission(CUSTOM, 'canManageTasks')).resolves.toBe(false);
    await expect(hasServerPermission(CUSTOM, 'canManageUsers')).resolves.toBe(false);
  });

  it('T3: fallthrough to the permissions collection keeps the custom slug first', async () => {
    // Definition exists but carries NO permissions array.
    const defNoArray = customDef([]);
    delete (defNoArray as Record<string, unknown>).permissions;
    fake.seed('roleDefinitions', CUSTOM, defNoArray);
    fake.seed('permissions', CUSTOM, { canManageTasks: true });
    fake.seed('permissions', 'member_basic', { canManageEvents: true });
    await expect(hasServerPermission(CUSTOM, 'canManageTasks')).resolves.toBe(true);
    // The custom boolean map wins the ordered step-2 walk; the floor map's
    // extra grants do not leak in once the custom doc answered.
    await expect(hasServerPermission(CUSTOM, 'canManageEvents')).resolves.toBe(false);
  });

  it('T4 (SEC-03 point 4): reserved keys are stripped at resolution for custom subjects', async () => {
    fake.seed(
      'roleDefinitions',
      CUSTOM,
      customDef(['canManageRoles', 'canManagePermissions', 'canManageTasks']),
    );
    await expect(hasServerPermission(CUSTOM, 'canManageRoles')).resolves.toBe(false);
    await expect(hasServerPermission(CUSTOM, 'canManagePermissions')).resolves.toBe(false);
    // A non-reserved key in the same poisoned array still resolves.
    await expect(hasServerPermission(CUSTOM, 'canManageTasks')).resolves.toBe(true);
  });

  it('T4b (SEC-03 point 4): reserved keys are stripped even via the boolean-map tier', async () => {
    const defNoArray = customDef([]);
    delete (defNoArray as Record<string, unknown>).permissions;
    fake.seed('roleDefinitions', CUSTOM, defNoArray);
    fake.seed('permissions', CUSTOM, { canManageRoles: true, canManageTasks: true });
    await expect(hasServerPermission(CUSTOM, 'canManageRoles')).resolves.toBe(false);
    await expect(hasServerPermission(CUSTOM, 'canManageTasks')).resolves.toBe(true);
  });

  it('T5 (SEC-04): no superadmin widening for a custom subject, even under a CTO parent', async () => {
    fake.seed(
      'roleDefinitions',
      CUSTOM,
      customDef([], { parentRoleKey: 'chief_technology_officer' }),
    );
    seedMemberBasicShadow(fake);
    // Empty grant array + CTO parent must NOT reach the 'superadmin'
    // blanket-true through reverse expansion or any other candidate.
    for (const key of ALL_KEYS) {
      await expect(hasServerPermission(CUSTOM, key)).resolves.toBe(false);
    }
  });

  it('T6: deny by default - no custom definition, floor doc grants nothing to the custom subject', async () => {
    seedMemberBasicShadow(fake);
    for (const key of ALL_KEYS) {
      await expect(hasServerPermission(CUSTOM, key)).resolves.toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveCanonicalRole - characterisation (plan T7; must hold before AND
// after the fix: contracts K2 keeps the primary slot catalog-only, and this
// function's catalog/legacy/floor behaviour is pinned by section 3 item 5
// of the plan as deliberately unchanged)
// ---------------------------------------------------------------------------

describe('resolveCanonicalRole - unchanged behaviour', () => {
  it('T7a: a stored legacy token resolves to its catalog target', async () => {
    fake.seed('roles', HOLDER, { role: 'chair_events' });
    await expect(resolveCanonicalRole(fake.asDb(), HOLDER)).resolves.toBe(
      'chapter_events_chair',
    );
  });

  it('T7b: a stored catalog token returns itself', async () => {
    fake.seed('roles', HOLDER, { role: 'chapter_president' });
    await expect(resolveCanonicalRole(fake.asDb(), HOLDER)).resolves.toBe(
      'chapter_president',
    );
  });

  it('T7c: an unknown token floors to member_basic', async () => {
    fake.seed('roles', HOLDER, { role: 'banana' });
    await expect(resolveCanonicalRole(fake.asDb(), HOLDER)).resolves.toBe('member_basic');
  });

  it('T7d: the users-mirror fallback resolves when the roles doc is missing', async () => {
    fake.seed('users', HOLDER, { role: 'chair_events' });
    await expect(resolveCanonicalRole(fake.asDb(), HOLDER)).resolves.toBe(
      'chapter_events_chair',
    );
  });

  it('T7e (K2): a catalog primary is returned verbatim when custom grants sit in additionalRoles', async () => {
    fake.seed('roles', HOLDER, { role: 'member', additionalRoles: [CUSTOM] });
    await expect(resolveCanonicalRole(fake.asDb(), HOLDER)).resolves.toBe('member');
  });
});

// ---------------------------------------------------------------------------
// hasServerPermission - unchanged behaviour for catalog/legacy subjects
// (plan T8-T10; characterisation: these pass on unmodified code too)
// ---------------------------------------------------------------------------

describe('hasServerPermission - catalog/legacy subjects unchanged', () => {
  it('T8: grants keyed under a legacy slug resolve for the canonical token and the raw legacy token', async () => {
    fake.seed('roleDefinitions', 'chair_events', { permissions: ['canManageEvents'] });
    await expect(
      hasServerPermission('chapter_events_chair', 'canManageEvents'),
    ).resolves.toBe(true);
    await expect(hasServerPermission('chair_events', 'canManageEvents')).resolves.toBe(true);
    await expect(
      hasServerPermission('chapter_events_chair', 'canManageTasks'),
    ).resolves.toBe(false);
  });

  it('T9: the 2026-10-22 incident shape - CTO still resolves via the intact reverse expansion', async () => {
    // No grant docs at all: chief_technology_officer must still reach the
    // 'superadmin' candidate through LEGACY_TO_CATALOG reverse expansion.
    await expect(
      hasServerPermission('chief_technology_officer', 'canManageTasks'),
    ).resolves.toBe(true);
  });

  it('T10a: a catalog definition array is authoritative', async () => {
    fake.seed('roleDefinitions', 'chapter_events_chair', {
      permissions: ['canManageEvents'],
    });
    await expect(
      hasServerPermission('chapter_events_chair', 'canManageEvents'),
    ).resolves.toBe(true);
    await expect(
      hasServerPermission('chapter_events_chair', 'canManageTasks'),
    ).resolves.toBe(false);
  });

  it('T10b: a catalog definition without an array falls through to the permissions collection', async () => {
    fake.seed('roleDefinitions', 'chapter_events_chair', { name: 'Chair Events' });
    fake.seed('permissions', 'chapter_events_chair', { canManageTasks: true });
    await expect(
      hasServerPermission('chapter_events_chair', 'canManageTasks'),
    ).resolves.toBe(true);
  });

  it('T10c: static fallback still denies a plain member with no grant docs', async () => {
    await expect(hasServerPermission('member', 'canManageTasks')).resolves.toBe(false);
    await expect(hasServerPermission('member_basic', 'canManageTasks')).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Holder-level answers - the user-scoped union (plan section 5, adopted by
// contracts K2 + Section 4.4). A custom grant lives in additionalRoles; the
// holder's answer is the union of the primary's answer and each held,
// unexpired custom grant's answer.
// ---------------------------------------------------------------------------

describe('hasServerPermissionForUser - holder-level union of primary + custom grants', () => {
  function requireImpl(): UserScopedFn {
    if (typeof hasServerPermissionForUser !== 'function') {
      throw new Error(
        'MISSING IMPLEMENTATION: hasServerPermissionForUser(db, uid, permission) ' +
          'is not exported from src/lib/server/permissions.ts yet (plan section 5 / contracts 4.4)',
      );
    }
    return hasServerPermissionForUser;
  }

  function seedHolder(extra: Record<string, unknown> = {}) {
    fake.seed('roles', HOLDER, {
      role: 'member',
      additionalRoles: [CUSTOM],
      chapterId: CHAPTER,
      ...extra,
    });
  }

  it('U1: an unexpired custom grant answers for the holder; ungranted keys deny', async () => {
    const fn = requireImpl();
    seedHolder();
    fake.seed('roleDefinitions', CUSTOM, customDef(['canManageTasks']));
    await expect(fn(fake.asDb(), HOLDER, 'canManageTasks')).resolves.toBe(true);
    await expect(fn(fake.asDb(), HOLDER, 'canManageEvents')).resolves.toBe(false);
  });

  it('U2 (SEC-11): the member_basic shadow doc cannot change the holder-level answer', async () => {
    const fn = requireImpl();
    seedHolder();
    fake.seed('roleDefinitions', CUSTOM, customDef(['canManageEvents']));
    seedMemberBasicShadow(fake);
    await expect(fn(fake.asDb(), HOLDER, 'canManageEvents')).resolves.toBe(true);
    await expect(fn(fake.asDb(), HOLDER, 'canManageTasks')).resolves.toBe(false);
  });

  it('U3 (contracts 4.4): an expired custom grant contributes NOTHING (Timestamp-shaped expiresAt)', async () => {
    const fn = requireImpl();
    seedHolder({
      expiresAt: tsLike(new Date('2026-01-01T00:00:00.000Z')),
      expiresRoleKey: CUSTOM,
    });
    fake.seed('roleDefinitions', CUSTOM, customDef(['canManageTasks']));
    await expect(fn(fake.asDb(), HOLDER, 'canManageTasks')).resolves.toBe(false);
  });

  it('U3b (contracts 4.4): an expired custom grant contributes NOTHING (Date-shaped expiresAt)', async () => {
    const fn = requireImpl();
    seedHolder({
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresRoleKey: CUSTOM,
    });
    fake.seed('roleDefinitions', CUSTOM, customDef(['canManageTasks']));
    await expect(fn(fake.asDb(), HOLDER, 'canManageTasks')).resolves.toBe(false);
  });

  it('U4: a not-yet-expired grant still counts', async () => {
    const fn = requireImpl();
    seedHolder({
      expiresAt: tsLike(new Date('2027-01-01T00:00:00.000Z')),
      expiresRoleKey: CUSTOM,
    });
    fake.seed('roleDefinitions', CUSTOM, customDef(['canManageTasks']));
    await expect(fn(fake.asDb(), HOLDER, 'canManageTasks')).resolves.toBe(true);
  });

  it('U5: an expiry recorded against a DIFFERENT slug does not block this grant', async () => {
    const fn = requireImpl();
    seedHolder({
      expiresAt: tsLike(new Date('2026-01-01T00:00:00.000Z')),
      expiresRoleKey: 'custom_other_team',
    });
    fake.seed('roleDefinitions', CUSTOM, customDef(['canManageTasks']));
    await expect(fn(fake.asDb(), HOLDER, 'canManageTasks')).resolves.toBe(true);
  });

  it('U6 (SEC-03): reserved keys never answer true at holder level, even from a poisoned definition', async () => {
    const fn = requireImpl();
    seedHolder();
    fake.seed(
      'roleDefinitions',
      CUSTOM,
      customDef(['canManageRoles', 'canManagePermissions', 'canManageTasks']),
    );
    await expect(fn(fake.asDb(), HOLDER, 'canManageRoles')).resolves.toBe(false);
    await expect(fn(fake.asDb(), HOLDER, 'canManagePermissions')).resolves.toBe(false);
    await expect(fn(fake.asDb(), HOLDER, 'canManageTasks')).resolves.toBe(true);
  });

  it('U7 (SEC-04): a CTO-parented custom grant with an empty array grants nothing at holder level', async () => {
    const fn = requireImpl();
    seedHolder();
    fake.seed(
      'roleDefinitions',
      CUSTOM,
      customDef([], { parentRoleKey: 'chief_technology_officer' }),
    );
    for (const key of ALL_KEYS) {
      await expect(fn(fake.asDb(), HOLDER, key)).resolves.toBe(false);
    }
  });

  it("U8: the primary role's own grants still count in the union", async () => {
    const fn = requireImpl();
    fake.seed('roles', HOLDER, { role: 'chapter_events_chair', additionalRoles: [] });
    fake.seed('roleDefinitions', 'chapter_events_chair', {
      permissions: ['canManageEvents'],
    });
    await expect(fn(fake.asDb(), HOLDER, 'canManageEvents')).resolves.toBe(true);
    await expect(fn(fake.asDb(), HOLDER, 'canManageTasks')).resolves.toBe(false);
  });

  it('U9: no roles doc at all denies', async () => {
    const fn = requireImpl();
    fake.seed('roleDefinitions', CUSTOM, customDef(['canManageTasks']));
    await expect(fn(fake.asDb(), HOLDER, 'canManageTasks')).resolves.toBe(false);
  });
});
