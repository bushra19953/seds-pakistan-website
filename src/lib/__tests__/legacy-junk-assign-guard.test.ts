/**
 * LEGACY-JUNK item (Custom Roles Fix Program), plan section 9.3 substance.
 *
 * Plan 9.3 names these pins for src/lib/__tests__/role-writes.test.ts under
 * assign-path's ownership; they live in this legacy-junk-owned file instead
 * so this item never edits another item's test file (status-board W3). The
 * assertions are the ones the acceptance auditor checks for: a junk slug
 * fails ASSIGN-validation exactly like an unknown slug - same RoleWriteError
 * code, same HTTP status, same message shape - through the single write
 * path (role-writes assignRole -> validateRoleKey, role-writes.ts:106-116).
 *
 * These pins pass on today's code already (validateRoleKey accepts catalog
 * keys only); they exist so assign-path's custom-role branch cannot regress
 * them when it teaches the write path to admit `custom_` additionals.
 */
import { FakeFirestore } from './helpers/fake-firestore';
import { assignRole, RoleWriteError } from '../server/role-writes';

const ADMIN = 'admin-actor-uid';
const TARGET = 'target-user-uid';
const REASON = 'Appointed by the National President, October 2026 intake';

const JUNK_IDS = ['pakistan-president', 'super-admin', 'chair-design-media', 'advisor-faculty-head'];

function freshDb(): FakeFirestore {
  const db = new FakeFirestore();
  db.seed('users', TARGET, { displayName: 'Target User', chapterId: 'seds-ist-chapter' });
  return db;
}

async function assignError(role: string, additionalRoles?: string[]): Promise<RoleWriteError> {
  const db = freshDb();
  try {
    await assignRole(db.asDb(), {
      uid: TARGET,
      role: role as never,
      additionalRoles: additionalRoles as never,
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
    });
  } catch (err) {
    expect(db.read('roles', TARGET)).toBeUndefined();
    return err as RoleWriteError;
  }
  throw new Error(`assignRole unexpectedly succeeded for role "${role}"`);
}

describe('assign-validation: junk slugs fail exactly like unknown slugs', () => {
  it.each(JUNK_IDS)('junk id %s as primary role throws unknown_role 400 and writes nothing', async (junk) => {
    const err = await assignError(junk);
    expect(err).toBeInstanceOf(RoleWriteError);
    expect(err.name).toBe('RoleWriteError');
    expect(err.code).toBe('unknown_role');
    expect(err.httpStatus).toBe(400);
    expect(err.message).toBe(`Role "${junk}" is not in the catalog`);
  });

  it('an unknown invented slug throws the identical error shape (control)', async () => {
    const err = await assignError('media_lead');
    expect(err).toBeInstanceOf(RoleWriteError);
    expect(err.code).toBe('unknown_role');
    expect(err.httpStatus).toBe(400);
    expect(err.message).toBe('Role "media_lead" is not in the catalog');
  });

  it('junk and unknown errors are indistinguishable modulo the slug itself', async () => {
    for (const junk of JUNK_IDS) {
      const junkErr = await assignError(junk);
      const unknownErr = await assignError('media_lead');
      expect(junkErr.name).toBe(unknownErr.name);
      expect(junkErr.code).toBe(unknownErr.code);
      expect(junkErr.httpStatus).toBe(unknownErr.httpStatus);
      expect(junkErr.message.replace(junk, '<slug>')).toBe(
        unknownErr.message.replace('media_lead', '<slug>'),
      );
    }
  });

  it.each([
    'Super-Admin',
    'SUPER-ADMIN',
    ' super-admin ',
    'super admin',
    'Chair-Design-Media',
    'PAKISTAN-PRESIDENT',
    'Advisor-Faculty-Head',
  ])('normalisation variant %j of a junk id also throws unknown_role', async (raw) => {
    const err = await assignError(raw);
    expect(err.code).toBe('unknown_role');
    expect(err.httpStatus).toBe(400);
  });

  it("the exact legacy key 'super_admin' also fails assign-validation (assign is catalog-only; ruling C2 keeps it legacy, not assignable)", async () => {
    const err = await assignError('super_admin');
    expect(err.code).toBe('unknown_role');
    expect(err.httpStatus).toBe(400);
  });

  it.each(JUNK_IDS)('junk id %s in additionalRoles throws unknown_role and writes nothing', async (junk) => {
    const err = await assignError('chapter_president', [junk]);
    expect(err).toBeInstanceOf(RoleWriteError);
    expect(err.code).toBe('unknown_role');
    expect(err.httpStatus).toBe(400);
    expect(err.message).toBe(`Role "${junk}" is not in the catalog`);
  });

  it('control: a catalog role assigns cleanly through the same harness', async () => {
    const db = freshDb();
    const result = await assignRole(db.asDb(), {
      uid: TARGET,
      role: 'chapter_president',
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
    });
    expect(result.newEffectiveRole).toBe('chapter_president');
    expect(db.read('roles', TARGET)).toMatchObject({ role: 'chapter_president' });
  });
});
