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
  RoleWriteError,
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
