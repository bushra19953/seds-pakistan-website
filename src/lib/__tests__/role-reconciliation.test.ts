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

// ---------------------------------------------------------------------------
// CLAIMS ABSORB (RP-11 structural, decision pack item 18): with a claims
// snapshot supplied, reconciliation reports a claims-divergence class -
// detection only, in report AND repair mode. The named shapes (RP-11 /
// E3): a stale role claim against a stored member/member_basic, and a
// missing appointment claim (an appointed office with no role claim).
// An absent claim on a basic member is CLEAN (the bootstrap population
// is legitimately claim-free), and a claim equal to the roles-doc
// primary is consistent.
// ---------------------------------------------------------------------------

describe('reconciliation (claims-divergence class)', () => {
  function seedAccount(
    db: FakeFirestore,
    uid: string,
    primary: string,
  ): void {
    db.seed('roles', uid, { role: primary, additionalRoles: [], chapterId: 'seds-ist-chapter' });
    db.seed('users', uid, { role: primary, displayRole: primary, chapterId: 'seds-ist-chapter' });
  }

  it('flags a stale role claim against a stored member (the Roha shape)', async () => {
    const db = new FakeFirestore();
    seedAccount(db, 'uid-stale-claim', 'member');
    const claimsByUid = new Map<string, Record<string, unknown>>([
      ['uid-stale-claim', { role: 'projects_director', chapter_id: 'seds-ist-chapter' }],
    ]);
    const report = await reconcileRoles(db.asDb(), { mode: 'report', claimsByUid });
    expect(report.counts['claims-divergence']).toBe(1);
    const entry = report.entries.find((e) => e.uid === 'uid-stale-claim');
    expect(entry?.class).toBe('claims-divergence');
    expect(entry?.detail).toContain('projects_director');
    expect(entry?.rolesEffective).toBe('member');
  });

  it('flags a missing appointment claim (the Ahmed shape: appointed office, no role claim)', async () => {
    const db = new FakeFirestore();
    seedAccount(db, 'uid-missing-appointment', 'chapter_events_chair');
    const claimsByUid = new Map<string, Record<string, unknown>>([
      ['uid-missing-appointment', {}],
    ]);
    const report = await reconcileRoles(db.asDb(), { mode: 'report', claimsByUid });
    expect(report.counts['claims-divergence']).toBe(1);
    const entry = report.entries.find((e) => e.uid === 'uid-missing-appointment');
    expect(entry?.class).toBe('claims-divergence');
    expect(entry?.detail).toContain('missing appointment claim');
    expect(entry?.rolesEffective).toBe('chapter_events_chair');
  });

  it('does not flag consistent accounts: claim equal to primary, and a claim-free basic member', async () => {
    const db = new FakeFirestore();
    seedAccount(db, 'uid-consistent', 'chapter_events_chair');
    seedAccount(db, 'uid-basic-claimfree', 'member_basic');
    const claimsByUid = new Map<string, Record<string, unknown>>([
      ['uid-consistent', { role: 'chapter_events_chair', chapter_id: 'seds-ist-chapter' }],
      ['uid-basic-claimfree', {}],
    ]);
    const report = await reconcileRoles(db.asDb(), { mode: 'report', claimsByUid });
    expect(report.counts['claims-divergence']).toBe(0);
    expect(report.entries.find((e) => e.class === 'claims-divergence')).toBeUndefined();
  });

  it('claims detection is report-only even in repair mode (no claims or doc writes)', async () => {
    const db = new FakeFirestore();
    seedAccount(db, 'uid-stale-claim', 'member_basic');
    const claimsByUid = new Map<string, Record<string, unknown>>([
      ['uid-stale-claim', { role: 'national_marketing' }],
    ]);
    const before = JSON.stringify(
      [...db.store.entries()].map(([k, v]) => [k, [...v.entries()]]),
    );
    const report = await reconcileRoles(db.asDb(), {
      mode: 'repair',
      actorUid: 'recon-actor',
      claimsByUid,
    });
    const entry = report.entries.find((e) => e.uid === 'uid-stale-claim');
    expect(entry?.class).toBe('claims-divergence');
    expect(entry?.repaired).toBeUndefined();
    const after = JSON.stringify(
      [...db.store.entries()].map(([k, v]) => [k, [...v.entries()]]),
    );
    expect(after).toBe(before);
  });

  it('without a claims snapshot, no claims-divergence entries are produced', async () => {
    const db = new FakeFirestore();
    seedAccount(db, 'uid-unchecked', 'member');
    const report = await reconcileRoles(db.asDb(), { mode: 'report' });
    expect(report.counts['claims-divergence']).toBe(0);
  });
});
