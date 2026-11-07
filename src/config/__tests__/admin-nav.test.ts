/**
 * @jest-environment node
 *
 * The admin sidebar renders a nav item only when the item's literal path
 * string appears in the role's allowedPaths, and the Configure Role dialog
 * writes allowedPaths from its own SIDEBAR_ITEMS catalog
 * (components/admin/roles/role-permission-editor.tsx). If the two lists
 * disagree on the path for the same item, that item can never appear for a
 * dialog-configured role. That is exactly how Roles vanished: admin-nav
 * said "/admin/users?tab=roles" while the catalog writes "/admin/roles"
 * (/admin/roles is a redirect stub to the roles tab, so the catalog string
 * is the safe one). These guards pin that every item present in both lists
 * uses the exact same path string in both.
 */

import * as fs from 'fs';
import * as path from 'path';
import { adminNav } from '@/config/admin-nav';

const EDITOR = path.resolve(
  __dirname,
  '..',
  '..',
  'components',
  'admin',
  'roles',
  'role-permission-editor.tsx',
);
const editorSource = fs.readFileSync(EDITOR, 'utf8');

function catalogPathsByLabel(): Map<string, string> {
  const blockStart = editorSource.indexOf('export const SIDEBAR_ITEMS');
  const blockEnd = editorSource.indexOf('];', blockStart);
  const block = editorSource.slice(blockStart, blockEnd);
  const map = new Map<string, string>();
  const re = /\{\s*path:\s*'([^']+)',\s*label:\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    map.set(m[2], m[1]);
  }
  return map;
}

describe('admin-nav paths match the Configure Role catalog', () => {
  const catalog = catalogPathsByLabel();
  const navItems = adminNav.flatMap((g) => g.items);

  it('the catalog was actually parsed', () => {
    expect(catalog.size).toBeGreaterThan(20);
  });

  it('Roles and Users use the exact catalog paths', () => {
    const roles = navItems.find((i) => i.label === 'Roles');
    const users = navItems.find((i) => i.label === 'Users');
    expect(roles?.path).toBe('/admin/roles');
    expect(users?.path).toBe('/admin/users');
    expect(catalog.get('Roles')).toBe('/admin/roles');
    expect(catalog.get('Users')).toBe('/admin/users');
  });

  it('every nav item that also exists in the catalog matches its path literally', () => {
    const mismatches: string[] = [];
    for (const item of navItems) {
      const catalogPath = catalog.get(item.label);
      if (catalogPath !== undefined && catalogPath !== item.path) {
        mismatches.push(
          `${item.label}: nav "${item.path}" vs catalog "${catalogPath}"`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });
});
