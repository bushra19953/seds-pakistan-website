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
 * CURSOR — KEYSET (cutover build, tasks S-K1/S-K3; design
 * ~/workspace/supabase-migration/cutover-sections/store-design.md §1):
 * the pre-cutover VALUE bound is RETIRED. It resolved the cursor doc and
 * passed its createdAt VALUE as the adapter's startAfter bound, so every
 * order sharing that exact timestamp was skipped on the next page. The
 * seam now fetches through the `store_orders_page` Postgres function
 * (src/lib/supa/sql/store_orders_page.sql, staged as a flip-time apply
 * artifact) whose predicate is the design's total order verbatim:
 * createdAt DESC, id ASC, rows strictly after the cursor KEY
 * (millis, id). The pure module ./store-orders-keyset is the semantics
 * reference; the property suite proves this fetcher reproduces it.
 *
 * Cursor protocol (design §1.3/§1.5):
 *  - no cursor -> first page;
 *  - a `v1.` keyset cursor -> decoded here (filter-bound); a decode
 *    failure (malformed / unsupported-version / bad-payload /
 *    filter-mismatch) is reported to the route as
 *    { invalidCursor: true, code }, which answers 400 invalid_cursor;
 *  - a legacy bare-id cursor -> TRANSLATED: the doc is resolved with
 *    one adapter.getDoc (the exact read the old seam performed for
 *    every cursor) and its key becomes the page bound, so an in-flight
 *    old-client pagination survives and stops losing tie siblings;
 *  - a legacy id that does not resolve, or resolves to a row with no
 *    usable createdAt (a GHOST cursor) -> { invalidCursor: true,
 *    code: 'not-found' } -> 400. DELIBERATE BEHAVIOUR CHANGE from the
 *    pre-cutover seam, which silently ignored a ghost cursor and
 *    re-served page 1 (a duplicate generator): orders are never
 *    hard-deleted (DELETE is 410; removal is soft-delete via
 *    approvals, and a soft-deleted row still resolves and translates),
 *    so a ghost can only be fabricated or pre-retirement. The seam
 *    test that pinned ghost-ignore was updated in the same commit.
 *
 * `nextCursor` is no longer minted as a bare id on the Supa path: the
 * route mints it with encodeStoreOrdersCursor from the last RETURNED
 * row's key (the seam's fetched window is pre soft-delete-filter, so
 * only the route knows the returned row).
 *
 * The embedded products list is this group's OWN seam call (groups stay
 * independent; the merge planner deduplicates seams later if it wants),
 * shaped exactly like the products list in the Firestore GET: { id,
 * ...data, createdAt: ISO||null, updatedAt: ISO||null }.
 *
 * FLIP NOTE (S-K4): the keyset GET is safe under the READ flag alone —
 * it needs store_orders_page.sql (+ store_keyset_indexes.sql) applied
 * and SUPA_SURFACES=store-orders-api; it does NOT need SUPA_PRIMARY.
 * Write primacy for this slice is a separate, later flip (orders last,
 * after finance — see tx_store_order_patch.sql's reconciliation note).
 */

import { getSupaAdapter, getSupaClient, useSupa } from './index';
import {
  StoreOrdersCursorError,
  classifyStoreOrdersCursor,
  decodeStoreOrdersCursor,
  keyFromLegacyCursorRow,
  normalizeStatusFilter,
  type StoreOrderKey,
} from './store-orders-keyset';

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

/** The cursor was presented but cannot address this stream (route -> 400). */
export interface StoreOrdersInvalidCursor {
  invalidCursor: true;
  code: string;
}

export type StoreOrdersPageResult =
  | StoreOrdersPageData
  | StoreOrdersInvalidCursor
  | null;

/**
 * S-K1 — the keyset page fetcher: ONE foundation `rpc()` call to
 * store_orders_page with the decoded cursor KEY (never a bare value
 * bound). Throws on adapter failure; the seam's read-fallback law
 * (null -> Firestore) handles it.
 */
export async function fetchStoreOrdersKeysetPage(args: {
  limit: number;
  statusFilter: string | null;
  cursorKey: StoreOrderKey | null;
}): Promise<Array<{ id: string; raw: Record<string, unknown> }>> {
  const adapter = getSupaAdapter() as unknown as {
    rpc?: (fn: string, rpcArgs?: Record<string, unknown>) => Promise<unknown>;
  };
  if (typeof adapter.rpc !== 'function') {
    throw new Error(
      '[store-orders seam] adapter exposes no rpc() for store_orders_page; refusing the retired value-bound fetch',
    );
  }
  const rows = (await adapter.rpc('store_orders_page', {
    p_status: normalizeStatusFilter(args.statusFilter) || null,
    p_cursor_millis: args.cursorKey ? args.cursorKey.createdAtMillis : null,
    p_cursor_id: args.cursorKey ? args.cursorKey.id : null,
    p_limit: args.limit + 1,
  })) as Array<Record<string, unknown>>;
  return (rows || []).map((row) => {
    const data = (row.data ?? {}) as Record<string, unknown>;
    return { id: row.id as string, raw: { ...data } };
  });
}

/**
 * Fetch one orders page + the embedded products list through the
 * keyset rpc. Returns null when the surface is off / unconfigured /
 * errored so the caller falls back to Firestore; returns
 * { invalidCursor } when the presented cursor cannot be used (the
 * route answers 400 — an invalid cursor NEVER falls back to a silent
 * page-1 restart).
 */
export async function getStoreOrdersPageFromSupa(
  req: StoreOrdersPageRequest,
): Promise<StoreOrdersPageResult> {
  if (!useSupa(STORE_ORDERS_SURFACE)) return null;
  if (!getSupaClient()) return null;

  // Cursor resolution happens BEFORE the read-fallback try/catch: a
  // cursor error is a client error (400), never a fallback trigger.
  let cursorKey: StoreOrderKey | null = null;
  const family = classifyStoreOrdersCursor(req.cursor);
  if (family === 'keyset') {
    try {
      const decoded = decodeStoreOrdersCursor(req.cursor as string, req.statusFilter);
      cursorKey = { createdAtMillis: decoded.createdAtMillis, id: decoded.id };
    } catch (err) {
      if (err instanceof StoreOrdersCursorError) {
        return { invalidCursor: true, code: err.code };
      }
      throw err;
    }
  } else if (family === 'legacy-id') {
    let cursorDoc: Record<string, unknown> | null = null;
    try {
      cursorDoc = (await getSupaAdapter().getDoc(
        'orders',
        req.cursor as string,
      )) as Record<string, unknown> | null;
    } catch (err) {
      console.error('[store-orders seam] legacy cursor resolution failed, falling back to Firestore:', err);
      return null;
    }
    const key = keyFromLegacyCursorRow(
      cursorDoc ? { ...cursorDoc, id: (cursorDoc.id as string) ?? (req.cursor as string) } : null,
    );
    if (!key) return { invalidCursor: true, code: 'not-found' };
    cursorKey = key;
  }

  try {
    const adapter = getSupaAdapter();
    const fetched = await fetchStoreOrdersKeysetPage({
      limit: req.limit,
      statusFilter: req.statusFilter,
      cursorKey,
    });
    const productDocs = await adapter.listDocs('products');
    return {
      fetched,
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


/* ------------------------------------------------ write primacy (S-W2) */

import {
  callStoreTx,
  makeStoreDocId,
  storePrimaryEnabled,
  toSupaStorePayload,
  type StoreTxResult,
} from './store-primary';

/** True iff 'store-orders-api' is write-primary (both flags) + client. */
export function storeOrdersPrimaryEnabled(): boolean {
  return storePrimaryEnabled(STORE_ORDERS_SURFACE);
}

/**
 * GE seam: vendor facts for the orders route's classification when the
 * primacy leg skips its Firestore pricing reads. Returns null when
 * primacy is off (the route uses its Firestore lookup). Adapter errors
 * throw (fail closed), matching getStoreProductForVerification.
 */
export async function getStoreProductForOrderEnrichment(
  productId: string,
): Promise<{
  exists: boolean;
  price?: unknown;
  isActive?: unknown;
  // Required (value may be undefined) so the result satisfies
  // VendorProductFacts at the orders route's readFacts seam.
  vendorId: unknown;
  deliveryChargePkr: unknown;
  deliveryPromiseDays: unknown;
  stock: unknown;
  currency?: unknown;
} | null> {
  if (!storeOrdersPrimaryEnabled()) return null;
  const doc = (await getSupaAdapter().getDoc('products', productId)) as Record<string, unknown> | null;
  if (!doc) {
    return {
      exists: false,
      vendorId: undefined,
      deliveryChargePkr: undefined,
      deliveryPromiseDays: undefined,
      stock: undefined,
    };
  }
  return {
    exists: true,
    price: doc.price,
    isActive: doc.isActive,
    vendorId: doc.vendorId,
    deliveryChargePkr: doc.deliveryChargePkr,
    deliveryPromiseDays: doc.deliveryPromiseDays,
    stock: doc.stock,
    currency: doc.currency,
  };
}

export interface StoreOrderCreatePrimaryArgs {
  /** The canonical order shape the route built (Firestore timestamps ok). */
  orderData: Record<string, unknown>;
  idempotencyKey: string | null;
  productId: string | null;
  claimed: number | null;
  quantity: number;
  /** GE: pre-minted order id (credit claims and group seats key on it
   *  before the tx runs). Default: minted here, as before. */
  orderId?: string;
  /** GE: server-read delivery charge, forwarded to the tx as
   *  p_delivery_pkr (tx_store_order_create amendment). Default 0. */
  deliveryPkr?: number;
  /** Every priced line (audit item 4): the tx prices all of them
   *  fail-closed from fs_products. Null keeps the legacy
   *  single-product parameters as the priced line. */
  items?: Array<{ productId: string; quantity: number }> | null;
  isDonation: boolean;
  isUsdCertificate: boolean;
}

/**
 * O1 under primacy: ONE tx_store_order_create call as the only writer.
 * Price verification is re-done inside the transaction against
 * fs_products (the route's Firestore verification is skipped on this
 * path); the tx returns today's 422 as a value on a mismatch.
 * Idempotency (design §3.5): the caller's per-attempt key dedupes on
 * (buyerUserId, key) — the result's `created` flag tells the route
 * whether to fire its post-write notifications.
 */
export async function createStoreOrderViaPrimary(
  args: StoreOrderCreatePrimaryArgs,
): Promise<StoreTxResult> {
  const orderId = args.orderId || makeStoreDocId();
  const nowIso = new Date().toISOString();
  const data = toSupaStorePayload(args.orderData, nowIso) as Record<string, unknown>;
  return callStoreTx(
    'tx_store_order_create',
    'store_order_create',
    {
      p_id: orderId,
      p_data: data,
      p_product_id: args.productId,
      p_claimed: args.claimed,
      p_quantity: args.quantity,
      p_items: args.items ?? null,
      p_is_donation: args.isDonation,
      p_is_usd: args.isUsdCertificate,
      p_delivery_pkr: args.deliveryPkr ?? 0,
    },
    args.idempotencyKey,
  );
}

export interface StoreOrderPatchPrimaryArgs {
  orderId: string;
  /** Sanitized fulfilment-only updates (route guard already applied). */
  sanitized: Record<string, unknown>;
  /** Money-audit fields the route derived (action / changedFields / source). */
  audit: Record<string, unknown>;
}

/**
 * O2 under primacy: ONE tx_store_order_patch call as the only writer.
 * Only the explicit scalar fields cross the boundary — never an
 * arbitrary patch object — so the tx cannot move a money field. The
 * result carries `order_data` (the committed row) for the route's
 * buyer notification, and a 404 as a value when the order is absent.
 */
export async function patchStoreOrderViaPrimary(
  args: StoreOrderPatchPrimaryArgs,
): Promise<StoreTxResult> {
  return callStoreTx('tx_store_order_patch', 'store_order_patch', {
    p_id: args.orderId,
    p_status: (args.sanitized.status as string) ?? null,
    p_has_status: args.sanitized.status !== undefined,
    p_fulfilment_note: (args.sanitized.fulfilmentNote as string) ?? null,
    p_has_fulfilment_note: args.sanitized.fulfilmentNote !== undefined,
    p_audit: args.audit,
  });
}
