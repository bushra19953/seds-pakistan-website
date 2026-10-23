/**
 * ASSIGN-PATH (Custom Roles Fix Program) - custom roles through the single
 * write path. Sibling suite to role-writes.test.ts (plan section 9); the
 * existing suite stays untouched so expiry-core's surface stays separate.
 *
 * Written against items/assign-path/plan.md section 9 (tests 1-16) as
 * amended by globals/contracts.md, which WINS where the two disagree:
 *  - K1 (contracts 1.3): the reserved-key check reads the definition's
 *    stored `permissions` field ONLY. `permissionKeys` is a request-body
 *    field name and is never read at assignment. (Plan test 7's union
 *    case is replaced accordingly.)
 *  - Section 10 failure code (contracts 3.2): a definition that exists
 *    but fails the four-part test throws `custom_role_definition_invalid`
 *    (400), NOT unknown_role. A missing definition stays unknown_role.
 *  - Reserved-key code (contracts 3.2): `custom_role_reserved_permission`,
 *    httpStatus 400 (the plan's draft name carried an extra "s" and 403).
 *  - Expiry validation (contracts 2.2 / 3.2): code `invalid_expiry`.
 *    The expiry FIELDS are owned by expiry-core; the validation cases
 *    live in their own describe block at the bottom.
 *
 * Inputs are passed through a loose facade so this suite compiles and
 * runs both before the implementation widens AssignRoleInput (additional
 * lists become string[], expiry fields appear) and after.
 */
import { FakeFirestore } from './helpers/fake-firestore';
import {
  assignRole,
  removeRole,
  setMirror,
} from '../server/role-writes';

const ADMIN = 'admin-actor-uid';
const TARGET = 'target-user-uid';
const REASON = 'Appointed by the National President, October 2026 intake';
const CHAPTER = 'seds-ist-chapter';
const OTHER_CHAPTER = 'seds-other-chapter';
const CUSTOM = 'custom_poster_team_lead';

type AssignInput = Parameters<typeof assignRole>[1];

function assign(db: FakeFirestore, input: Record<string, unknown>) {
  return assignRole(db.asDb(), input as unknown as AssignInput);
}

function freshDb(): FakeFirestore {
  const db = new FakeFirestore();
  db.seed('users', TARGET, { displayName: 'Target User', chapterId: CHAPTER });
  return db;
}

/** A definition that passes the spec section 10 four-part test. */
function seedDefinition(
  db: FakeFirestore,
  slug: string,
  overrides: Record<string, unknown> = {},
): void {
  db.seed('roleDefinitions', slug, {
    role: slug,
    slug,
    name: 'Poster Team Lead',
    label: 'Poster Team Lead',
    isCustom: true,
    parentRoleKey: 'chapter_design_chair',
    chapterId: CHAPTER,
    description: 'Runs the chapter poster team',
    permissions: [],
    isActive: true,
    ...overrides,
  });
}

function baseInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: TARGET,
    role: 'member',
    actorUid: ADMIN,
    reason: REASON,
    source: 'admin_ui',
    ...overrides,
  };
}

describe('custom roles through assignRole (plan tests 1-16)', () => {
  it('1. custom slug as additional: roles doc, mirror, history, audit all carry it; effective stays catalog', async () => {
    const db = freshDb();
    seedDefinition(db, CUSTOM);
    const result = await assign(db, baseInput({ additionalRoles: [CUSTOM] }));

    expect(result.alreadyApplied).toBe(false);
    expect(result.newEffectiveRole).toBe('member');
    expect(result.roleDoc.additionalRoles).toEqual([CUSTOM]);

    const roleDoc = db.read('roles', TARGET);
    expect(roleDoc?.role).toBe('member');
    expect(roleDoc?.additionalRoles).toEqual([CUSTOM]);

    const mirror = db.read('users', TARGET);
    expect(mirror?.role).toBe('member');
    expect(mirror?.displayRole).toBe('member');
    expect(mirror?.additionalRoles).toEqual([CUSTOM]);

    const history = db.all('roleHistory');
    expect(history).toHaveLength(1);
    expect(history[0].data.newAdditionalRoles).toEqual([CUSTOM]);

    const audits = db.all('audit_logs');
    expect(audits).toHaveLength(1);
    expect(audits[0].data.action).toBe('role_change');
    expect((audits[0].data.details as Record<string, unknown>).customRoles).toEqual([CUSTOM]);

    expect(db.read('authority_refresh', TARGET)).toBeDefined();
  });

  it('2. stored order is catalog partition then custom partition (deduped, slug-ascending)', async () => {
    const db = freshDb();
    seedDefinition(db, 'custom_zeta');
    seedDefinition(db, 'custom_alpha');
    const result = await assign(
      db,
      baseInput({
        additionalRoles: ['custom_zeta', 'chapter_events_chair', 'custom_alpha', 'custom_alpha'],
      }),
    );
    const expected = ['chapter_events_chair', 'custom_alpha', 'custom_zeta'];
    expect(db.read('roles', TARGET)?.additionalRoles).toEqual(expected);
    expect(result.roleDoc.additionalRoles).toEqual(expected);
    expect(db.read('users', TARGET)?.additionalRoles).toEqual(expected);
  });

  it('3. custom_ slug with no definition doc throws unknown_role and writes nothing', async () => {
    const db = freshDb();
    await expect(assign(db, baseInput({ additionalRoles: [CUSTOM] }))).rejects.toMatchObject({
      name: 'RoleWriteError',
      code: 'unknown_role',
      httpStatus: 400,
    });
    expect(db.read('roles', TARGET)).toBeUndefined();
    expect(db.all('roleHistory')).toHaveLength(0);
    expect(db.all('audit_logs')).toHaveLength(0);
  });

  it('4. non-prefixed unknown and junk additionals throw unknown_role (invariant 10)', async () => {
    for (const slug of [
      'media_lead',
      'pakistan-president',
      'super-admin',
      'chair-design-media',
      'advisor-faculty-head',
    ]) {
      const db = freshDb();
      await expect(assign(db, baseInput({ additionalRoles: [slug] }))).rejects.toMatchObject({
        code: 'unknown_role',
        httpStatus: 400,
      });
      expect(db.read('roles', TARGET)).toBeUndefined();
      expect(db.all('roleHistory')).toHaveLength(0);
    }
  });

  it('5. section 10 failures throw custom_role_definition_invalid (contracts 3.2)', async () => {
    const cases: Array<{ name: string; overrides: Record<string, unknown> }> = [
      { name: 'isCustom missing', overrides: { isCustom: undefined } },
      { name: 'parentRoleKey is a legacy token', overrides: { parentRoleKey: 'chair_events' } },
      { name: 'chapterId empty', overrides: { chapterId: '' } },
    ];
    for (const c of cases) {
      const db = freshDb();
      const def: Record<string, unknown> = {
        role: CUSTOM,
        slug: CUSTOM,
        name: 'Poster Team Lead',
        label: 'Poster Team Lead',
        isCustom: true,
        parentRoleKey: 'chapter_design_chair',
        chapterId: CHAPTER,
        permissions: [],
        isActive: true,
        ...c.overrides,
      };
      if (c.overrides.isCustom === undefined) delete def.isCustom;
      db.seed('roleDefinitions', CUSTOM, def);
      await expect(
        assign(db, baseInput({ additionalRoles: [CUSTOM] })),
      ).rejects.toMatchObject({ code: 'custom_role_definition_invalid', httpStatus: 400 });
      expect(db.read('roles', TARGET)).toBeUndefined();
      expect(db.all('roleHistory')).toHaveLength(0);
    }
  });

  it('6. inactive definition throws custom_role_inactive', async () => {
    const db = freshDb();
    seedDefinition(db, CUSTOM, { isActive: false });
    await expect(assign(db, baseInput({ additionalRoles: [CUSTOM] }))).rejects.toMatchObject({
      code: 'custom_role_inactive',
      httpStatus: 400,
    });
    expect(db.read('roles', TARGET)).toBeUndefined();
    expect(db.all('roleHistory')).toHaveLength(0);
  });

  it('7. reserved keys in the stored `permissions` field refuse the grant; `permissionKeys` is never read (K1)', async () => {
    // canManageRoles in the stored field -> refused, nothing written.
    const db1 = freshDb();
    seedDefinition(db1, CUSTOM, { permissions: ['canManageRoles'] });
    await expect(assign(db1, baseInput({ additionalRoles: [CUSTOM] }))).rejects.toMatchObject({
      code: 'custom_role_reserved_permission',
      httpStatus: 400,
    });
    expect(db1.read('roles', TARGET)).toBeUndefined();
    expect(db1.all('roleHistory')).toHaveLength(0);

    // canManagePermissions in the stored field -> same refusal.
    const db2 = freshDb();
    seedDefinition(db2, CUSTOM, { permissions: ['canManagePermissions', 'canManageTasks'] });
    await expect(assign(db2, baseInput({ additionalRoles: [CUSTOM] }))).rejects.toMatchObject({
      code: 'custom_role_reserved_permission',
      httpStatus: 400,
    });
    expect(db2.read('roles', TARGET)).toBeUndefined();

    // Reserved keys sitting in a stray `permissionKeys` field on the doc,
    // with a clean stored `permissions`, do NOT refuse: contracts 1.3 rules
    // the stored field is `permissions` and only `permissions`.
    const db3 = freshDb();
    seedDefinition(db3, CUSTOM, {
      permissions: ['canManageTasks'],
      permissionKeys: ['canManageRoles'],
    });
    const result = await assign(db3, baseInput({ additionalRoles: [CUSTOM] }));
    expect(result.alreadyApplied).toBe(false);
    expect(db3.read('roles', TARGET)?.additionalRoles).toEqual([CUSTOM]);
  });

  it('8. definition chapter differing from the resolved chapter throws custom_role_chapter_mismatch', async () => {
    const db = freshDb();
    seedDefinition(db, CUSTOM, { chapterId: OTHER_CHAPTER });
    await expect(assign(db, baseInput({ additionalRoles: [CUSTOM] }))).rejects.toMatchObject({
      code: 'custom_role_chapter_mismatch',
      httpStatus: 400,
    });
    expect(db.read('roles', TARGET)).toBeUndefined();
    expect(db.all('roleHistory')).toHaveLength(0);
  });

  it('9. no chapter anywhere throws chapter_required', async () => {
    const db = new FakeFirestore();
    db.seed('users', TARGET, { displayName: 'Chapterless User' });
    seedDefinition(db, CUSTOM);
    await expect(assign(db, baseInput({ additionalRoles: [CUSTOM] }))).rejects.toMatchObject({
      code: 'chapter_required',
      httpStatus: 400,
    });
    expect(db.read('roles', TARGET)).toBeUndefined();
  });

  it('10. chapter resolves from the roles doc before the users doc', async () => {
    const db = new FakeFirestore();
    db.seed('users', TARGET, { displayName: 'Target User', chapterId: OTHER_CHAPTER });
    db.seed('roles', TARGET, {
      role: 'member',
      additionalRoles: [],
      chapterId: CHAPTER,
      grantedBy: ADMIN,
      lastChangedBy: ADMIN,
      source: 'admin_ui',
      schemaVersion: 2,
    });
    seedDefinition(db, CUSTOM); // definition chapter = CHAPTER (the roles-doc chapter)
    const result = await assign(db, baseInput({ additionalRoles: [CUSTOM] }));
    expect(result.alreadyApplied).toBe(false);
    const roleDoc = db.read('roles', TARGET);
    expect(roleDoc?.additionalRoles).toEqual([CUSTOM]);
    expect(roleDoc?.chapterId).toBe(CHAPTER);
  });

  it('11. a chapter move in the same call is checked against the NEW chapter', async () => {
    const db = freshDb(); // stored chapter (users doc) = CHAPTER
    seedDefinition(db, CUSTOM, { chapterId: OTHER_CHAPTER });
    const result = await assign(
      db,
      baseInput({ additionalRoles: [CUSTOM], chapterId: OTHER_CHAPTER }),
    );
    expect(result.alreadyApplied).toBe(false);
    const roleDoc = db.read('roles', TARGET);
    expect(roleDoc?.additionalRoles).toEqual([CUSTOM]);
    expect(roleDoc?.chapterId).toBe(OTHER_CHAPTER);
  });

  it('12. a custom slug in the PRIMARY slot throws unknown_role (contracts K2)', async () => {
    const db = freshDb();
    seedDefinition(db, CUSTOM);
    await expect(assign(db, baseInput({ role: CUSTOM }))).rejects.toMatchObject({
      code: 'unknown_role',
      httpStatus: 400,
    });
    expect(db.read('roles', TARGET)).toBeUndefined();
    expect(db.all('roleHistory')).toHaveLength(0);
  });

  it('13. read-side partition: reassigning over a doc holding a custom slug does not throw and keeps history verbatim', async () => {
    const db = freshDb();
    db.seed('roles', TARGET, {
      role: 'chapter_secretary',
      additionalRoles: [CUSTOM],
      chapterId: CHAPTER,
      grantedBy: ADMIN,
      lastChangedBy: ADMIN,
      source: 'admin_ui',
      schemaVersion: 2,
    });
    const result = await assign(db, baseInput({ role: 'chapter_treasurer' }));
    expect(result.alreadyApplied).toBe(false);
    expect(result.previousEffectiveRole).toBe('chapter_secretary');
    const history = db.all('roleHistory');
    expect(history).toHaveLength(1);
    expect(history[0].data.previousEffectiveRole).toBe('chapter_secretary');
    expect(history[0].data.previousAdditionalRoles).toEqual([CUSTOM]);
  });

  it('14. setMirror on a doc holding a custom slug resolves and retains the slug', async () => {
    const db = freshDb();
    db.seed('roles', TARGET, {
      role: 'chapter_secretary',
      additionalRoles: [CUSTOM],
      chapterId: CHAPTER,
      grantedBy: ADMIN,
      lastChangedBy: ADMIN,
      source: 'admin_ui',
      schemaVersion: 2,
    });
    const repaired = await setMirror(db.asDb(), TARGET);
    expect(repaired).toBe(true);
    const mirror = db.read('users', TARGET);
    expect(mirror?.role).toBe('chapter_secretary');
    expect(mirror?.displayRole).toBe('chapter_secretary');
    expect(mirror?.additionalRoles).toEqual([CUSTOM]);
  });

  it('15. removeRole on a doc holding a custom slug reports the catalog previous effective role', async () => {
    const db = freshDb();
    db.seed('roles', TARGET, {
      role: 'chapter_secretary',
      additionalRoles: [CUSTOM],
      chapterId: CHAPTER,
      grantedBy: ADMIN,
      lastChangedBy: ADMIN,
      source: 'admin_ui',
      schemaVersion: 2,
    });
    const result = await removeRole(db.asDb(), {
      uid: TARGET,
      actorUid: ADMIN,
      reason: 'Term ended October 2026',
      source: 'admin_ui',
    });
    expect(result.previousEffectiveRole).toBe('chapter_secretary');
    expect(db.read('roles', TARGET)).toBeUndefined();
    expect(db.read('users', TARGET)?.role).toBe('member_basic');
  });

  it('16. idempotent replay returns alreadyApplied and does NOT re-validate the definition', async () => {
    const db = freshDb();
    seedDefinition(db, CUSTOM);
    const input = baseInput({ additionalRoles: [CUSTOM], idempotencyKey: 'idem-custom-1' });
    const first = await assign(db, input);
    expect(first.alreadyApplied).toBe(false);

    // The definition disappears after the grant was applied; a replay of
    // the same key must still succeed as alreadyApplied (contracts 3.2).
    db.store.get('roleDefinitions')?.delete(CUSTOM);
    const replay = await assign(db, input);
    expect(replay.alreadyApplied).toBe(true);
    expect(replay.roleDoc.additionalRoles).toEqual([CUSTOM]);
    expect(db.all('roleHistory')).toHaveLength(1);
  });
});

describe('expiry validation on assign (contracts 2.2 / 3.2 - fields owned by expiry-core)', () => {
  const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const PAST = new Date(Date.now() - 60 * 1000);

  function millisOf(v: unknown): number {
    if (v instanceof Date) return v.getTime();
    if (v && typeof v === 'object') {
      const o = v as { toMillis?: () => number; seconds?: number };
      if (typeof o.toMillis === 'function') return o.toMillis();
      if (typeof o.seconds === 'number') return o.seconds * 1000;
    }
    return NaN;
  }

  it('expiresAt without expiresRoleKey throws invalid_expiry and writes nothing', async () => {
    const db = freshDb();
    seedDefinition(db, CUSTOM);
    await expect(
      assign(db, baseInput({ additionalRoles: [CUSTOM], expiresAt: FUTURE })),
    ).rejects.toMatchObject({ code: 'invalid_expiry', httpStatus: 400 });
    expect(db.read('roles', TARGET)).toBeUndefined();
    expect(db.all('roleHistory')).toHaveLength(0);
  });

  it('expiresRoleKey that is not a custom_ slug throws invalid_expiry', async () => {
    const db = freshDb();
    seedDefinition(db, CUSTOM);
    await expect(
      assign(
        db,
        baseInput({
          additionalRoles: [CUSTOM, 'chapter_events_chair'],
          expiresAt: FUTURE,
          expiresRoleKey: 'chapter_events_chair',
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_expiry', httpStatus: 400 });
    expect(db.read('roles', TARGET)).toBeUndefined();
  });

  it('expiresRoleKey not present in this write\'s additionalRoles throws invalid_expiry', async () => {
    const db = freshDb();
    seedDefinition(db, CUSTOM);
    seedDefinition(db, 'custom_alpha');
    await expect(
      assign(
        db,
        baseInput({
          additionalRoles: ['custom_alpha'],
          expiresAt: FUTURE,
          expiresRoleKey: CUSTOM,
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_expiry', httpStatus: 400 });
    expect(db.read('roles', TARGET)).toBeUndefined();
  });

  it('expiresAt in the past throws invalid_expiry', async () => {
    const db = freshDb();
    seedDefinition(db, CUSTOM);
    await expect(
      assign(
        db,
        baseInput({ additionalRoles: [CUSTOM], expiresAt: PAST, expiresRoleKey: CUSTOM }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_expiry', httpStatus: 400 });
    expect(db.read('roles', TARGET)).toBeUndefined();
    expect(db.all('roleHistory')).toHaveLength(0);
  });

  it('a valid expiring grant stamps expiresAt/expiresRoleKey and captures the prior state in the same write', async () => {
    const db = freshDb();
    seedDefinition(db, CUSTOM);
    const result = await assign(
      db,
      baseInput({ additionalRoles: [CUSTOM], expiresAt: FUTURE, expiresRoleKey: CUSTOM }),
    );
    expect(result.alreadyApplied).toBe(false);
    const roleDoc = db.read('roles', TARGET);
    expect(roleDoc?.additionalRoles).toEqual([CUSTOM]);
    expect(roleDoc?.expiresRoleKey).toBe(CUSTOM);
    expect(millisOf(roleDoc?.expiresAt)).toBe(FUTURE.getTime());
    expect(roleDoc?.priorRole ?? null).toBeNull();
    expect(roleDoc?.priorAdditionalRoles ?? []).toEqual([]);
    const history = db.all('roleHistory');
    expect(history).toHaveLength(1);
    expect(history[0].data.expiresRoleKey).toBe(CUSTOM);
    expect(millisOf(history[0].data.expiresAt)).toBe(FUTURE.getTime());
  });

  it('prior-state capture snapshots the pre-grant primary and additionals', async () => {
    const db = freshDb();
    db.seed('roles', TARGET, {
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair'],
      chapterId: CHAPTER,
      grantedBy: ADMIN,
      lastChangedBy: ADMIN,
      source: 'admin_ui',
      schemaVersion: 2,
    });
    seedDefinition(db, CUSTOM);
    await assign(
      db,
      baseInput({
        role: 'chapter_secretary',
        additionalRoles: ['chapter_events_chair', CUSTOM],
        expiresAt: FUTURE,
        expiresRoleKey: CUSTOM,
      }),
    );
    const roleDoc = db.read('roles', TARGET);
    expect(roleDoc?.expiresRoleKey).toBe(CUSTOM);
    expect(roleDoc?.priorRole).toBe('chapter_secretary');
    expect(roleDoc?.priorAdditionalRoles).toEqual(['chapter_events_chair']);
  });
});
