/**
 * Rules-text tests for the Item 6 listability delta (spec 6(f)).
 *
 * There is no rules emulator harness in this repo; like
 * application-submit-rules.test.ts and the Item 4 points suite, these
 * tests parse the rules text and pin the grant lines. They prove the
 * text is present and correctly placed, not engine behaviour (the
 * live probes after publish cover that).
 *
 * The delta ships ONLY in the Batch 1 publish file. Run against the
 * assembled candidate with FIRESTORE_RULES_PATH=<batch file>; against
 * the repo working tree (the default), cases 1, 3 and 4 fail until
 * the post-publish mirror step copies the published content into the
 * repo file. That pre-mirror failure is the expected state, recorded
 * in the Batch 1 assembly summary.
 */

import * as fs from 'fs';
import * as path from 'path';

const RULES_PATH =
  process.env.FIRESTORE_RULES_PATH ||
  path.join(__dirname, '..', '..', '..', 'firestore.rules');

const rules = fs.readFileSync(RULES_PATH, 'utf8');

function block(startMarker: string, endMarkers: string[]): string {
  const start = rules.indexOf(startMarker);
  if (start === -1) throw new Error(`block start not found: ${startMarker}`);
  let end = rules.length;
  for (const m of endMarkers) {
    const idx = rules.indexOf(m, start + startMarker.length);
    if (idx !== -1 && idx < end) end = idx;
  }
  return rules.slice(start, end);
}

const usersBlock = block('match /users/{userId} {', [
  'match /users/{userId}/votes',
  'match /roles/{userId}',
]);
const rolesBlock = block('match /roles/{userId} {', [
  '// =============================================================\n    // CONTENT COLLECTIONS',
  'match /chapters',
]);

describe('Item 6 users/roles listability (rules text)', () => {
  it('1. users list is gated by canListRegister(); the combined signed-in grant is gone', () => {
    expect(usersBlock).toContain('allow list: if canListRegister();');
    expect(usersBlock).not.toContain('allow get, list: if isSignedIn();');
  });

  it('2. users GET stays signed-in in Phase 0 (deliberate)', () => {
    expect(usersBlock).toContain('allow get: if isSignedIn();');
  });

  it('3. roles list is gated; roles GET is owner-or-register; no signed-in read grant remains', () => {
    expect(rolesBlock).toContain('allow list: if canListRegister();');
    expect(rolesBlock).toContain(
      'allow get: if isOwner(userId) || canListRegister();'
    );
    expect(rolesBlock).not.toContain('isSignedIn()');
  });

  it('4. canListRegister() is defined exactly once with the required members', () => {
    const occurrences = rules.split('function canListRegister()').length - 1;
    expect(occurrences).toBe(1);
    const helperStart = rules.indexOf('function canListRegister()');
    const helper = rules.slice(helperStart, rules.indexOf('}', helperStart));
    expect(helper).toContain('isSuperAdmin()');
    expect(helper).toContain('isPresident()');
    expect(helper).toContain('isFounder()');
    expect(helper).toContain("hasPermission('canManageUsers')");
    expect(helper).toContain("hasPermission('canManageStore')");
  });

  it('5. the roles write grant keeps its gate; reserved-role guards live in the catalog validator (live Phase 1 shape)', () => {
    // CONVERGENCE (2026-10-28 security wave, audit item 6): the repo
    // rules were converged onto the LIVE ruleset text (325ab07c,
    // published as e73be496). The live Phase 1 (Publish 1) design
    // retired the inline guards (!isTargetSuperAdmin, role !=
    // 'superadmin' / 'president_national' string compares) in favour
    // of isValidRoleDocData: the role must be a catalog key, and
    // founder_patron is bound to the founder UID. The write gate
    // itself (superadmin / president / founder / canManageRoles) is
    // unchanged, and client deletes are denied outright.
    expect(rolesBlock).toContain("hasPermission('canManageRoles')");
    expect(rolesBlock).toContain('isValidRoleDocData(request.resource.data, userId)');
    expect(rolesBlock).toContain('allow delete: if false');
    expect(rules).toContain('isCatalogRoleKey(data.role)');
    expect(rules).toContain("data.role != 'founder_patron' || userId ==");
  });

  it('6. users subcollection grants are untouched', () => {
    expect(rules).toContain(
      'match /users/{userId}/votes/{voterId} {\n      allow get, list: if isSignedIn();'
    );
    expect(rules).toContain(
      'match /users/{userId}/private/contact {\n      allow get: if isOwner(userId) || isSuperAdmin() || hasPermission(\'canManageUsers\');'
    );
  });

  it('7. neighbouring privileged grants are untouched', () => {
    expect(rules).toContain(
      'match /permissions/{roleId} {\n      allow get: if isExecutive() || (isSignedIn() && roleId.lower() == currentRole().lower());\n      allow list: if isExecutive();'
    );
    expect(rules).toContain(
      'match /roleDefinitions/{id} {\n      allow get: if isSignedIn();\n      allow list: if isExecutive() || hasPermission(\'canManagePermissions\');'
    );
  });
});
