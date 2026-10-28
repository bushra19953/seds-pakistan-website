/**
 * Rules candidate v2 (custom-role grants) guard: the candidate lives
 * OUTSIDE the repo next to the wave-1 candidate it stacks on (batched
 * Console publish, owner-gated). This suite pins, in the established
 * rules-text style:
 *  - the permission helper consults additionalRoles (bounded unroll);
 *  - only custom_ slugs are honored, expiry is enforced, and each slug
 *    is checked against its OWN permissions doc (no primary-role leak);
 *  - the primary-role check and the wave-1 blogs-read tightening are
 *    carried over unchanged;
 *  - neither the wave-1 candidate nor the repo firestore.rules (not
 *    the live ruleset) carries the v2 change.
 */

import * as fs from 'fs';
import * as path from 'path';

const v2 = fs.readFileSync(
  path.join(
    process.cwd(),
    '../firestore_rules_candidate_v2_custom_roles_2026-10-24.txt',
  ),
  'utf8',
);
const wave1 = fs.readFileSync(
  path.join(
    process.cwd(),
    '../firestore_rules_candidate_blogs_read_2026-10-24.txt',
  ),
  'utf8',
);
const repoRules = fs.readFileSync(
  path.join(process.cwd(), 'firestore.rules'),
  'utf8',
);

describe('rules candidate v2: custom-role grants', () => {
  it('hasPermission consults additionalRoles via the bounded unroll', () => {
    expect(v2).toContain('additionalRoleGrantsPermission(0, permission)');
    expect(v2).toContain('additionalRoleGrantsPermission(1, permission)');
    expect(v2).toContain('additionalRoleGrantsPermission(2, permission)');
    expect(v2).toContain("data.get('additionalRoles', [])");
    expect(v2).toContain('function additionalRoleSlugAt(index)');
  });

  it('honors only custom_ slugs, each against its own permissions doc', () => {
    expect(v2).toContain("slug.matches('^custom_[a-z0-9]+(_[a-z0-9]+)*$')");
    expect(v2).toContain('function roleDocGrantsPermission(roleSlug, permission)');
    expect(v2).toContain('documents/permissions/$(roleSlug)');
    expect(v2).toContain('roleDocGrantsPermission(slug, permission)');
  });

  it('enforces the recorded grant expiry and preserves the primary check', () => {
    expect(v2).toContain('function additionalGrantExpired(roleSlug)');
    expect(v2).toContain("data.get('expiresRoleKey', null) == roleSlug");
    expect(v2).toContain('roleDocGrantsPermission(currentRole(), permission)');
  });

  it('stacks on the wave-1 candidate: blogs-read tightening carried over', () => {
    expect(v2).toContain('match /blogs/{blogId}');
    expect(v2).toContain(
      "resource.data.get('status', 'draft') == 'published'",
    );
    expect(v2).toContain("allow get, list: if isSuperAdmin() || hasPermission('canManageBlogs')");
  });

  it('the delta is v2-only: wave-1 candidate does not carry it; repo rules converged to the live text, which does', () => {
    expect(wave1).not.toContain('additionalRoleGrantsPermission');
    expect(wave1).not.toContain('roleDocGrantsPermission');
    // CONVERGENCE (2026-10-28 security wave, audit item 6): the repo
    // firestore.rules was converged onto the LIVE ruleset text
    // (325ab07c, published as e73be496). The live ruleset already
    // carried this helper chain — that was the repo/live divergence —
    // so the repo file carries it now too.
    expect(repoRules).toContain('additionalRoleGrantsPermission');
    expect(repoRules).toContain('roleDocGrantsPermission');
  });
});
