/**
 * Store orders read seam (Cluster M, Group 2) — server-only.
 *
 * Flag: useSupa('store-orders-api'). When the flag is OFF, no Supabase
 * client is configured, or the adapter throws, this seam returns null and
 * the caller serves the Firestore path byte-identically.
 *
 * This seam returns the RAW fetched page (limit+1 rows, unfiltered); the
 * route keeps owning presentation semantics — the in-code soft-delete
 * filter (isSoftDeleted), the normalizeOrder canonical overlay, hasMore
 * computation and the response envelope — so flag ON and OFF produce
 * byte-identical responses from the same stored data.
 *
 * CURSOR TRANSLATION — RESIDUAL RISK (documented, not hidden):
 * Firestore startAfter(cursorDoc) skips exactly that one document. The
 * adapter's startAfter is a VALUE bound on the orderBy field, so this
 * seam resolves the cursor document first (adapter.getDoc) and passes
 * its createdAt VALUE as the bound. Every order sharing that exact
 * createdAt timestamp is skipped, not just the cursor document. With
 * distinct timestamps (the norm — serverTimestamp at ms resolution) the
 * pages agree; ties can drop rows from page 2+. If the cursor document
 * is not found, the current Firestore code ignores the cursor — this
 * seam reproduces that (no bound is applied). A dedicated
 * (createdAt,id) keyset design is a merge-planner follow-up, not this
 * wave (STORE_CLUSTER_PLAN.md, Group 2).
 *
 * The embedded products list is this group's OWN seam call (groups stay
 * independent; the merge planner deduplicates seams later if it wants),
 * shaped exactly like the products list in the Firestore GET: { id,
 * ...data, createdAt: ISO||null, updatedAt: ISO||null }.
 */

import { getSupaAdapter, getSupaClient, useSupa, type ListOptions } from './index';

export const STORE_ORDERS_SURFACE = 'store-orders-api';

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

export interface StoreOrdersPageRequest {
  /** Already clamped by the route to 1..50. */
  limit: number;
  cursor: string | null;
  statusFilter: string | null;
}

export interface StoreOrdersPageData {
  /** Raw fetched orders (limit+1), newest first, BEFORE soft-delete filtering. */
  fetched: Array<{ id: string; raw: Record<string, unknown> }>;
  /** Embedded products list, products-API shape. */
  products: Array<Record<string, unknown>>;
}

/**
 * Fetch one orders page + the embedded products list through the adapter.
 * Returns null when the surface is off / unconfigured / errored so the
 * caller falls back to Firestore.
 */
export async function getStoreOrdersPageFromSupa(
  req: StoreOrdersPageRequest,
): Promise<StoreOrdersPageData | null> {
  if (!useSupa(STORE_ORDERS_SURFACE)) return null;
  if (!getSupaClient()) return null;
  try {
    const adapter = getSupaAdapter();
    const options: ListOptions = {
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit: req.limit + 1,
    };
    if (req.statusFilter && req.statusFilter !== 'all') {
      options.where = [['status', '==', req.statusFilter]];
    }
    if (req.cursor) {
      const cursorDoc = (await adapter.getDoc('orders', req.cursor)) as Record<string, unknown> | null;
      if (cursorDoc && cursorDoc.createdAt !== undefined && cursorDoc.createdAt !== null) {
        // Value-based bound — see the residual-risk note in the header.
        options.startAfter = cursorDoc.createdAt as ListOptions['startAfter'];
      }
      // Cursor not found (or carries no createdAt): current code ignores
      // the cursor, so no bound is applied.
    }
    const orderDocs = await adapter.listDocs('orders', options);
    const productDocs = await adapter.listDocs('products');
    return {
      fetched: orderDocs.map((d) => {
        const { id, ...raw } = d as Record<string, unknown>;
        return { id: id as string, raw };
      }),
      products: productDocs.map((d) => {
        const { id, ...data } = d as Record<string, unknown>;
        return {
          id,
          ...data,
          createdAt: isoOrNull(data.createdAt),
          updatedAt: isoOrNull(data.updatedAt),
        };
      }),
    };
  } catch (err) {
    console.error('[store-orders seam] adapter read failed, falling back to Firestore:', err);
    return null;
  }
}
