/**
 * Phase 1 Workstream B - reconciliation classification and report-mode
 * purity (spec B.8 suite 6), driven by the users-shapes fixtures.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { FakeFirestore } from './helpers/fake-firestore';
import { reconcileRoles } from '../server/role-reconciliation';

const shapes = JSON.parse(
  readFileSync(join(__dirname, '../../test-fixtures/phase1/users-shapes.json'), 'utf8'),
) as {
  cases: Array<{
    name: string;
    uid: string;
    roles: Record<string, unknown> | null;
    users: Record<string, unknown> | null;
    expectedClass: string | null;
    expectedEffectiveRole: string | null;
  }>;
};

function seedCase(db: FakeFirestore, c: (typeof shapes.cases)[number]): void {
  if (c.roles) db.seed('roles', c.uid, c.roles);
  if (c.users) db.seed('users', c.uid, c.users);
}

describe('reconciliation (fixtures)', () => {
  it('classifies every fixture case as expected', async () => {
    const db = new FakeFirestore();
    for (const c of shapes.cases) seedCase(db, c);
    const report = await reconcileRoles(db.asDb(), { mode: 'report' });
    for (const c of shapes.cases) {
      const entry = report.entries.find((e) => e.uid === c.uid);
      if (c.expectedClass === null) {
        expect(entry).toBeUndefined();
      } else {
        expect(entry?.class).toBe(c.expectedClass);
      }
      if (entry && c.expectedEffectiveRole) {
        expect(entry.rolesEffective ?? entry.mirrorEffective).toBe(c.expectedEffectiveRole);
      }
    }
    expect(report.counts['roles-only']).toBe(1);
    expect(report.counts['users-only']).toBe(1);
    expect(report.counts['users-only-bootstrap']).toBe(1);
    expect(report.counts['conflicting-role']).toBe(2);
    expect(report.counts['stale-displayRole']).toBe(1);
  });

  it('report mode performs ZERO role-store writes', async () => {
    const db = new FakeFirestore();
    for (const c of shapes.cases) seedCase(db, c);
    const before = JSON.stringify(
      [...db.store.entries()].map(([k, v]) => [k, [...v.entries()]]),
    );
    await reconcileRoles(db.asDb(), { mode: 'report' });
    const after = JSON.stringify(
      [...db.store.entries()].map(([k, v]) => [k, [...v.entries()]]),
    );
    expect(after).toBe(before);
  });

  it('repair mode fixes stale-displayRole via setMirror and bootstraps basic members', async () => {
    const db = new FakeFirestore();
    for (const c of shapes.cases) seedCase(db, c);
    const report = await reconcileRoles(db.asDb(), {
      mode: 'repair',
      actorUid: 'recon-actor',
    });
    const stale = report.entries.find((e) => e.class === 'stale-displayRole');
    expect(stale?.repaired).toBe('setMirror');
    expect(db.read('users', 'fake-user-stale-display')?.displayRole).toBe('member');

    const bootstrap = report.entries.find((e) => e.class === 'users-only-bootstrap');
    expect(bootstrap?.repaired).toBe('assignRole(member_basic)');
    expect(db.read('roles', 'fake-user-bootstrap')?.role).toBe('member_basic');
  });

  it('repair mode never auto-repairs users-only (a real claim needs a human)', async () => {
    const db = new FakeFirestore();
    for (const c of shapes.cases) seedCase(db, c);
    const report = await reconcileRoles(db.asDb(), { mode: 'repair', actorUid: 'recon-actor' });
    const usersOnly = report.entries.find((e) => e.class === 'users-only');
    expect(usersOnly?.repaired).toBeUndefined();
    expect(db.read('roles', 'fake-user-stale-claim')).toBeUndefined();
  });

  it('orphan roleHistory is reported and never deleted', async () => {
    const db = new FakeFirestore();
    db.seed('roleHistory', 'h1', { uid: 'ghost-uid', roleKey: 'member', action: 'grant' });
    const report = await reconcileRoles(db.asDb(), { mode: 'repair', actorUid: 'recon-actor' });
    expect(report.counts['orphan-roleHistory']).toBe(1);
    expect(db.read('roleHistory', 'h1')).toBeDefined();
  });
});
