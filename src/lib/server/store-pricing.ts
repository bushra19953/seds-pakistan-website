/**
 * Server-side store pricing (security fix, audit item 4).
 *
 * ONE implementation of the pricing rule, shared by the two order
 * writers: the checkout server action (src/app/actions/store.ts) and
 * the orders API route (src/app/api/store/orders/route.ts). The rule
 * is FAIL CLOSED:
 *
 *   - Every referenced product is priced from the server-side product
 *     record (via the caller's lookup — Firestore products, or
 *     fs_products under Supabase primacy). The client-sent price on an
 *     item is never read.
 *   - A product that is missing, inactive, or has no valid server-side
 *     price REJECTS the whole order. There is no "trust the claim"
 *     fallback and a checkout never creates or mutates a product.
 *   - The one sanctioned fallback is the event-ticket fallback: an
 *     event ticket whose product record does not exist yet (the
 *     checkout synthesises it client-side from the event page) is
 *     priced by the caller's resolver from the SERVER-SIDE event
 *     record (the linked store product, else the event's
 *     paymentDetails.amount) — never from the client's claim.
 *   - When the client does claim a total, it must equal the
 *     server-priced total exactly, or the order is rejected. The
 *     returned total is always the server-priced one.
 *
 * Donations are out of scope by design (callers skip this helper for
 * the donation module; a donation records the donor-declared amount).
 */

export class PriceVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceVerificationError';
  }
}

/**
 * Coerce a server-side stored price to a number. Accepts a finite
 * number or a numeric string (event paymentDetails.amount is written
 * by the event form as a number, but legacy docs may carry a string).
 * Anything else — null, NaN, negative, objects — is not a price.
 */
export function coerceServerPrice(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

/** The server-side product fields the pricing rule needs. */
export interface ServerProductRecord {
  exists: boolean;
  price?: unknown;
  isActive?: unknown;
  category?: unknown;
  eventId?: unknown;
}

export type ProductPriceLookup = (productId: string) => Promise<ServerProductRecord>;

/**
 * Fallback resolver for an event-ticket reference whose product record
 * is missing or unpriced. Receives the requested product id and the
 * (missing/unpriced) product record; returns a server-side price or
 * null when the server has no price for the ticket either (which
 * rejects the order).
 */
export type EventTicketPriceResolver = (
  productId: string,
  product: ServerProductRecord,
) => Promise<number | null>;

/** Price ONE product reference from the server record. Throws
 *  PriceVerificationError when no server-side price exists. */
export async function resolveServerUnitPrice(
  productId: string,
  lookup: ProductPriceLookup,
  resolveEventTicketPrice?: EventTicketPriceResolver,
): Promise<number> {
  const product = await lookup(productId);
  if (product.exists) {
    if (product.isActive === false) {
      throw new PriceVerificationError(
        `Product ${productId} is not available for purchase.`,
      );
    }
    const price = coerceServerPrice(product.price);
    if (price !== null) return price;
    // Exists but unpriced: only the event-ticket fallback may price it
    // (an event_ticket product for the order's event, priced on the
    // event record). Anything else rejects below.
  }
  if (resolveEventTicketPrice) {
    const fallback = await resolveEventTicketPrice(productId, product);
    if (fallback !== null) return fallback;
  }
  throw new PriceVerificationError(
    `Product ${productId} is missing or has no server-side price. Order rejected.`,
  );
}

export interface OrderItemLike {
  productId?: unknown;
  quantity?: unknown;
}

export interface PriceOrderArgs {
  productId?: string | null;
  items?: OrderItemLike[] | null;
  /** The client-claimed total, or null when the client claimed none. */
  claimedTotal: number | null;
  lookup: ProductPriceLookup;
  resolveEventTicketPrice?: EventTicketPriceResolver;
  /**
   * Prices an order that references NO product at all (the pure
   * event-ticket order: an eventId and nothing else). Returns the
   * server-side unit price or null to reject.
   */
  resolveUnreferencedPrice?: () => Promise<number | null>;
}

function itemQuantity(item: OrderItemLike): number {
  const q = item.quantity;
  if (q === undefined || q === null) return 1;
  if (typeof q !== 'number' || !Number.isFinite(q) || q <= 0) {
    throw new PriceVerificationError('Invalid item quantity. Order rejected.');
  }
  return q;
}

/**
 * Price a whole order server-side and return the verified total.
 * Throws PriceVerificationError on any missing / inactive / unpriced
 * product, on a malformed item, or when the claimed total differs
 * from the server-priced total.
 */
export async function priceOrderServerSide(args: PriceOrderArgs): Promise<number> {
  const { productId, items, claimedTotal, lookup, resolveEventTicketPrice } = args;
  const hasItems = Array.isArray(items) && items.length > 0;
  let verified: number | null = null;

  // The priced lines: every item, plus the order-level productId as
  // an extra quantity-1 line when it is not already one of the items
  // (the single-product shapes send productId alone, or productId ==
  // items[0]; both are covered exactly once this way).
  const lines: Array<{ productId: string; quantity: unknown }> = [];
  if (hasItems) {
    for (const item of items!) {
      if (!item || typeof item.productId !== 'string' || item.productId === '') {
        throw new PriceVerificationError(
          'Order item is missing its product reference. Order rejected.',
        );
      }
      lines.push({ productId: item.productId, quantity: item.quantity });
    }
  }
  if (productId && !lines.some((l) => l.productId === productId)) {
    lines.push({ productId, quantity: 1 });
  }

  if (lines.length > 0) {
    let sum = 0;
    for (const line of lines) {
      const unit = await resolveServerUnitPrice(line.productId, lookup, resolveEventTicketPrice);
      sum += unit * itemQuantity(line);
    }
    if (claimedTotal !== null && claimedTotal !== sum) {
      console.error(
        `Security Alert: Order total mismatch. Client sent ${claimedTotal}, server sum ${sum}`,
      );
      throw new PriceVerificationError('Security Error: Price tampering detected.');
    }
    verified = sum;
  }

  if (verified === null) {
    if (args.resolveUnreferencedPrice) {
      const unit = await args.resolveUnreferencedPrice();
      if (unit !== null) {
        if (claimedTotal !== null && claimedTotal !== unit) {
          console.error(
            `Security Alert: Unreferenced order total mismatch. Client sent ${claimedTotal}, server price ${unit}`,
          );
          throw new PriceVerificationError('Security Error: Price tampering detected.');
        }
        verified = unit;
      }
    }
  }

  if (verified === null) {
    throw new PriceVerificationError(
      'Order does not reference any product with a server-side price. Order rejected.',
    );
  }
  return verified;
}
