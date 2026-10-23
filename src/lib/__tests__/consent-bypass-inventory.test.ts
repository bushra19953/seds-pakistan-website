/**
 * Bypass-path inventory (spec B.7.3): the consent gate is only as strong as
 * its closed bypasses. These source-level assertions fail if a future change
 * reintroduces a direct Category B write path around the gate.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
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

describe('closed path: side doors (Custom Roles Fix Program)', () => {
  it('the roles/assign route is folded into role-writes and writes nothing itself', () => {
    // Contracts section 3.3 (fold, supersedes the plan's deletion):
    // the route survives with its envelope, but every write is
    // executed by assignRole / removeRole. The pre-fold verbatim
    // batch (rolesRef set with grantedBy, mirror set with
    // displayRole: newRole) must never come back.
    const route = read('src/app/api/admin/roles/assign/route.ts');
    expect(route).toContain('assignRole(');
    expect(route).toContain('removeRole(');
    expect(route).not.toContain('db.batch()');
    expect(route).not.toContain('grantedBy: callerUid');
    expect(route).not.toContain('displayRole: newRole');
  });

  it('the write route carries the founder-record immutability guard', () => {
    // Side-door plan 3.1: the guard moved here BEFORE door 1 was
    // folded, so the Founder's own record stays server-protected.
    const route = read('src/app/api/admin/roles/write/route.ts');
    expect(route).toContain('The Founder role is immutable');
    expect(route).toContain('isFounderUid(uid)');
  });

  it('hierarchy shell-create stores only a resolved role key', () => {
    const route = read('src/app/api/admin/hierarchy/user/route.ts');
    expect(route).toContain('resolveShellRole');
    expect(route).not.toContain("role: role || 'member'");
    expect(route).not.toContain("displayRole: role || 'member'");
  });

  it('the discipline restore adapter delegates to assignRole via warning_demotion', () => {
    const adapters = read('src/lib/server/discipline/adapters.ts');
    expect(adapters).toContain('assignRole(');
    expect(adapters).toContain('warning_demotion');
    expect(adapters).not.toContain('{ role: roleKey, updatedAt');
  });

  it('both restore call sites pass an actor and a reason (plan 3.4)', () => {
    expect(read('src/app/api/admin/founder-review/route.ts')).toContain(
      'Founder review restore for case',
    );
    const probation = read('src/lib/server/discipline/adapters-probation.ts');
    expect(probation).toContain("actorUid: 'system'");
    expect(probation).toContain('Probation period ended; restoring pre-probation role');
  });

  it('the [slug] DELETE actor set has no literals and no legacy fallback', () => {
    // Side-door plan 3.5 / R8: founder by config UID check or the
    // permissions matrix only.
    const route = read('src/app/api/admin/roles/[slug]/route.ts');
    expect(route).not.toContain('pLW0PuQCTAQHCNK1SfllVhPZdMz1');
    expect(route).not.toContain('manageRoles');
    expect(route).not.toContain("userRole === 'superadmin'");
    expect(route).not.toContain("userRole === 'president_national'");
    expect(route).toContain('hasServerPermission');
    expect(route).toContain("canManagePermissions");
  });

  it('no API route writes a roles/{uid} document outside the sanctioned write path', () => {
    // Repo-level guard (static scan): walk every route file under
    // src/app/api, track identifiers bound to a roles-collection
    // document reference, and fail if any such identifier is the
    // target of a set/update (directly or through a batch). Reading
    // a roles doc (auth checks, registries, fences) is fine and
    // common; WRITING one from a route is not - role-writes.ts is
    // the single sanctioned writer and routes must call it.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry !== '__tests__' && entry !== 'node_modules') walk(full);
          continue;
        }
        if (entry !== 'route.ts' && entry !== 'route.tsx') continue;
        const src = readFileSync(full, 'utf8');
        const refIds = new Set<string>();
        const decl =
          /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[\w.$]*collection\(['"]roles['"]\)\.doc\(/g;
        let m: RegExpExecArray | null;
        while ((m = decl.exec(src)) !== null) refIds.add(m[1]);
        let offends = /collection\(['"]roles['"]\)\.doc\([^)]*\)\s*\.(set|update)\(/.test(src);
        for (const id of refIds) {
          if (
            src.includes(`batch.set(${id}`) ||
            src.includes(`batch.update(${id}`) ||
            src.includes(`${id}.set(`) ||
            src.includes(`${id}.update(`)
          ) {
            offends = true;
          }
        }
        if (offends) offenders.push(full.slice(ROOT.length + 1));
      }
    };
    walk(join(ROOT, 'src/app/api'));
    expect(offenders).toEqual([]);
  });
});
