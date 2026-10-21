/**
 * Firestore rules tests for the Phase 2 B + C candidate
 * (~/workspace/bylaws_incorporation/implementation/rules-candidates/
 *  p2-gates-board.rules.txt).
 *
 * REQUIRES the Firestore emulator:
 *   firebase emulators:exec --only firestore "npm run test:rules"
 * (or FIRESTORE_EMULATOR_HOST set). Run via the separate jest.rules.config.js
 * so the main suite never depends on the emulator.
 *
 * Cases: spec C.7 rules cases 32-42 plus the Section B closures (roles
 * carve-out, chapters lifecycle lock, positions, chapter applications,
 * partner flags, settings/governance carve-out).
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  doc,
  getDoc,
  getDocs,
  collection,
  setDoc,
  updateDoc,
  deleteDoc,
} from 'firebase/firestore';

const FOUNDER_UID = 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';
const CANDIDATE_PATH = resolve(
  __dirname,
  '../../../bylaws_incorporation/implementation/rules-candidates/p2-gates-board.rules.txt',
);

let testEnv: RulesTestEnvironment;

async function seed() {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const set = (path: string, data: Record<string, unknown>) =>
      setDoc(doc(db, path), data);
    // Role docs (currentRole() reads roles/{uid}.role).
    await set(`roles/${FOUNDER_UID}`, { role: 'member' }); // Founder authority is the UID, not the role
    await set('roles/president-1', { role: 'president_national' });
    await set('roles/cto-1', { role: 'chief_technology_officer' });
    await set('roles/patron-1', { role: 'founder_patron' });
    await set('roles/treasurer-1', { role: 'national_treasurer' });
    await set('roles/ngs-1', { role: 'national_general_secretary' });
    await set('roles/gov-1', { role: 'governor_member' });
    await set('roles/govf-1', { role: 'governor_founder' });
    await set('roles/member-1', { role: 'member' });
    await set('roles/admin-1', { role: 'superadmin' });
    // Permission matrix docs.
    await set('permissions/chief_technology_officer', { canManagePermissions: true });
    await set('permissions/founder_patron', {});
    await set('permissions/national_treasurer', { canManagePermissions: true });
    await set('permissions/president_national', {});
    // Fixtures.
    await set('roleDefinitions/chair_events', { name: 'Chair Events' });
    await set('permissions/chair_events', {});
    await set('role_permissions/chair_events', {});
    await set('applications/app-1', { uid: 'applicant-1', email: 'a@example.com', status: 'pending' });
    await set('users/victim-1', { displayName: 'Victim' });
    await set('chapters/ch-1', { name: 'IST', status: 'active', isActive: true });
    await set('users/member-1/warnings/w-1', { reason: 'test' });
    await set('governors/seat_fa_1', { seatKey: 'seat_fa_1', status: 'vacant' });
    await set('sponsors_partners/flagged-1', { organizationName: 'Flagged', isRelatedParty: true });
    await set('sponsors_partners/plain-1', { organizationName: 'Plain' });
    await set('chapter_applications/ca-1', { userId: 'applicant-1', status: 'pending' });
    await set('positions/pos-1', { title: 'Chair' });
    await set('settings/governance', { boardLive: false });
    await set('settings/general', { trustBar: true });
  });
}

function dbFor(uid: string | null) {
  const ctx = uid
    ? testEnv.authenticatedContext(uid)
    : testEnv.unauthenticatedContext();
  return ctx.firestore();
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'seds-p2-gates-rules-test',
    firestore: {
      rules: readFileSync(CANDIDATE_PATH, 'utf8'),
      host: process.env.FIRESTORE_EMULATOR_HOST?.split(':')[0] ?? '127.0.0.1',
      port: Number(process.env.FIRESTORE_EMULATOR_HOST?.split(':')[1] ?? 8080),
    },
  });
  await seed();
});

afterEach(async () => {
  await testEnv.clearFirestore();
  await seed();
});

afterAll(async () => {
  await testEnv.cleanup();
});

// ---------------------------------------------------------------------------
// Authority matrix re-keying (spec C.7 cases 32-37, 42)
// ---------------------------------------------------------------------------

it('case 32: president_national can no longer write roleDefinitions', async () => {
  const db = dbFor('president-1');
  await assertFails(updateDoc(doc(db, 'roleDefinitions/chair_events'), { name: 'X' }));
});

it('case 33: president_national cannot write permissions or role_permissions', async () => {
  const db = dbFor('president-1');
  await assertFails(updateDoc(doc(db, 'permissions/chair_events'), { canManageUsers: true }));
  await assertFails(updateDoc(doc(db, 'role_permissions/chair_events'), { canManageUsers: true }));
  await assertFails(deleteDoc(doc(db, 'permissions/chair_events')));
});

it('case 34: CTO with canManagePermissions can write roleDefinitions', async () => {
  const db = dbFor('cto-1');
  await assertSucceeds(updateDoc(doc(db, 'roleDefinitions/chair_events'), { name: 'Y' }));
});

it('case 35: CTO without the canManagePermissions grant cannot write roleDefinitions', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'permissions/chief_technology_officer'), {});
  });
  const db = dbFor('cto-1');
  await assertFails(updateDoc(doc(db, 'roleDefinitions/chair_events'), { name: 'Y' }));
});

it('case 36: founder_patron without the grant cannot write; with the grant can', async () => {
  const db = dbFor('patron-1');
  await assertFails(updateDoc(doc(db, 'roleDefinitions/chair_events'), { name: 'Z' }));
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'permissions/founder_patron'), { canManagePermissions: true });
  });
  await assertSucceeds(updateDoc(doc(db, 'roleDefinitions/chair_events'), { name: 'Z' }));
});

it('case 37: a canManagePermissions holder who is neither Founder, patron, nor CTO cannot write the matrix', async () => {
  const db = dbFor('treasurer-1');
  await assertFails(updateDoc(doc(db, 'roleDefinitions/chair_events'), { name: 'W' }));
});

it('case 42: isGovernor does not leak into the matrix gate (governor_founder cannot write roleDefinitions)', async () => {
  const db = dbFor('govf-1');
  await assertFails(updateDoc(doc(db, 'roleDefinitions/chair_events'), { name: 'V' }));
});

// ---------------------------------------------------------------------------
// Founder disjuncts (spec C.7 cases 38-39)
// ---------------------------------------------------------------------------

it('case 38: the Founder can read applications (get and list) with a non-executive stored role', async () => {
  const db = dbFor(FOUNDER_UID);
  await assertSucceeds(getDoc(doc(db, 'applications/app-1')));
  await assertSucceeds(getDocs(collection(db, 'applications')));
});

it('case 39: the Founder can delete a user doc, update a chapter cosmetically, and write a warnings doc', async () => {
  const db = dbFor(FOUNDER_UID);
  await assertSucceeds(deleteDoc(doc(db, 'users/victim-1')));
  await assertSucceeds(updateDoc(doc(db, 'chapters/ch-1'), { name: 'IST Chapter' }));
  await assertSucceeds(updateDoc(doc(db, 'users/member-1/warnings/w-1'), { reason: 'updated' }));
});

// ---------------------------------------------------------------------------
// Governors collection (spec C.7 cases 40-41)
// ---------------------------------------------------------------------------

it('case 40: governors denies all client writes, including from the Founder and the NGS', async () => {
  for (const uid of [FOUNDER_UID, 'ngs-1']) {
    const db = dbFor(uid);
    await assertFails(updateDoc(doc(db, 'governors/seat_fa_1'), { status: 'seated' }));
    await assertFails(setDoc(doc(db, 'governors/seat_fa_1/history/e1'), { eventType: 'seated' }));
  }
});

it('case 41: governors read is allowed for NGS and Governor roles, denied for a plain member and anonymous', async () => {
  await assertSucceeds(getDoc(doc(dbFor('ngs-1'), 'governors/seat_fa_1')));
  await assertSucceeds(getDoc(doc(dbFor('gov-1'), 'governors/seat_fa_1')));
  await assertFails(getDoc(doc(dbFor('member-1'), 'governors/seat_fa_1')));
  await assertFails(getDoc(doc(dbFor(null), 'governors/seat_fa_1')));
});

// ---------------------------------------------------------------------------
// Section B closures
// ---------------------------------------------------------------------------

it('B.4.1: users may create only their OWN roles doc at the member tier; updates are denied to everyone client-side', async () => {
  const db = dbFor('member-1');
  await assertSucceeds(setDoc(doc(db, 'roles/member-1'), { role: 'member' }, { merge: false }));
  const db2 = dbFor('new-user-1');
  await assertFails(setDoc(doc(db2, 'roles/new-user-1'), { role: 'executive_director' }));
  await assertFails(setDoc(doc(db2, 'roles/someone-else'), { role: 'member' }));
  await assertFails(updateDoc(doc(db, 'roles/member-1'), { role: 'member' }));
});

it('B.4.3: chapter lifecycle fields are locked client-side; cosmetic edits still work; create/delete denied', async () => {
  const db = dbFor('admin-1');
  await assertSucceeds(updateDoc(doc(db, 'chapters/ch-1'), { name: 'Renamed' }));
  await assertFails(updateDoc(doc(db, 'chapters/ch-1'), { status: 'suspended' }));
  await assertFails(updateDoc(doc(db, 'chapters/ch-1'), { isActive: false }));
  await assertFails(setDoc(doc(db, 'chapters/ch-2'), { name: 'New' }));
  await assertFails(deleteDoc(doc(db, 'chapters/ch-1')));
});

it('B.4.4: positions writes and chapter_applications updates are denied client-side', async () => {
  const db = dbFor('admin-1');
  await assertFails(updateDoc(doc(db, 'positions/pos-1'), { title: 'New Title' }));
  await assertFails(updateDoc(doc(db, 'chapter_applications/ca-1'), { status: 'approved' }));
  await assertFails(deleteDoc(doc(db, 'chapter_applications/ca-1')));
});

it('B.4.5: flagged partner writes are denied client-side on both images; unflagged writes pass', async () => {
  const db = dbFor('admin-1');
  await assertFails(
    setDoc(doc(db, 'sponsors_partners/new-flagged'), { organizationName: 'X', isRelatedParty: true }),
  );
  await assertSucceeds(
    setDoc(doc(db, 'sponsors_partners/new-plain'), { organizationName: 'Y' }),
  );
  // Pre-image flagged: even an update whose post-image clears the flags is denied.
  await assertFails(
    updateDoc(doc(db, 'sponsors_partners/flagged-1'), { isRelatedParty: false, carriesConditions: false }),
  );
  // Post-image flagged: flagging an existing plain record client-side is denied.
  await assertFails(
    updateDoc(doc(db, 'sponsors_partners/plain-1'), { carriesConditions: true }),
  );
  await assertSucceeds(
    updateDoc(doc(db, 'sponsors_partners/plain-1'), { organizationName: 'Plain Renamed' }),
  );
});

it('B.4.6: settings/governance is signed-in read, Founder-only write; other settings keep the public posture', async () => {
  await assertFails(getDoc(doc(dbFor(null), 'settings/governance')));
  await assertSucceeds(getDoc(doc(dbFor('member-1'), 'settings/governance')));
  await assertSucceeds(updateDoc(doc(dbFor(FOUNDER_UID), 'settings/governance'), { boardLive: true }));
  await assertFails(updateDoc(doc(dbFor('admin-1'), 'settings/governance'), { boardLive: true }));
  await assertSucceeds(getDoc(doc(dbFor(null), 'settings/general')));
});
