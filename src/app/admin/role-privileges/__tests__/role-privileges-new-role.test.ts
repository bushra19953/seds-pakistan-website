/**
 * @jest-environment node
 *
 * RP-21 (FIX_MAP 4.7, decision pack Q17) - adopted option (b):
 * REMOVE the role-privileges "New Role" dialog and repoint "New Role"
 * to the Role Registry.
 *
 * The removed dialog POSTed a path-model-only body
 * ({ role, label, allowedPaths: ['/admin'], canAccessAdmin: true,
 * consentRequestId }) that can never mint a role: custom_ slugs fail
 * CUSTOM_FIELDS_REQUIRED and non-custom slugs fail catalog closure.
 * The one canonical create surface is the Role Registry dialog at
 * /admin/users?tab=roles. These source guards pin that this page
 * carries no create capability and that its "New Role" affordance
 * navigates to the registry path. They scan page.tsx only - the
 * shared RolePermissionEditor (outside this surface) legitimately
 * saves edits to existing roles through the gated route.
 */

import * as fs from 'fs';
import * as path from 'path';

const PAGE = path.resolve(__dirname, '..', 'page.tsx');
const source = fs.readFileSync(PAGE, 'utf8');

describe('RP-21: role-privileges page has no create capability', () => {
  it('contains no create POST to the role-permissions route', () => {
    expect(source).not.toMatch(/method:\s*['"]POST['"]/);
    expect(source).not.toContain('handleCreate');
  });

  it('contains no create dialog or its state', () => {
    expect(source).not.toContain('Create New Role');
    expect(source).not.toContain('createOpen');
    expect(source).not.toContain('newRoleSlug');
    expect(source).not.toContain('newRoleLabel');
    expect(source).not.toContain('createConsentId');
    expect(source).not.toMatch(/action:\s*['"]create['"]/);
  });

  it('does not suggest the dead-end slug example from the old dialog', () => {
    expect(source).not.toContain('media_lead');
  });
});

describe('RP-21: "New Role" repoints to the Role Registry', () => {
  it('links the New Role affordance at the registry path', () => {
    expect(source).toContain('href="/admin/users?tab=roles"');
    expect(source).toContain('New Role');
  });

  it('renders the affordance as a navigation link, not a dialog trigger', () => {
    expect(source).toContain("from 'next/link'");
    expect(source).toMatch(/<Button asChild/);
    expect(source).not.toMatch(/setCreateOpen\(true\)/);
  });
});

describe('RP-21: the rest of the page is untouched in kind', () => {
  it('still loads roles via GET and deletes via DELETE', () => {
    expect(source).toContain("fetch('/api/admin/role-permissions'");
    expect(source).toMatch(/method:\s*['"]DELETE['"]/);
    expect(source).toContain('pendingDelete');
  });
});
