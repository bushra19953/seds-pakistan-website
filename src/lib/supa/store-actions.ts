/**
 * Store server-actions read seam (Cluster M, Group 3) — server-only.
 *
 * Flag: useSupa('store-actions'). When the flag is OFF, no Supabase
 * client is configured, or the adapter throws, these helpers return null
 * and src/app/actions/store.ts serves its Firestore path byte-identically.
 *
 * Only the two READ actions are served here:
 *  - getProduct(productId)        -> adapter.getDoc('products', id)
 *  - getPublicProducts()          -> adapter.listDocs('products',
 *                                    { where: [['isActive','==',true]] })
 * createOrder and syncEventToProduct are on the MANUAL list
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
