/**
 * Rules candidate v3 (Full Member derivation) guard: the candidate
 * lives OUTSIDE the repo next to the v2 candidate it stacks on (batched
 * Console publish, owner-gated). This suite pins, in the established
 * rules-text style of rules-candidate-v2-custom-roles.test.ts:
 *  - isFullMember() derives from the caller's roles/{uid} primary role
 *    == 'member' (GOV-03 / decision pack item 31; Decision 9 revisited),
 *    as a total function (exists() guard + .get('role', null): a
 *    missing roles doc or role field yields false, never an error);
 *  - the retired `return false` fallback is gone from v3 but remains
 *    in v2 (the delta is v3-only);
 *  - the v2 custom-role grant machinery is carried over unchanged;
 *  - the repo firestore.rules (not the live ruleset) carries neither
 *    the v3 derivation nor the v2 change.
 */

import * as fs from 'fs';
import * as path from 'path';

const v3 = fs.readFileSync(
  path.join(
    process.cwd(),
    '../firestore_rules_candidate_v3_full_member_2026-10-24.txt',
  ),
  'utf8',
);
const v2 = fs.readFileSync(
  path.join(
    process.cwd(),
    '../firestore_rules_candidate_v2_custom_roles_2026-10-24.txt',
  ),
  'utf8',
);
const repoRules = fs.readFileSync(
  path.join(process.cwd(), 'firestore.rules'),
  'utf8',
);

describe('rules candidate v3: Full Member derivation', () => {
  it("isFullMember derives from the roles doc primary role == 'member'", () => {
    expect(v3).toContain('function isFullMember()');
    expect(v3).toContain(
      'exists(/databases/$(database)/documents/roles/$(request.auth.uid))',
    );
    expect(v3).toContain(".data.get('role', null) == 'member'");
    expect(v3).toContain('Decision 9 is formally');
  });

  it('the return-false fallback is retired in v3 only', () => {
    expect(v3).not.toContain('function isFullMember() {\n    return false;');
    expect(v2).toContain('function isFullMember() {\n    return false;');
    expect(v2).not.toContain(".data.get('role', null) == 'member'");
  });

  it('stacks on v2: custom-role grant machinery carried over unchanged', () => {
    expect(v3).toContain('function additionalRoleGrantsPermission(index, permission)');
    expect(v3).toContain('additionalRoleGrantsPermission(0, permission)');
    expect(v3).toContain('additionalRoleGrantsPermission(1, permission)');
    expect(v3).toContain('additionalRoleGrantsPermission(2, permission)');
    expect(v3).toContain("slug.matches('^custom_[a-z0-9]+(_[a-z0-9]+)*$')");
  });

  it('Full-Member-gated reads still route through isFullMember()', () => {
    expect(v3).toContain('match /agm_events/{agmId}');
    expect(v3).toContain('allow get: if isSignedIn() && isFullMember();');
    expect(v3).toContain('match /agm_documents/{documentId}');
  });

  it('the repo firestore.rules converged to the live ruleset, which carries the v2 machinery and the member derivation', () => {
    // CONVERGENCE (2026-10-28 security wave, audit item 6): the repo
    // firestore.rules was converged onto the LIVE ruleset text
    // (325ab07c, published as e73be496). The live ruleset already
    // carried both — that was the repo/live divergence — so the repo
    // file carries them now too.
    expect(repoRules).toContain(".data.get('role', null) == 'member'");
    expect(repoRules).toContain('additionalRoleGrantsPermission');
  });
});
