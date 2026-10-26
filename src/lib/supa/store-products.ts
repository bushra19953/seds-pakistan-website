/**
 * Store products read seam (Cluster M, Group 1) — server-only.
 *
 * Flag: useSupa('store-products-api'). When the flag is OFF, no Supabase
 * client is configured, or the adapter throws, this seam returns null and
 * the caller serves the Firestore path byte-identically.
 *
 * Shape contract (STORE_CLUSTER_PLAN.md, Timestamp contract): each row is
 * { id, ...data, createdAt: ISO||null, updatedAt: ISO||null }. In the
 * fs_products jsonb landing table, timestamps already arrive as ISO
 * strings and pass through; Timestamp-like values ({ toDate() }) and
 * dumped-timestamp objects ({ _seconds, _nanoseconds }) are converted;
 * anything else unconvertible becomes null — matching the Firestore
 * route's `data.createdAt?.toDate?.()?.toISOString() || null`.
 *
 * Category / field names are reproduced faithfully: this seam must NOT
 * normalize 'event_ticket' vs 'event-ticket' or rename linkedEventId /
 * eventId (Linked Store Product defect EV-P07 is a separate fix).
 */

import { getSupaAdapter, getSupaClient, useSupa } from './index';

export const STORE_PRODUCTS_SURFACE = 'store-products-api';

/** Convert a stored timestamp value of any known shape to ISO, or null. */
export function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.toDate === 'function') {
      try {
        const d = (v.toDate as () => Date)();
        return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
      } catch {
        return null;
      }
    }
    if (typeof v._seconds === 'number') {
      const ms = v._seconds * 1000 + Math.floor(((v._nanoseconds as number) || 0) / 1e6);
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    if (typeof v.toMillis === 'function') {
      try {
        const d = new Date((v.toMillis as () => number)());
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Map one adapter doc ({ id, ...data }) to the products-API row shape. */
export function shapeProductRow(doc: Record<string, unknown>): Record<string, unknown> {
  const { id, ...data } = doc;
  return {
    id,
    ...data,
    createdAt: isoOrNull(data.createdAt),
    updatedAt: isoOrNull(data.updatedAt),
  };
}

/**
 * List all products through the adapter, shaped for the products API.
 * Returns null when the surface is off / unconfigured / errored so the
 * caller falls back to Firestore.
 */
export async function listStoreProductsFromSupa(): Promise<Array<Record<string, unknown>> | null> {
  if (!useSupa(STORE_PRODUCTS_SURFACE)) return null;
  if (!getSupaClient()) return null;
  try {
    const docs = await getSupaAdapter().listDocs('products');
    return docs.map((d) => shapeProductRow(d as Record<string, unknown>));
  } catch (err) {
    console.error('[store-products seam] adapter read failed, falling back to Firestore:', err);
    return null;
  }
}


/* ------------------------------------------------ write primacy (S-W1) */

import {
  callStoreTx,
  makeStoreDocId,
  storePrimaryEnabled,
  type StoreTxResult,
} from './store-primary';

/** True iff 'store-products-api' is write-primary (both flags) + client. */
export function storeProductsPrimaryEnabled(): boolean {
  return storePrimaryEnabled(STORE_PRODUCTS_SURFACE);
}

/**
 * P1 under primacy: ONE tx_store_product_create call — product insert
 * + money-audit in the same transaction (the named atomicity delta:
 * an audit failure now rolls the product back; the route's response
 * stays a 500). The id is minted app-side in Firestore auto-id shape.
 * `data` carries the product fields without timestamps (the tx stamps
 * createdAt/updatedAt); `audit` carries the buildMoneyAuditDoc fields
 * the route derived (the tx stamps its timestamps SQL-side).
 */
export async function createStoreProductViaPrimary(args: {
  data: Record<string, unknown>;
  audit: Record<string, unknown>;
}): Promise<StoreTxResult> {
  const productId = makeStoreDocId();
  const result = await callStoreTx('tx_store_product_create', 'store_product_create', {
    p_id: productId,
    p_data: args.data,
    p_audit: args.audit,
  });
  return { ...result, productId: (result.productId as string) || productId };
}

/** P2 under primacy: ONE tx_store_product_update call (404 as a value). */
export async function updateStoreProductViaPrimary(args: {
  productId: string;
  updates: Record<string, unknown>;
  audit: Record<string, unknown>;
}): Promise<StoreTxResult> {
  return callStoreTx('tx_store_product_update', 'store_product_update', {
    p_id: args.productId,
    p_updates: args.updates,
    p_audit: args.audit,
  });
}

/** P3 under primacy: ONE tx_store_product_delete call (404 as a value). */
export async function deleteStoreProductViaPrimary(args: {
  productId: string;
  audit: Record<string, unknown>;
}): Promise<StoreTxResult> {
  return callStoreTx('tx_store_product_delete', 'store_product_delete', {
    p_id: args.productId,
    p_audit: args.audit,
  });
}
