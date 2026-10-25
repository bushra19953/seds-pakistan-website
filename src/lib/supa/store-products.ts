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
