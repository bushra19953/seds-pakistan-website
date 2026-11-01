/**
 * The vendor system role (vendor shop pilot, BUILD_SPEC Section 3.1;
 * PLAN-gb Section 2.2 item 3).
 *
 * `vendor` is a system role: it is not a catalog key and not a custom
 * role. It is granted only as an additionalRoles entry through the
 * single role write path (src/lib/server/role-writes.ts), which
 * validates the roleDefinitions/vendor doc against the four keys
 * below at assignment time. The holder's primary role stays a catalog
 * key, so session role resolution is unchanged.
 *
 * This module is the single definition site for the slug and its
 * permission keys. Pure module: no imports beyond the type-only
 * PermissionKey, mirroring role-catalog's zero-import discipline.
 */

import type { PermissionKey } from '@/config/permission-registry';

export const VENDOR_ROLE_SLUG = 'vendor';

/** The vendor role's exact permission set, in spec order. Nothing else. */
export const VENDOR_PERMISSION_KEYS: readonly PermissionKey[] = [
  'canViewOwnVendorProducts',
  'canViewOwnVendorOrders',
  'canUpdateOwnVendorFulfilment',
  'canViewOwnVendorBalance',
];

/**
 * Exact match on the already-normalised stored form: stored
 * additionalRoles entries are written verbatim by role-writes, so no
 * slug normalisation is applied here.
 */
export function isVendorRoleSlug(value: unknown): value is string {
  return value === VENDOR_ROLE_SLUG;
}
