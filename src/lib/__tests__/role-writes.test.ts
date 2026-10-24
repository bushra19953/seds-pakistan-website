/**
 * Phase 1 Workstream B - the single role write path (spec B.8 suites 1-3).
 * Runs against the in-memory fake Firestore; the write path must compose
 * roles + mirror + roleHistory + audit + authority_refresh in one commit
 * and fail loudly on every guard.
 */
import { FakeFirestore } from './helpers/fake-firestore';
import {
  assignRole,
  removeRole,
  setMirror,
  stampRoleClaims,
  RoleWriteError,
  type RoleClaimsAuth,
} from '../server/role-writes';
import { FOUNDER_UID } from '@/config/founder';

const ADMIN = 'admin-actor-uid';
const TARGET = 'target-user-uid';
const REASON = 'Appointed by the National President, October 2026 intake';

function freshDb(): FakeFirestore {
  const db = new FakeFirestore();
  db.seed('users', TARGET, { displayName: 'Target User', chapterId: 'seds-ist-chapter' });
  return db;
}

describe('write-path (assignRole composition)', () => {
  it('one call writes roles doc, mirror, roleHistory, audit, and authority_refresh', async () => {
    const db = freshDb();
    const result = await assignRole(db.asDb(), {
      uid: TARGET,
      role: 'chapter_president',
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
    });
    expect(result.alreadyApplied).toBe(false);
    expect(result.newEffectiveRole).toBe('chapter_president');

    const roleDoc = db.read('roles', TARGET);
    expect(roleDoc).toMatchObject({
      role: 'chapter_president',
      additionalRoles: [],
      chapterId: 'seds-ist-chapter',
      grantedBy: ADMIN,
      lastChangedBy: ADMIN,
      source: 'admin_ui',
      schemaVersion: 2,
    });

    const mirror = db.read('users', TARGET);
    expect(mirror?.role).toBe('chapter_president');
    expect(mirror?.displayRole).toBe('chapter_president');
    expect(mirror?.roleSource).toBe('roles');
    expect(mirror).not.toHaveProperty('additionalRoles');

    const history = db.all('roleHistory');
    expect(history).toHaveLength(1);
    expect(history[0].data).toMatchObject({
      uid: TARGET,
      roleKey: 'chapter_president',
      action: 'grant',
      previousRole: null,
      newRole: 'chapter_president',
      effectiveRole: 'chapter_president',
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
      consentRequestId: null,
    });

    const audits = db.all('audit_logs');
    expect(audits).toHaveLength(1);
    expect(audits[0].data).toMatchObject({ action: 'role_change', targetUserId: TARGET });

    expect(db.read('authority_refresh', TARGET)).toBeDefined();
  });

  it('additionalRoles mirror the effective role derivation (highest rank wins)', async () => {
    const db = freshDb();
    const result = await assignRole(db.asDb(), {
      uid: TARGET,
      role: 'member',
      additionalRoles: ['chapter_events_chair', 'chapter_design_chair'],
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
    });
    expect(result.newEffectiveRole).toBe('chapter_events_chair');
    const mirror = db.read('users', TARGET);
    expect(mirror?.role).toBe('chapter_events_chair');
    expect(mirror?.displayRole).toBe('chapter_events_chair');
    expect(mirror?.additionalRoles).toEqual(['chapter_events_chair', 'chapter_design_chair']);
  });

  it('grantedBy and grantedAt are write-once across a second change', async () => {
    const db = freshDb();
    await assignRole(db.asDb(), {
      uid: TARGET, role: 'chapter_secretary', actorUid: ADMIN, reason: REASON, source: 'admin_ui',
    });
    const firstGrantedAt = db.read('roles', TARGET)?.grantedAt;
    await assignRole(db.asDb(), {
      uid: TARGET, role: 'chapter_treasurer', actorUid: 'second-actor', reason: REASON, source: 'admin_ui',
    });
    const doc = db.read('roles', TARGET);
    expect(doc?.grantedBy).toBe(ADMIN);
    expect(doc?.grantedAt).toBe(firstGrantedAt);
    expect(doc?.lastChangedBy).toBe('second-actor');
    const history = db.all('roleHistory');
    expect(history).toHaveLength(2);
    expect(history[1].data.action).toBe('change');
    expect(history[1].data.previousRole).toBe('chapter_secretary');
  });

  it('replaying an idempotencyKey applies nothing twice', async () => {
    const db = freshDb();
    const input = {
      uid: TARGET, role: 'chapter_secretary' as const, actorUid: ADMIN,
      reason: REASON, source: 'admin_ui' as const, idempotencyKey: 'idem-1',
    };
    await assignRole(db.asDb(), input);
    const replay = await assignRole(db.asDb(), input);
    expect(replay.alreadyApplied).toBe(true);
    expect(db.all('roleHistory')).toHaveLength(1);
  });

  it('a failing commit propagates (fails loudly, never swallowed)', async () => {
    const db = freshDb();
    db.failCommits = true;
    await expect(
      assignRole(db.asDb(), {
        uid: TARGET, role: 'member', actorUid: ADMIN, reason: REASON, source: 'admin_ui',
      }),
    ).rejects.toThrow('fake commit failure');
  });
});

describe('validation (assignRole guards)', () => {
  it('unknown role key throws unknown_role', async () => {
    const db = freshDb();
    await expect(
      assignRole(db.asDb(), {
        uid: TARGET, role: 'national_vp_operations' as never, actorUid: ADMIN,
        reason: REASON, source: 'admin_ui',
      }),
    ).rejects.toMatchObject({ name: 'RoleWriteError', code: 'unknown_role', httpStatus: 400 });
  });

  it('member_officer throws derived_role_not_assignable', async () => {
    const db = freshDb();
    await expect(
      assignRole(db.asDb(), {
        uid: TARGET, role: 'member_officer', actorUid: ADMIN, reason: REASON, source: 'admin_ui',
      }),
    ).rejects.toMatchObject({ code: 'derived_role_not_assignable' });
  });

  it('a reason under 10 chars throws invalid_reason and writes nothing', async () => {
    const db = freshDb();
    await expect(
      assignRole(db.asDb(), {
        uid: TARGET, role: 'member', actorUid: ADMIN, reason: 'short', source: 'admin_ui',
      }),
    ).rejects.toMatchObject({ code: 'invalid_reason' });
    expect(db.read('roles', TARGET)).toBeUndefined();
    expect(db.all('roleHistory')).toHaveLength(0);
  });

  it('founder_patron for a non-founder target throws reserved_role', async () => {
    const db = freshDb();
    await expect(
      assignRole(db.asDb(), {
        uid: TARGET, role: 'founder_patron', actorUid: FOUNDER_UID, reason: REASON, source: 'admin_ui',
      }),
    ).rejects.toMatchObject({ code: 'reserved_role', httpStatus: 403 });
  });

  it('an R4 grant by a non-founder actor throws actor_not_authorized', async () => {
    const db = freshDb();
    await expect(
      assignRole(db.asDb(), {
        uid: TARGET, role: 'governor_founder', actorUid: ADMIN, reason: REASON, source: 'admin_ui',
      }),
    ).rejects.toMatchObject({ code: 'actor_not_authorized', httpStatus: 403 });
  });

  it('the Founder can grant an R4 key', async () => {
    const db = freshDb();
    const result = await assignRole(db.asDb(), {
      uid: TARGET, role: 'governor_founder', actorUid: FOUNDER_UID, reason: REASON, source: 'admin_ui',
    });
    expect(result.newEffectiveRole).toBe('governor_founder');
  });

  it('a chapter-scoped role without any chapterId throws chapter_required', async () => {
    const db = new FakeFirestore();
    db.seed('users', TARGET, { displayName: 'No Chapter User' });
    await expect(
      assignRole(db.asDb(), {
        uid: TARGET, role: 'chapter_president', actorUid: ADMIN, reason: REASON, source: 'admin_ui',
      }),
    ).rejects.toMatchObject({ code: 'chapter_required' });
  });

  it('RoleWriteError is an Error subclass carrying code and httpStatus', () => {
    const err = new RoleWriteError('write_failed', 500, 'boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('write_failed');
    expect(err.httpStatus).toBe(500);
  });
});

describe('removeRole and setMirror', () => {
  it('removeRole deletes the roles doc, resets the mirror, records action delete', async () => {
    const db = freshDb();
    await assignRole(db.asDb(), {
      uid: TARGET, role: 'chapter_president', actorUid: ADMIN, reason: REASON, source: 'admin_ui',
    });
    const result = await removeRole(db.asDb(), {
      uid: TARGET, actorUid: ADMIN, reason: 'Term ended October 2026', source: 'admin_ui',
    });
    expect(result.previousEffectiveRole).toBe('chapter_president');
    expect(db.read('roles', TARGET)).toBeUndefined();
    const mirror = db.read('users', TARGET);
    expect(mirror?.role).toBe('member_basic');
    expect(mirror?.displayRole).toBe('member_basic');
    const deletes = db.all('roleHistory').filter((h) => h.data.action === 'delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].data.newRole).toBeNull();
  });

  it('removeRole on a user with no roles doc and a member_basic mirror is a no-op success', async () => {
    const db = new FakeFirestore();
    db.seed('users', TARGET, { role: 'member_basic', displayRole: 'member_basic' });
    const result = await removeRole(db.asDb(), {
      uid: TARGET, actorUid: ADMIN, reason: 'Cleanup of empty record', source: 'admin_ui',
    });
    expect(result.alreadyApplied).toBe(true);
    expect(db.all('roleHistory')).toHaveLength(0);
  });

  it('setMirror repairs a drifted mirror from the roles doc and writes no history', async () => {
    const db = freshDb();
    await assignRole(db.asDb(), {
      uid: TARGET, role: 'chapter_treasurer', actorUid: ADMIN, reason: REASON, source: 'admin_ui',
    });
    db.seed('users', TARGET, { role: 'member', displayRole: 'member', chapterId: 'seds-ist-chapter' });
    const repaired = await setMirror(db.asDb(), TARGET);
    expect(repaired).toBe(true);
    expect(db.read('users', TARGET)?.role).toBe('chapter_treasurer');
    expect(db.all('roleHistory')).toHaveLength(1); // only the original grant
  });

  it('setMirror returns false when no roles doc exists', async () => {
    const db = freshDb();
    expect(await setMirror(db.asDb(), TARGET)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EXPIRY-CORE (plan section 8A): grant expiry on the write path.
// Expiry lives on the GRANT (contracts 2.2): an expiring custom grant
// stamps expiresAt / expiresRoleKey / priorRole / priorAdditionalRoles /
// expiryAlertStage in the SAME batch as the grant, captured server-side
// from the pre-write stored state (probation capture pattern).
// Parent ruling X11 governs re-grants of the SAME slug: a new date
// REPLACES the expiry, expiresAt: null clears it, absent fields preserve
// it, and the snapshot inherits the FIRST expiring grant's prior state
// (the chain rule - the chain restores the pre-chain state).
// ---------------------------------------------------------------------------

const EXPIRY_CHAPTER = 'seds-ist-chapter';
const CUSTOM_A = 'custom_poster_team_lead';
const CUSTOM_B = 'custom_social_media_lead';
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_FIELDS = [
  'expiresAt',
  'expiresRoleKey',
  'priorRole',
  'priorAdditionalRoles',
  'expiryAlertStage',
] as const;

type AssignInputShape = Parameters<typeof assignRole>[1];
function assignLoose(db: FakeFirestore, input: Record<string, unknown>) {
  return assignRole(db.asDb(), input as unknown as AssignInputShape);
}

function seedCustomDefinition(db: FakeFirestore, slug: string, name: string) {
  db.seed('roleDefinitions', slug, {
    role: slug,
    slug,
    name,
    label: name,
    isCustom: true,
    parentRoleKey: 'chapter_design_chair',
    chapterId: EXPIRY_CHAPTER,
    description: `Temporary ${name} (expiry-core tests)`,
    permissions: ['canManageTasks'],
    scope: 'chapter',
    category: 'Custom',
    allowedChapters: [EXPIRY_CHAPTER],
    isActive: true,
  });
}

/** TARGET holds chapter_secretary + [chapter_events_chair] in IST. */
async function seedHolderWithCatalogRole(db: FakeFirestore) {
  await assignRole(db.asDb(), {
    uid: TARGET,
    role: 'chapter_secretary',
    additionalRoles: ['chapter_events_chair'],
    actorUid: ADMIN,
    reason: REASON,
    source: 'admin_ui',
  });
}

describe('expiry-core (grant expiry stamps on assignRole)', () => {
  it('8A.1 an expiring grant stamps all five fields in the same write, captured from the pre-write stored state', async () => {
    const db = freshDb();
    seedCustomDefinition(db, CUSTOM_A, 'Poster Team Lead');
    await seedHolderWithCatalogRole(db);
    const expiresAt = new Date(Date.now() + 30 * DAY_MS);
    const result = await assignLoose(db, {
      uid: TARGET,
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair', CUSTOM_A],
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
      expiresAt,
      expiresRoleKey: CUSTOM_A,
    });
    expect(result.alreadyApplied).toBe(false);

    const doc = db.read('roles', TARGET);
    expect(doc?.role).toBe('chapter_secretary');
    expect(doc?.additionalRoles).toEqual(['chapter_events_chair', CUSTOM_A]);
    expect(doc?.expiresAt).toEqual(expiresAt);
    expect(doc?.expiresRoleKey).toBe(CUSTOM_A);
    // Snapshot = the state BEFORE this grant write, read server-side.
    expect(doc?.priorRole).toBe('chapter_secretary');
    expect(doc?.priorAdditionalRoles).toEqual(['chapter_events_chair']);
    expect(doc?.expiryAlertStage).toBe('none');

    // assignRole's result roleDoc echoes the stamped fields (plan H5).
    const echoed = result.roleDoc as unknown as Record<string, unknown>;
    expect(echoed.expiresAt).toEqual(expiresAt);
    expect(echoed.expiresRoleKey).toBe(CUSTOM_A);
    expect(echoed.priorRole).toBe('chapter_secretary');
    expect(echoed.priorAdditionalRoles).toEqual(['chapter_events_chair']);
    expect(echoed.expiryAlertStage).toBe('none');
  });

  it('8A.2 the grant roleHistory entry carries top-level expiresAt and expiresRoleKey', async () => {
    const db = freshDb();
    seedCustomDefinition(db, CUSTOM_A, 'Poster Team Lead');
    await seedHolderWithCatalogRole(db);
    const expiresAt = new Date(Date.now() + 30 * DAY_MS);
    await assignLoose(db, {
      uid: TARGET,
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair', CUSTOM_A],
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
      expiresAt,
      expiresRoleKey: CUSTOM_A,
    });
    const history = db.all('roleHistory');
    const grantEntry = history[history.length - 1].data;
    expect(grantEntry.expiresAt).toEqual(expiresAt);
    expect(grantEntry.expiresRoleKey).toBe(CUSTOM_A);
  });

  describe('8A.3 invalid_expiry cases (each throws 400 invalid_expiry and writes nothing)', () => {
    async function expectInvalidExpiry(input: Record<string, unknown>) {
      const db = freshDb();
      seedCustomDefinition(db, CUSTOM_A, 'Poster Team Lead');
      await seedHolderWithCatalogRole(db);
      const before = db.read('roles', TARGET);
      await expect(assignLoose(db, input)).rejects.toMatchObject({
        name: 'RoleWriteError',
        code: 'invalid_expiry',
        httpStatus: 400,
      });
      expect(db.read('roles', TARGET)).toEqual(before);
      expect(db.all('roleHistory')).toHaveLength(1); // only the seed grant
    }
    const base = {
      uid: TARGET,
      role: 'chapter_secretary',
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
    };

    it('expiresAt without expiresRoleKey', async () => {
      await expectInvalidExpiry({
        ...base,
        additionalRoles: ['chapter_events_chair', CUSTOM_A],
        expiresAt: new Date(Date.now() + 30 * DAY_MS),
      });
    });

    it('expiresRoleKey without expiresAt', async () => {
      await expectInvalidExpiry({
        ...base,
        additionalRoles: ['chapter_events_chair', CUSTOM_A],
        expiresRoleKey: CUSTOM_A,
      });
    });

    it('expiresRoleKey that is not a custom_ slug', async () => {
      await expectInvalidExpiry({
        ...base,
        additionalRoles: ['chapter_events_chair', 'chapter_design_chair'],
        expiresAt: new Date(Date.now() + 30 * DAY_MS),
        expiresRoleKey: 'chapter_design_chair',
      });
    });

    it('expiresRoleKey absent from the write resulting additionalRoles', async () => {
      await expectInvalidExpiry({
        ...base,
        additionalRoles: ['chapter_events_chair'],
        expiresAt: new Date(Date.now() + 30 * DAY_MS),
        expiresRoleKey: CUSTOM_A,
      });
    });

    it('expiresAt in the past', async () => {
      await expectInvalidExpiry({
        ...base,
        additionalRoles: ['chapter_events_chair', CUSTOM_A],
        expiresAt: new Date(Date.now() - DAY_MS),
        expiresRoleKey: CUSTOM_A,
      });
    });

    it('expiresAt exactly now (the instant must be strictly in the future)', async () => {
      await expectInvalidExpiry({
        ...base,
        additionalRoles: ['chapter_events_chair', CUSTOM_A],
        expiresAt: new Date(),
        expiresRoleKey: CUSTOM_A,
      });
    });
  });

  it('8A.4a a second expiring grant for a DIFFERENT slug replaces the pending expiry and records the superseded one', async () => {
    const db = freshDb();
    seedCustomDefinition(db, CUSTOM_A, 'Poster Team Lead');
    seedCustomDefinition(db, CUSTOM_B, 'Social Media Lead');
    await seedHolderWithCatalogRole(db);
    const expA = new Date(Date.now() + 30 * DAY_MS);
    await assignLoose(db, {
      uid: TARGET,
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair', CUSTOM_A],
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
      expiresAt: expA,
      expiresRoleKey: CUSTOM_A,
    });
    const expB = new Date(Date.now() + 60 * DAY_MS);
    await assignLoose(db, {
      uid: TARGET,
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair', CUSTOM_A, CUSTOM_B],
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
      expiresAt: expB,
      expiresRoleKey: CUSTOM_B,
    });
    const doc = db.read('roles', TARGET);
    // Latest grant wins: the pending expiry is B's, snapshotting the
    // stored state just before B (both partitions).
    expect(doc?.expiresAt).toEqual(expB);
    expect(doc?.expiresRoleKey).toBe(CUSTOM_B);
    expect(doc?.priorRole).toBe('chapter_secretary');
    expect(doc?.priorAdditionalRoles).toEqual(['chapter_events_chair', CUSTOM_A]);
    expect(doc?.expiryAlertStage).toBe('none');
    // The superseded slug remains held (now non-expiring).
    expect(doc?.additionalRoles).toEqual(['chapter_events_chair', CUSTOM_A, CUSTOM_B]);
    const history = db.all('roleHistory');
    const replacing = history[history.length - 1].data;
    expect(replacing.supersededExpiresAt).toEqual(expA);
    expect(replacing.supersededExpiresRoleKey).toBe(CUSTOM_A);
  });

  it('8A.4b X11 chain: a re-grant of the SAME slug replaces the date and the snapshot inherits the FIRST grant prior state', async () => {
    const db = freshDb();
    seedCustomDefinition(db, CUSTOM_A, 'Poster Team Lead');
    await seedHolderWithCatalogRole(db);
    const expA = new Date(Date.now() + 30 * DAY_MS);
    await assignLoose(db, {
      uid: TARGET,
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair', CUSTOM_A],
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
      expiresAt: expA,
      expiresRoleKey: CUSTOM_A,
    });
    const expB = new Date(Date.now() + 60 * DAY_MS);
    await assignLoose(db, {
      uid: TARGET,
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair', CUSTOM_A],
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
      expiresAt: expB,
      expiresRoleKey: CUSTOM_A,
    });
    const doc = db.read('roles', TARGET);
    expect(doc?.expiresAt).toEqual(expB);
    expect(doc?.expiresRoleKey).toBe(CUSTOM_A);
    // X11 chain rule: the snapshot is the pre-CHAIN state. It must NOT
    // contain the slug (the raw stored array before grant B did), or the
    // sweep would restore the slug as a permanent grant at expiry.
    expect(doc?.priorRole).toBe('chapter_secretary');
    expect(doc?.priorAdditionalRoles).toEqual(['chapter_events_chair']);
    expect(doc?.expiryAlertStage).toBe('none');
    const history = db.all('roleHistory');
    const replacing = history[history.length - 1].data;
    expect(replacing.supersededExpiresAt).toEqual(expA);
    expect(replacing.supersededExpiresRoleKey).toBe(CUSTOM_A);
  });

  it('8A.5 a later non-expiry write that KEEPS expiresRoleKey leaves the five fields untouched', async () => {
    const db = freshDb();
    seedCustomDefinition(db, CUSTOM_A, 'Poster Team Lead');
    await seedHolderWithCatalogRole(db);
    const expiresAt = new Date(Date.now() + 30 * DAY_MS);
    await assignLoose(db, {
      uid: TARGET,
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair', CUSTOM_A],
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
      expiresAt,
      expiresRoleKey: CUSTOM_A,
    });
    const stamped = db.read('roles', TARGET);
    await assignLoose(db, {
      uid: TARGET,
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair', 'chapter_design_chair', CUSTOM_A],
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
    });
    const doc = db.read('roles', TARGET);
    expect(doc?.additionalRoles).toEqual([
      'chapter_events_chair',
      'chapter_design_chair',
      CUSTOM_A,
    ]);
    for (const field of EXPIRY_FIELDS) {
      expect(doc?.[field]).toEqual(stamped?.[field]);
    }
  });

  it('8A.6 a later non-expiry write that REMOVES expiresRoleKey clears the five fields in the same write', async () => {
    const db = freshDb();
    seedCustomDefinition(db, CUSTOM_A, 'Poster Team Lead');
    await seedHolderWithCatalogRole(db);
    await assignLoose(db, {
      uid: TARGET,
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair', CUSTOM_A],
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
      expiresAt: new Date(Date.now() + 30 * DAY_MS),
      expiresRoleKey: CUSTOM_A,
    });
    await assignLoose(db, {
      uid: TARGET,
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair'],
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
    });
    const doc = db.read('roles', TARGET);
    expect(doc?.additionalRoles).toEqual(['chapter_events_chair']);
    for (const field of EXPIRY_FIELDS) {
      expect(doc).not.toHaveProperty(field);
    }
  });

  it('8A.7 expiresAt: null clears a pending expiry with no composition change', async () => {
    const db = freshDb();
    seedCustomDefinition(db, CUSTOM_A, 'Poster Team Lead');
    await seedHolderWithCatalogRole(db);
    await assignLoose(db, {
      uid: TARGET,
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair', CUSTOM_A],
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
      expiresAt: new Date(Date.now() + 30 * DAY_MS),
      expiresRoleKey: CUSTOM_A,
    });
    await assignLoose(db, {
      uid: TARGET,
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair', CUSTOM_A],
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
      expiresAt: null,
      expiresRoleKey: CUSTOM_A,
    });
    const doc = db.read('roles', TARGET);
    expect(doc?.role).toBe('chapter_secretary');
    expect(doc?.additionalRoles).toEqual(['chapter_events_chair', CUSTOM_A]);
    for (const field of EXPIRY_FIELDS) {
      expect(doc).not.toHaveProperty(field);
    }
  });

  it('8A.8 removeRole on a doc with a pending expiry deletes the doc (the fields die with it)', async () => {
    const db = freshDb();
    seedCustomDefinition(db, CUSTOM_A, 'Poster Team Lead');
    await seedHolderWithCatalogRole(db);
    await assignLoose(db, {
      uid: TARGET,
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair', CUSTOM_A],
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
      expiresAt: new Date(Date.now() + 30 * DAY_MS),
      expiresRoleKey: CUSTOM_A,
    });
    expect(db.read('roles', TARGET)?.expiresRoleKey).toBe(CUSTOM_A);
    await removeRole(db.asDb(), {
      uid: TARGET,
      actorUid: ADMIN,
      reason: 'Cleanup of the grant record entirely',
      source: 'admin_ui',
    });
    expect(db.read('roles', TARGET)).toBeUndefined();
    expect(db.read('users', TARGET)?.role).toBe('member_basic');
  });

  it('8A.9 a plain catalog grant stamps no expiry fields (byte-identical behaviour to base)', async () => {
    const db = freshDb();
    await assignRole(db.asDb(), {
      uid: TARGET,
      role: 'chapter_president',
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
    });
    const doc = db.read('roles', TARGET);
    expect(doc?.role).toBe('chapter_president');
    for (const field of EXPIRY_FIELDS) {
      expect(doc).not.toHaveProperty(field);
    }
  });

  describe('8A.10 the system-actor guard (plan H8)', () => {
    function seedExpiringCustomGrant(db: FakeFirestore) {
      db.seed('roles', TARGET, {
        role: 'member',
        additionalRoles: [CUSTOM_A],
        chapterId: EXPIRY_CHAPTER,
        lastChangedBy: ADMIN,
        source: 'admin_ui',
        schemaVersion: 2,
        expiresAt: new Date(Date.now() - DAY_MS),
        expiresRoleKey: CUSTOM_A,
        priorRole: 'governor_coopted',
        priorAdditionalRoles: [],
        expiryAlertStage: 'none',
      });
    }

    it('a sweep-shaped call (actor system, source expiry_sweep) restoring an R4 prior primary succeeds and clears the fields', async () => {
      const db = freshDb();
      seedExpiringCustomGrant(db);
      const result = await assignLoose(db, {
        uid: TARGET,
        role: 'governor_coopted',
        additionalRoles: [],
        chapterId: EXPIRY_CHAPTER,
        actorUid: 'system',
        reason:
          'Custom role custom_poster_team_lead grant expired; prior state restored by the expiry sweep',
        source: 'expiry_sweep',
        expiresAt: null,
        expiresRoleKey: CUSTOM_A,
        idempotencyKey: `expiry:${TARGET}:${CUSTOM_A}:2026-10-22T00:00:00.000Z`,
      });
      expect(result.newEffectiveRole).toBe('governor_coopted');
      const doc = db.read('roles', TARGET);
      expect(doc?.role).toBe('governor_coopted');
      for (const field of EXPIRY_FIELDS) {
        expect(doc).not.toHaveProperty(field);
      }
    });

    it('the same system actor with source admin_ui is refused for an R4 primary', async () => {
      const db = freshDb();
      seedExpiringCustomGrant(db);
      await expect(
        assignLoose(db, {
          uid: TARGET,
          role: 'governor_coopted',
          additionalRoles: [],
          actorUid: 'system',
          reason: 'Attempted restore through the admin UI source',
          source: 'admin_ui',
        }),
      ).rejects.toMatchObject({ code: 'actor_not_authorized', httpStatus: 403 });
    });

    it('a sweep-shaped call whose target role is founder_patron for a non-founder still throws reserved_role', async () => {
      const db = freshDb();
      await expect(
        assignLoose(db, {
          uid: TARGET,
          role: 'founder_patron',
          actorUid: 'system',
          reason: 'Tampered snapshot claims the founder office',
          source: 'expiry_sweep',
        }),
      ).rejects.toMatchObject({ code: 'reserved_role', httpStatus: 403 });
    });
  });
});

// ---------------------------------------------------------------------------
// CLAIMS ABSORB (RP-11 structural, decision pack item 18): a committed
// role change stamps the user's Auth custom claims to the new role
// state, MERGING into the existing claims object - pre-existing
// unrelated claim keys (incl. the legacy boolean claims some route arms
// still check) must survive. The stamp is fire-and-log: its failure
// never fails the role write.
// ---------------------------------------------------------------------------

class FakeClaimsAuth implements RoleClaimsAuth {
  readonly claims = new Map<string, Record<string, unknown>>();
  readonly setCalls: Array<{ uid: string; claims: Record<string, unknown> }> = [];
  failGet = false;
  failSet = false;

  async getUser(uid: string): Promise<{ customClaims?: Record<string, unknown> }> {
    if (this.failGet) throw new Error('auth/user-not-found');
    return { customClaims: this.claims.get(uid) };
  }

  async setCustomUserClaims(uid: string, claims: Record<string, unknown>): Promise<void> {
    if (this.failSet) throw new Error('claims backend unavailable');
    this.setCalls.push({ uid, claims });
    this.claims.set(uid, claims);
  }
}

describe('claims absorb (claims stamping on the write path)', () => {
  it('assignRole stamps claims MERGED: role/chapter updated, unrelated pre-existing keys survive', async () => {
    const db = freshDb();
    const auth = new FakeClaimsAuth();
    auth.claims.set(TARGET, {
      role: 'member',
      chapter_id: 'old-chapter',
      manageTasks: true,
      canManageTasks: true,
      'permissions.canManageTasks': true,
      unrelatedFlag: 'keep-me',
    });
    await assignRole(db.asDb(), {
      uid: TARGET,
      role: 'chapter_president',
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
      claimsAuth: auth,
    });
    expect(db.read('roles', TARGET)?.role).toBe('chapter_president');
    expect(auth.setCalls).toHaveLength(1);
    expect(auth.setCalls[0].uid).toBe(TARGET);
    expect(auth.setCalls[0].claims).toEqual({
      role: 'chapter_president',
      chapter_id: 'seds-ist-chapter',
      manageTasks: true,
      canManageTasks: true,
      'permissions.canManageTasks': true,
      unrelatedFlag: 'keep-me',
    });
  });

  it('a demotion re-stamps the role claim down instead of leaving the stale office claim', async () => {
    const db = freshDb();
    const auth = new FakeClaimsAuth();
    auth.claims.set(TARGET, { role: 'projects_director', legacyBoolean: true });
    await assignRole(db.asDb(), {
      uid: TARGET,
      role: 'member',
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
      claimsAuth: auth,
    });
    expect(auth.claims.get(TARGET)).toEqual({
      role: 'member',
      chapter_id: 'seds-ist-chapter',
      legacyBoolean: true,
    });
  });

  it('removeRole clears the role claim by merge (unrelated keys survive, no wholesale replace)', async () => {
    const db = freshDb();
    const auth = new FakeClaimsAuth();
    await assignRole(db.asDb(), {
      uid: TARGET,
      role: 'chapter_president',
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
      claimsAuth: auth,
    });
    auth.claims.set(TARGET, {
      ...(auth.claims.get(TARGET) ?? {}),
      manageTasks: true,
    });
    await removeRole(db.asDb(), {
      uid: TARGET,
      actorUid: ADMIN,
      reason: 'Term ended October 2026',
      source: 'admin_ui',
      claimsAuth: auth,
    });
    const after = auth.claims.get(TARGET);
    expect(after).not.toHaveProperty('role');
    expect(after?.manageTasks).toBe(true);
    expect(after?.chapter_id).toBe('seds-ist-chapter');
  });

  it('a claims failure never fails the role write (fire-and-log)', async () => {
    const db = freshDb();
    const auth = new FakeClaimsAuth();
    auth.failGet = true; // e.g. the account has no Auth record
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await assignRole(db.asDb(), {
        uid: TARGET,
        role: 'chapter_secretary',
        actorUid: ADMIN,
        reason: REASON,
        source: 'admin_ui',
        claimsAuth: auth,
      });
      expect(result.alreadyApplied).toBe(false);
      expect(db.read('roles', TARGET)?.role).toBe('chapter_secretary');
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('stampRoleClaims with auth null is a no-op; a failing set returns false instead of throwing', async () => {
    const auth = new FakeClaimsAuth();
    auth.failSet = true;
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        stampRoleClaims(TARGET, { role: 'member', chapterId: null }, null),
      ).resolves.toBe(false);
      await expect(
        stampRoleClaims(TARGET, { role: 'member', chapterId: null }, auth),
      ).resolves.toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });
});
