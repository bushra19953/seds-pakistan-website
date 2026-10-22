'use client';

/**
 * Backwards-compatible shim. The per-role editor now lives in
 * role-permission-editor.tsx as the ONE shared implementation used by
 * both the Role Registry tab on /admin/users and /admin/role-privileges.
 * This file only re-exports it under the drawer's historical name.
 */
export { RolePermissionEditorDrawer as RolePrivilegesDrawer } from './role-permission-editor';
export type { RolePermissionEditorDrawerProps as RolePrivilegesDrawerProps } from './role-permission-editor';
