/**
 * Bypass-path inventory (spec B.7.3): the consent gate is only as strong as
 * its closed bypasses. These source-level assertions fail if a future change
 * reintroduces a direct Category B write path around the gate.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..', '..');

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('closed path: client role writers', () => {
  const src = read('src/lib/role-management.ts');

  it('role-management routes writes through the gated assign route', () => {
    // Integration (step 4): the gated assign route is Phase 1's single
    // write path, /api/admin/roles/write - the gates branch's assumed
    // '/api/admin/roles/assign' path was never built; the write path is
    // where the Category B gate now lives.
    expect(src).toContain('/api/admin/roles/write');
  });

  it('no direct roles/{uid} writes remain in role-management', () => {
    expect(src).not.toContain('setDoc(roleDocRef');
    expect(src).not.toContain('updateDoc(roleDocRef');
    expect(src).not.toContain('deleteDoc(roleDocRef');
  });

  it('sync-user-role refuses fresh role writes and only repairs the mirror', () => {
    const route = read('src/app/api/admin/sync-user-role/route.ts');
    expect(route).toContain('ROLE_WRITE_ROUTE_REQUIRED');
    expect(route).toContain('role_mirror_repair');
  });

  it('the assign route is gated and writes both role stores', () => {
    // Integration (step 4): re-pointed at the real write path (see above).
    const route = read('src/app/api/admin/roles/write/route.ts');
    expect(route).toContain('assertConsentFor');
    expect(route).toContain("collection('roles')");
    expect(route).toContain("collection('users')");
  });
});

describe('closed path: positions and warnings', () => {
  it('positions route consults the consent gate', () => {
    const route = read('src/app/api/positions/route.ts');
    expect(route).toContain('assertConsentFor');
    expect(route).toContain("type: 'position'");
  });

  it('issue-warning gates demotions of Category B holders', () => {
    // Integration (step 4/6): the issue-warning route was RETIRED by the
    // discipline rebuild (410, no demote path at all), so the demotion
    // surface this case guarded no longer exists there. Demotions now
    // happen only via (a) the write path's remove action - gated above -
    // and (b) disciplinary case decisions. The invariant is re-pointed:
    // the retired route stays retired, and the write path gates removals.
    const retired = read('src/app/api/admin/issue-warning/route.ts');
    expect(retired).toContain('410');
    expect(retired).not.toContain('demoteToRole');
    const writeRoute = read('src/app/api/admin/roles/write/route.ts');
    expect(writeRoute).toContain('assertConsentFor');
    expect(writeRoute).toContain("action: action === 'assign' ? 'appoint' : 'remove'");
  });
});

describe('closed path: self-service elevation', () => {
  it('invite creation refuses Category B roles', () => {
    const invites = read('src/lib/invite-system.ts');
    expect(invites).toContain('isGatedInviteRole');
    expect(invites).toContain('Category B offices cannot be assigned by invite');
  });

  it('both invite claim flows downgrade gated roles with an audit trace', () => {
    expect(read('src/app/invite/page.tsx')).toContain('invite_role_downgraded');
    expect(read('src/components/auth/google-only-auth-form.tsx')).toContain(
      'invite_role_downgraded',
    );
  });

  it('the superadmin invite form cannot offer Category B roles', () => {
    expect(read('src/app/admin/superadmin/page.tsx')).toContain('CATEGORY_B_ROLE_KEYS');
  });
});
