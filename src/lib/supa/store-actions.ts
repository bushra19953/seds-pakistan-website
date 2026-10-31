/**
 * Store server-actions read seam (Cluster M, Group 3) — server-only.
 *
 * Flag: useSupa('store-actions'). When the flag is OFF, no Supabase
 * client is configured, or the adapter throws, these helpers return null
 * and src/app/actions/store.ts serves its Firestore path byte-identically.
 *
 * The two READ actions are served here:
 *  - getProduct(productId)        -> adapter.getDoc('products', id)
 *  - getPublicProducts()          -> adapter.listDocs('products',
 *                                    { where: [['isActive','==',true]] })
 * CUTOVER (store build, S-W3/S-W4): createOrder and syncEventToProduct
 * gain write-primacy forms at the bottom of this file, gated on
 * isSupaPrimary('store-actions'); with the flag OFF nothing below the
 * read helpers is reached and the actions serve Firestore byte-
 * identically. createOrder was on the MANUAL list
 * (transactional writes) and are NOT served by this seam.
 *
 * Timestamp conversion replicates the current serializers exactly
 * (STORE_CLUSTER_PLAN.md, Timestamp contract):
 *  - getProduct (serializeToken): {...data, id} with id AFTER the spread;
 *    createdAt/updatedAt become ISO strings ONLY when Timestamp-like
 *    (a value with toDate()); every other value passes through untouched.
 *    The adapter rehydrates dumped {_seconds,_nanoseconds} timestamps
 *    into SupaTimestamp (which has toDate()), and Firestore Timestamps
 *    behave the same way, so both sources serialize identically; ISO
 *    strings from the jsonb landing pass through as stored.
 *  - getPublicProducts: createdAt = toDate-ISO || the raw stored value
 *    (the `|| data.createdAt` fallback keeps strings intact).
 *
 * Stored shapes are reproduced faithfully: no category normalization
 * ('event_ticket' stays 'event_ticket' — EV-P07 is a separate fix) and
 * no field renames.
 */

import { getSupaAdapter, getSupaClient, useSupa } from './index';

export const STORE_ACTIONS_SURFACE = 'store-actions';

/** serializeToken semantics: ISO only for Timestamp-like values, else passthrough. */
function serializeTimestampPassthrough(value: unknown): unknown {
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    try {
      return (value as { toDate: () => Date }).toDate().toISOString();
    } catch {
      return value;
    }
  }
  return value;
}

/** getPublicProducts semantics: toDate-ISO, falling back to the raw stored value. */
function isoOrPassthrough(value: unknown): unknown {
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    try {
      return (value as { toDate: () => Date }).toDate().toISOString() || value;
    } catch {
      return value;
    }
  }
  return value;
}

export type SupaProductResult =
  | { found: true; data: Record<string, unknown> }
  | { found: false };

/**
 * getProduct's Supabase read. null = fall back to Firestore;
 * { found:false } = adapter answered and the product does not exist
 * (the action returns 'Product not found', exactly as the Firestore
 * path does for a missing doc).
 */
export async function getProductFromSupa(productId: string): Promise<SupaProductResult | null> {
  if (!useSupa(STORE_ACTIONS_SURFACE)) return null;
  if (!getSupaClient()) return null;
  try {
    const doc = (await getSupaAdapter().getDoc('products', productId)) as Record<string, unknown> | null;
    if (!doc) return { found: false };
    const { id, ...data } = doc;
    // serializeToken parity: id is assigned AFTER the spread.
    const result: Record<string, unknown> = { ...data, id };
    result.createdAt = serializeTimestampPassthrough(result.createdAt);
    result.updatedAt = serializeTimestampPassthrough(result.updatedAt);
    return { found: true, data: result };
  } catch (err) {
    console.error('[store-actions seam] getProduct adapter read failed, falling back to Firestore:', err);
    return null;
  }
}

/**
 * getPublicProducts' Supabase read. null = fall back to Firestore.
 * Only active products, shaped exactly like the Firestore action.
 */
export async function listPublicProductsFromSupa(): Promise<Array<Record<string, unknown>> | null> {
  if (!useSupa(STORE_ACTIONS_SURFACE)) return null;
  if (!getSupaClient()) return null;
  try {
    const docs = await getSupaAdapter().listDocs('products', { where: [['isActive', '==', true]] });
    return docs.map((d) => {
      const { id, ...data } = d as Record<string, unknown>;
      return {
        ...data,
        id,
        createdAt: isoOrPassthrough(data.createdAt),
        updatedAt: isoOrPassthrough(data.updatedAt),
      };
    });
  } catch (err) {
    console.error('[store-actions seam] getPublicProducts adapter read failed, falling back to Firestore:', err);
    return null;
  }
}


/* ------------------------------------------------ write primacy (S-W3/S-W4) */

import {
  callStoreTx,
  makeStoreDocId,
  storePrimaryEnabled,
  type StoreTxResult,
} from './store-primary';

/** True iff 'store-actions' is write-primary (both flags) + client. */
export function storeActionsPrimaryEnabled(): boolean {
  return storePrimaryEnabled(STORE_ACTIONS_SURFACE);
}

/**
 * Product price read for createOrder's verification UNDER PRIMACY.
 * Flip order is products -> ... -> actions, so when store-actions is
 * primary the Firestore product docs are no longer the live price
 * source; the action verifies against fs_products instead. Returns
 * null when primacy is off (the action uses its Firestore reads,
 * byte-identical). Adapter errors THROW — silently verifying against
 * a stale Firestore price would be worse than failing the checkout.
 */
export async function getStoreProductForVerification(
  productId: string,
): Promise<{
  found: boolean;
  price?: unknown;
  isActive?: unknown;
  category?: unknown;
  eventId?: unknown;
  vendorId?: unknown;
  deliveryChargePkr?: unknown;
  deliveryPromiseDays?: unknown;
  stock?: unknown;
  currency?: unknown;
} | null> {
  if (!storeActionsPrimaryEnabled()) return null;
  const doc = (await getSupaAdapter().getDoc('products', productId)) as Record<string, unknown> | null;
  if (!doc) return { found: false };
  return {
    found: true,
    price: doc.price,
    isActive: doc.isActive,
    category: doc.category,
    eventId: doc.eventId,
    // GE vendor facts, from the same adapter doc this read already made.
    vendorId: doc.vendorId,
    deliveryChargePkr: doc.deliveryChargePkr,
    deliveryPromiseDays: doc.deliveryPromiseDays,
    stock: doc.stock,
    currency: doc.currency,
  };
}

/**
 * GE: order read for submitNotFoundText under primacy. null = primacy
 * off (the action reads Firestore); { found:false } = adapter answered
 * and the order does not exist.
 */
export async function getStoreOrderFromSupa(
  orderId: string,
): Promise<{ found: boolean; data?: Record<string, unknown> } | null> {
  if (!storeActionsPrimaryEnabled()) return null;
  const doc = (await getSupaAdapter().getDoc('orders', orderId)) as Record<string, unknown> | null;
  if (!doc) return { found: false };
  return { found: true, data: doc };
}

/**
 * GE: the not-found answer write under primacy. Returns null when
 * primacy is off (caller writes Firestore), true once the adapter
 * update lands. Adapter errors throw, matching
 * getStoreProductForVerification's fail-closed rule.
 */
export async function updateOrderNotFoundViaPrimary(
  orderId: string,
  text: string,
): Promise<boolean | null> {
  if (!storeActionsPrimaryEnabled()) return null;
  await getSupaAdapter().updateDoc('orders', orderId, {
    notFoundText: text,
    updatedAt: new Date().toISOString(),
  });
  return true;
}

export interface CreateOrderActionPrimaryArgs {
  /** App-minted order id (Firestore auto-id shape) — the registration
   *  mirror doc carries it, so it is minted by the action, not here. */
  orderId: string;
  /** finalOrder with timestamps already converted to ISO strings. */
  orderData: Record<string, unknown>;
  eventId: string | null;
  /** Registration mirror doc (ISO timestamps) or null. */
  registration: Record<string, unknown> | null;
  productId: string | null;
  /** ORDER_CREATED audit payload ({ total, currency, module, productId }). */
  auditPayload: Record<string, unknown>;
  idempotencyKey: string | null;
}

/**
 * A1+A2+A5 under primacy: ONE tx_store_create_order call as the
 * only writer for the store-owned writes. (A3, the checkout-time
 * product stub, was removed by the audit item-4 fix: a checkout must
 * never create a product, and the tx no longer writes fs_products.)
 * The result's `created` flag
 * distinguishes a fresh commit from an idempotent replay (design
 * §3.5); a replay wrote nothing. Throws on tx failure — the action
 * maps it to { success: false } and NO order persists (the orphan
 * class the Firestore chain allows is dead on this path). The chapter
 * application link (A4) is NOT part of this call: it stays a post-tx
 * best-effort Firestore update in the action, by design.
 */
export async function createOrderViaStorePrimary(
  args: CreateOrderActionPrimaryArgs,
): Promise<StoreTxResult> {
  const orderId = args.orderId;
  const result = await callStoreTx(
    'tx_store_create_order',
    'store_create_order',
    {
      p_order_id: orderId,
      p_order_data: args.orderData,
      p_event_id: args.eventId,
      p_registration: args.registration,
      p_product_id: args.productId,
      // Retained for signature compatibility with the applied tx;
      // the tx ignores it (no product is ever created by a checkout).
      p_generated_product_id: null,
      p_audit: { payload: args.auditPayload },
    },
    args.idempotencyKey,
  );
  return { ...result, orderId: (result.orderId as string) || orderId };
}

/**
 * A6 / S-W4 under primacy: syncEventToProduct's single-row write via
 * the adapter (no tx needed for one row). The payload is the caller's
 * own payload with timestamps converted to ISO strings — fields and
 * values are otherwise byte-identical (`event_ticket` category and
 * the EV-P07 product-link semantics untouched). Returns null when
 * primacy is off (caller runs its Firestore write); adapter errors
 * throw and the action reports them as today's { success: false }.
 */
export async function syncEventProductViaPrimary(args: {
  payload: Record<string, unknown>;
  existingProductId?: string;
}): Promise<{ id: string } | null> {
  if (!storeActionsPrimaryEnabled()) return null;
  const adapter = getSupaAdapter();
  if (args.existingProductId && args.existingProductId !== 'none') {
    await adapter.updateDoc('products', args.existingProductId, args.payload);
    return { id: args.existingProductId };
  }
  const newProductId = makeStoreDocId();
  await adapter.setDoc('products', newProductId, args.payload);
  return { id: newProductId };
}
