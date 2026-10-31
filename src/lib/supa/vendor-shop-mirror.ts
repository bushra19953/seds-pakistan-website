/**
 * vendor-shop-mirror.ts: the Supabase mirror registration for the six
 * vendor shop pilot collections (PLAN-ga Section 5).
 *
 * Registration in this codebase means three things, all present for
 * these collections: the landing tables exist (DDL:
 * scripts/fs_vendor_shop_tables.sql, applied by the coordinator; the
 * adapter derives each table name from the collection name via
 * tableForCollection, so vendors -> fs_vendors and so on), code writes
 * through the adapter after each Firestore write (this module, called
 * by src/lib/server/vendor-shop.ts), and the collection names are
 * spelled exactly as the spec names them.
 *
 * BEHAVIOUR CONTRACT (the consents seam's words, adapted):
 * - Firestore stays primary in every flag state. SUPA_PRIMARY is never
 *   consulted, and no GA code reads from Supabase: read paths for these
 *   collections stay on Firestore through the Section 4 helpers.
 * - Mirror writes resolve the real adapter whenever getSupaClient()
 *   returns a client, regardless of SUPA_SURFACES (the Train 2
 *   contacts ruling recorded in consents-supa.ts: freshness cannot
 *   wait on a flag, or the window between backfill and flip strands
 *   new writes). These collections are born after that ruling, have no
 *   read surface, and have no backfill window: the first write is the
 *   first mirror row (CHOICE C9).
 * - Mirror helpers NEVER throw: a mirror failure is logged with the
 *   [vendor-shop-mirror] prefix and the Firestore-backed request
 *   proceeds. A missing client or adapter returns false without an
 *   error log; an unconfigured mirror is a normal state until the
 *   coordinator applies the DDL and the deployment carries Supabase
 *   config, which the existing store surfaces already require.
 * - Payloads are the caller's in-memory post-write state, never a
 *   Firestore re-read after a write (the consents accept-fix pattern),
 *   serialized with serializeForSupa from src/lib/applications-supa.ts.
 */

import { getSupaAdapter, getSupaClient } from '@/lib/supa';
import { SUPA_DELETE_FIELD, serializeForSupa } from '@/lib/applications-supa';

export const VENDOR_SHOP_MIRROR_COLLECTIONS = [
  'vendors',
  'commission_ledger',
  'vendor_payouts',
  'store_waitlist',
  'group_buys',
  'store_credits',
] as const;
export type VendorShopCollection = (typeof VENDOR_SHOP_MIRROR_COLLECTIONS)[number];

export interface VendorShopMirrorAdapter {
  setDoc(
    collectionPath: string,
    id: string,
    data: Record<string, any>,
    options?: { merge?: boolean },
  ): Promise<unknown>;
  updateDoc(collectionPath: string, id: string, updates: Record<string, any>): Promise<unknown>;
}

let injectedAdapter: VendorShopMirrorAdapter | null | undefined;

/** Test-only: inject a fake adapter (or null to simulate absence). */
export function __setVendorShopMirrorAdapterForTests(
  adapter: VendorShopMirrorAdapter | null,
): void {
  injectedAdapter = adapter;
}

/** Test-only: clear adapter injection. */
export function __resetVendorShopMirrorAdapterForTests(): void {
  injectedAdapter = undefined;
}

function realAdapter(): VendorShopMirrorAdapter | null {
  try {
    if (!getSupaClient()) return null;
    const candidate: any = getSupaAdapter();
    if (
      candidate &&
      typeof candidate.setDoc === 'function' &&
      typeof candidate.updateDoc === 'function'
    ) {
      return candidate as VendorShopMirrorAdapter;
    }
    return null;
  } catch {
    return null;
  }
}

function resolveAdapter(): VendorShopMirrorAdapter | null {
  if (injectedAdapter !== undefined) return injectedAdapter;
  return realAdapter();
}

function serializedDoc(data: Record<string, unknown>): Record<string, any> {
  const serialized = serializeForSupa(data) as Record<string, any>;
  for (const key of Object.keys(serialized)) {
    if (serialized[key] === SUPA_DELETE_FIELD) delete serialized[key];
  }
  return serialized;
}

/**
 * Mirror a full post-write document. Never throws; returns success.
 * A top-level id key is stripped: the adapter keys rows by id
 * separately (the store seam's updateStoreProductInSupa documents why).
 */
export async function mirrorVendorShopSet(
  collection: VendorShopCollection,
  id: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const adapter = resolveAdapter();
  if (!adapter) return false;
  try {
    const { id: _drop, ...rest } = data as Record<string, any>;
    void _drop;
    await adapter.setDoc(collection, id, serializedDoc(rest));
    return true;
  } catch (err) {
    console.error(`[vendor-shop-mirror] mirror set failed for ${collection}/${id}`, err);
    return false;
  }
}

/** Mirror a partial update. Never throws; returns success. */
export async function mirrorVendorShopUpdate(
  collection: VendorShopCollection,
  id: string,
  updates: Record<string, unknown>,
): Promise<boolean> {
  const adapter = resolveAdapter();
  if (!adapter) return false;
  try {
    const { id: _drop, ...rest } = updates as Record<string, any>;
    void _drop;
    await adapter.updateDoc(collection, id, serializedDoc(rest));
    return true;
  } catch (err) {
    console.error(`[vendor-shop-mirror] mirror update failed for ${collection}/${id}`, err);
    return false;
  }
}
