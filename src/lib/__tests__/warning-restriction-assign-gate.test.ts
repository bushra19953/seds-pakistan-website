/**
 * Warning 2 leadership restriction (founder decision 2026-11-06,
 * sunset ladder): while a member's current warning level is 2 or
 * higher, assignRole / validateAssignRoleInput refuse grants that
 * include a leadership seat (role catalog categories A, B, C) with
 * RoleWriteError 'warning_restricted' 403. Member and deputy grants
 * are never gated, and a lapsed chain gates nothing.
 *
 * Runs the REAL role-writes module against the discipline fake
 * Firestore (which supports the users/{uid}/warnings subcollection
 * the ladder reads).
 */
import { makeFakeDb } from '../server/discipline/__tests__/fake-firestore';
import {
  RoleWriteError,
  assertNoWarningRestriction,
  isLeadershipRoleKey,
  validateAssignRoleInput,
} from '../server/role-writes';

const DAY = 24 * 60 * 60 * 1000;
const TARGET = 'target-user-uid';

function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY).toISOString();
}

function seedWarnings(db: any, specs: Array<{ id: string; createdDaysAgo: number }>) {
  db.seed(`users/${TARGET}`, { displayName: 'Target User', chapterId: 'seds-ist-chapter' });
  for (const s of specs) {
    db.seed(`users/${TARGET}/warnings/${s.id}`, {
      reason: 'Test warning',
      type: 'missed-deadline',
      isActive: true,
      isPermanent: false,
      createdAt: daysAgo(s.createdDaysAgo),
    });
  }
}

const asDb = (db: any) => db as never;

function input(role: string, additionalRoles?: string[]) {
  return {
    uid: TARGET,
    role: role as never,
    additionalRoles: additionalRoles as never,
    actorUid: 'admin-actor-uid',
    reason: 'Appointed by the National President, November 2026 intake',
    source: 'admin_ui' as never,
  };
}

describe('isLeadershipRoleKey: catalog categories A, B, C only', () => {
  it('classifies leadership seats and non-leadership roles', () => {
    expect(isLeadershipRoleKey('president_national')).toBe(true); // B
    expect(isLeadershipRoleKey('chapter_president')).toBe(true); // C
    expect(isLeadershipRoleKey('chapter_marketing_chair')).toBe(true); // C
    expect(isLeadershipRoleKey('faculty_advisor')).toBe(false); // D
    expect(isLeadershipRoleKey('member_basic')).toBe(false); // GENERAL_BODY
    expect(isLeadershipRoleKey('member')).toBe(false); // GENERAL_BODY
    expect(isLeadershipRoleKey('custom_finance_deputy')).toBe(false); // not a catalog key
    expect(isLeadershipRoleKey('not-a-role')).toBe(false);
    expect(isLeadershipRoleKey(undefined)).toBe(false);
  });
});

describe('assertNoWarningRestriction', () => {
  it('blocks a leadership grant while Warning 2 is active', async () => {
    const db = makeFakeDb();
    seedWarnings(db, [
      { id: 'w1', createdDaysAgo: 10 },
      { id: 'w2', createdDaysAgo: 2 },
    ]);
    const err = await assertNoWarningRestriction(asDb(db), input('chapter_president')).catch((e) => e);
    expect(err).toBeInstanceOf(RoleWriteError);
    expect(err.code).toBe('warning_restricted');
    expect(err.httpStatus).toBe(403);
  });

  it('blocks when the leadership seat arrives as an additional role', async () => {
    const db = makeFakeDb();
    seedWarnings(db, [
      { id: 'w1', createdDaysAgo: 10 },
      { id: 'w2', createdDaysAgo: 2 },
    ]);
    const err = await assertNoWarningRestriction(asDb(db), input('member_basic', ['chapter_treasurer'])).catch((e) => e);
    expect(err).toBeInstanceOf(RoleWriteError);
    expect(err.code).toBe('warning_restricted');
  });

  it('never blocks member or deputy grants, even at Warning 2', async () => {
    const db = makeFakeDb();
    seedWarnings(db, [
      { id: 'w1', createdDaysAgo: 10 },
      { id: 'w2', createdDaysAgo: 2 },
    ]);
    await expect(assertNoWarningRestriction(asDb(db), input('member_basic'))).resolves.toBeUndefined();
    await expect(assertNoWarningRestriction(asDb(db), input('faculty_advisor'))).resolves.toBeUndefined();
  });

  it('allows leadership grants at Warning 1, and after the chain lapses', async () => {
    const db1 = makeFakeDb();
    seedWarnings(db1, [{ id: 'w1', createdDaysAgo: 10 }]);
    await expect(assertNoWarningRestriction(asDb(db1), input('chapter_president'))).resolves.toBeUndefined();

    const db2 = makeFakeDb();
    seedWarnings(db2, [
      { id: 'w1', createdDaysAgo: 100 },
      { id: 'w2', createdDaysAgo: 95 },
    ]);
    // Chain of two, but the second warning is 95 days old: its
    // 60-day sunset passed 35 days ago, so the level is 0.
    await expect(assertNoWarningRestriction(asDb(db2), input('chapter_president'))).resolves.toBeUndefined();
  });
});

describe('validateAssignRoleInput integration', () => {
  it('surfaces warning_restricted for a leadership grant at Warning 2', async () => {
    const db = makeFakeDb();
    seedWarnings(db, [
      { id: 'w1', createdDaysAgo: 10 },
      { id: 'w2', createdDaysAgo: 2 },
    ]);
    const err = await validateAssignRoleInput(asDb(db), input('chapter_president')).catch((e) => e);
    expect(err).toBeInstanceOf(RoleWriteError);
    expect(err.code).toBe('warning_restricted');
    expect(err.httpStatus).toBe(403);
  });

  it('passes validation for the same grant once the chain has lapsed', async () => {
    const db = makeFakeDb();
    seedWarnings(db, [{ id: 'w1', createdDaysAgo: 45 }]);
    await expect(validateAssignRoleInput(asDb(db), input('chapter_president'))).resolves.toBeUndefined();
  });
});
