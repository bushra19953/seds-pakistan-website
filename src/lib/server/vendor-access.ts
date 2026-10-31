/**
 * vendor-access.ts: vendor resolution for the vendor shop pilot
 * (BUILD_SPEC Section 2.1 / 3.1; PLAN-gb Section 3 as split by
 * coordinator ruling R-5).
 *
 * GB owns this module. It resolves vendor records by uid and by id
 * and answers the founder-side name lookup. GG owns the view mappers
 * and the fulfilment PATCH validator (src/lib/server/vendor-views.ts);
 * they are deliberately NOT here.
 *
 * GB's server code reads raw Firestore documents (PLAN-gb Section 7):
 * the VendorRecord shape below restates spec Section 2.1 field for
 * field and matches GA's Vendor type in src/types/store.ts, which is
 * the integration-time type home.
 *
 * Enforcement contract for vendor-facing routes (GG consumes this):
 * a caller is resolved from their authenticated uid ONLY. No function
 * here accepts a client-sent vendorId as the caller's identity, so a
 * vendor can never name another vendor's record (spec P3). Access
 * additionally requires the record status to be 'active' and the
 * holder-scoped vendor permission; pause and exit revoke access
 * without touching the stored role grant (exit removes the grant
 * separately, in the vendors route).
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { PermissionKey } from '@/config/permissions.config';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { assignRole } from '@/lib/server/role-writes';
import { isCatalogRoleKey, type CatalogRoleKey } from '@/lib/role-catalog';
import { VENDOR_PERMISSION_KEYS, VENDOR_ROLE_SLUG } from '@/lib/vendor-role';

export interface VendorRecord {
  id: string;
  userId: string;
  businessName: string;
  contactName: string;
  phone: string;
  email: string;
  city: string;
  warehouseAddress: string;
  cnicNumber: string;
  bankName: string;
  bankAccountTitle: string;
  bankAccountNumber: string;
  agreementStatus: string;
  agreementDriveFileId: string | null;
  agreementSignedAt: unknown;
  commissionRate: number;
  status: string;
  createdAt: unknown;
  updatedAt: unknown;
  createdBy: string;
  [key: string]: unknown;
}

function toVendorRecord(id: string, data: Record<string, unknown>): VendorRecord {
  return { ...(data as VendorRecord), id };
}

/** Vendor record by document id, or null when no such record exists. */
export async function getVendorById(
  db: Firestore,
  vendorId: string,
): Promise<VendorRecord | null> {
  if (!vendorId) return null;
  const snap = await db.collection('vendors').doc(vendorId).get();
  if (!snap.exists) return null;
  return toVendorRecord(snap.id, (snap.data() ?? {}) as Record<string, unknown>);
}

/**
 * The vendor record for an account uid (spec 2.1: one vendor record
 * per userId), or null. This is the only uid resolution: the record is
 * found from the caller's own uid, never from a client-sent id.
 */
export async function getVendorByUserId(
  db: Firestore,
  userId: string,
): Promise<VendorRecord | null> {
  if (!userId) return null;
  const snap = await db
    .collection('vendors')
    .where('userId', '==', userId)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return toVendorRecord(doc.id, (doc.data() ?? {}) as Record<string, unknown>);
}

/** Alias under the coordinator-ruled name (R-5): record or null. */
export async function resolveVendorByUid(
  db: Firestore,
  uid: string,
): Promise<VendorRecord | null> {
  return getVendorByUserId(db, uid);
}

/**
 * The caller's vendor record only when its status is 'active';
 * null for no record, a paused record, or an exited record. Callers
 * turn null into the generic 403 below, so the response never reveals
 * whether a record exists or what its status is.
 */
export async function resolveActiveVendorByUid(
  db: Firestore,
  uid: string,
): Promise<VendorRecord | null> {
  const vendor = await resolveVendorByUid(db, uid);
  if (!vendor || vendor.status !== 'active') return null;
  return vendor;
}

export type VendorContextResult =
  | { ok: true; vendor: VendorRecord }
  | { ok: false; status: 401 | 403; body: { error: string } };

/**
 * The one vendor-route preamble (PLAN-gb Section 3, rules R1 to R5):
 *   R1. No uid: 401 { error: 'Unauthorized' }.
 *   R2. No vendor record for uid: 403 { error: 'Vendor access denied' }.
 *   R3. Record status !== 'active': same generic 403 as R2.
 *   R4. The holder lacks the vendor permission: same generic 403.
 *   R5. Else the context carries the caller's own record.
 */
export async function resolveVendorContext(
  db: Firestore,
  uid: string | null | undefined,
  permission: PermissionKey,
): Promise<VendorContextResult> {
  if (!uid) {
    return { ok: false, status: 401, body: { error: 'Unauthorized' } };
  }
  const denied: VendorContextResult = {
    ok: false,
    status: 403,
    body: { error: 'Vendor access denied' },
  };
  const vendor = await resolveActiveVendorByUid(db, uid);
  if (!vendor) return denied;
  const allowed = await hasServerPermissionForUser(db, uid, permission);
  if (!allowed) return denied;
  return { ok: true, vendor };
}

/* ------------------------------------------------------------ */
/* Admin grant path (used by /api/store/vendors POST and PATCH)  */
/* ------------------------------------------------------------ */

/** The roleDefinitions/vendor document shape (PLAN-gb Section 2.3). */
export const VENDOR_ROLE_DEFINITION = {
  slug: VENDOR_ROLE_SLUG,
  name: 'Vendor',
  title: 'Vendor',
  permissions: [...VENDOR_PERMISSION_KEYS],
  isCustom: false,
  isActive: true,
  seededFromCatalog: false,
  systemRole: true,
} as const;

/**
 * G0 of the grant sequence: ensure the vendor role definition exists
 * before the first grant. A missing doc is created with exactly the
 * Section 2.3 shape. An existing doc whose permissions array is not
 * the four vendor keys as a set is drift: returns false and the
 * caller grants nothing (the grant path never silently widens or
 * narrows a role definition).
 */
export async function ensureVendorRoleDefinition(db: Firestore): Promise<boolean> {
  const ref = db.collection('roleDefinitions').doc(VENDOR_ROLE_SLUG);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({ ...VENDOR_ROLE_DEFINITION, permissions: [...VENDOR_PERMISSION_KEYS] });
    return true;
  }
  const perms = (snap.data() as Record<string, unknown> | undefined)?.permissions;
  if (!Array.isArray(perms) || perms.length !== VENDOR_PERMISSION_KEYS.length) return false;
  return VENDOR_PERMISSION_KEYS.every((key) => perms.includes(key));
}

interface StoredRoleState {
  primary: CatalogRoleKey;
  additionalRoles: string[];
}

async function readRoleStateForGrant(db: Firestore, userId: string): Promise<StoredRoleState> {
  const snap = await db.collection('roles').doc(userId).get();
  const existing = snap.exists ? (snap.data() as Record<string, unknown>) : null;
  const storedPrimary = typeof existing?.role === 'string' ? (existing.role as string) : null;
  // The primary is never 'vendor': an existing catalog primary is
  // preserved verbatim; anything else floors to member_basic.
  const primary = (
    storedPrimary && isCatalogRoleKey(storedPrimary) ? storedPrimary : 'member_basic'
  ) as CatalogRoleKey;
  const additionalRoles = Array.isArray(existing?.additionalRoles)
    ? (existing.additionalRoles as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  return { primary, additionalRoles };
}

/**
 * G1+G2 of the grant sequence (PLAN-gb Section 2.4): grant 'vendor'
 * as an additional role through the single role write path,
 * preserving the target's primary and existing additional grants.
 */
export async function grantVendorRole(
  db: Firestore,
  actorUid: string,
  userId: string,
  vendorId: string,
): Promise<void> {
  const { primary, additionalRoles } = await readRoleStateForGrant(db, userId);
  const next = [...new Set([...additionalRoles, VENDOR_ROLE_SLUG])];
  await assignRole(db, {
    uid: userId,
    role: primary,
    additionalRoles: next,
    actorUid,
    reason: `Vendor pilot grant for vendor record ${vendorId}`,
    source: 'admin_ui',
  });
}

/**
 * The exit revoke (PLAN-gb Section 2.5): remove 'vendor' from the
 * holder's additionalRoles through the same write path, preserving
 * the primary and every other grant. Idempotent: no roles doc or no
 * vendor entry is a successful no-op, so a repeated exit is a safe
 * revoke retry.
 */
export async function revokeVendorRole(
  db: Firestore,
  actorUid: string,
  userId: string,
  vendorId: string,
): Promise<void> {
  const snap = await db.collection('roles').doc(userId).get();
  if (!snap.exists) return;
  const { primary, additionalRoles } = await readRoleStateForGrant(db, userId);
  if (!additionalRoles.includes(VENDOR_ROLE_SLUG)) return;
  await assignRole(db, {
    uid: userId,
    role: primary,
    additionalRoles: additionalRoles.filter((slug) => slug !== VENDOR_ROLE_SLUG),
    actorUid,
    reason: `Vendor pilot exit for vendor record ${vendorId}`,
    source: 'admin_ui',
  });
}

export interface VendorBusinessName {
  businessName: string;
  status: string;
  agreementStatus: string;
}

/**
 * Batched founder/catalogue lookup: vendor id to its public name plus
 * the status fields the catalogue gate filters on. Ids with no record
 * are absent from the result. One doc get per id, no collection scan.
 */
export async function getVendorBusinessNames(
  db: Firestore,
  vendorIds: readonly string[],
): Promise<Map<string, VendorBusinessName>> {
  const unique = [...new Set(vendorIds.filter((id) => typeof id === 'string' && id !== ''))];
  const result = new Map<string, VendorBusinessName>();
  await Promise.all(
    unique.map(async (id) => {
      const vendor = await getVendorById(db, id);
      if (!vendor) return;
      result.set(id, {
        businessName: vendor.businessName,
        status: vendor.status,
        agreementStatus: vendor.agreementStatus,
      });
    }),
  );
  return result;
}
