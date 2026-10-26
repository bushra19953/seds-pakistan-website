/**
 * Event <-> store product linking (EV-P07 fix).
 *
 * One home for the three decisions every surface in the paid-event chain
 * must agree on:
 *
 *  1. Which store products the admin event form's "Linked Store Product"
 *     dropdown may offer. The canonical category written by every
 *     producer (store product form, syncEventToProduct, createOrder
 *     stubs) is 'event_ticket' (UNDERSCORE). The dropdown historically
 *     filtered for 'event-ticket' / 'event' only, so real ticket
 *     products were never offered and paid events could not be linked.
 *     The filter accepts the canonical spelling plus the legacy
 *     spellings so pre-existing rows keep working.
 *
 *  2. How a saved event form payload expresses its payment link. The
 *     form nests payment state under `paymentDetails` and carries the
 *     dropdown selection in `productId` ('none' / '' = no link). The
 *     create/edit pages previously gated their store sync on a
 *     top-level `payload.isPaid` that the form never emits, so the
 *     sync (and with it the persisted link) never ran.
 *
 *  3. Which event field names the linked product id on read.
 *     `linkedStoreProductId` is preferred, `productId` is the field
 *     the form writes; every reader must honor both (the register
 *     page previously read only `linkedStoreProductId` and sent paid
 *     events to a checkout with no product, which answered
 *     "Item Unavailable").
 */

/** Canonical category for event ticket products (underscore). */
export const EVENT_TICKET_CATEGORY = 'event_ticket';

/** Category spellings that make a product linkable to an event. */
export const LINKABLE_EVENT_PRODUCT_CATEGORIES: readonly string[] = [
    EVENT_TICKET_CATEGORY,
    'event-ticket',
    'event',
];

type ProductLike = {
    category?: unknown;
    isActive?: unknown;
} | null | undefined;

/**
 * True when a product may be offered by the Linked Store Product
 * dropdown: active (the dropdown's query already restricts to
 * isActive == true; the check is repeated so the composed behavior is
 * testable against raw collection rows) and in a linkable category.
 */
export function isLinkableEventProduct(product: ProductLike): boolean {
    if (!product) return false;
    if (product.isActive !== true) return false;
    return typeof product.category === 'string'
        && LINKABLE_EVENT_PRODUCT_CATEGORIES.includes(product.category);
}

/** The products the Linked Store Product dropdown offers. */
export function filterLinkableEventProducts<T extends ProductLike>(
    products: readonly T[] | null | undefined,
): T[] {
    return (products || []).filter(isLinkableEventProduct);
}

type EventFormPayloadLike = {
    productId?: unknown;
    paymentDetails?: {
        isPaid?: unknown;
        amount?: unknown;
        currency?: unknown;
    } | null;
} | null | undefined;

export type EventProductLink = {
    /** True when the saved event is a paid event. */
    isPaid: boolean;
    /** The linked store product id, or undefined for "None (Free Event)". */
    productId?: string;
    /** Paid amount from the form's paymentDetails (0 when unset). */
    amount?: number;
    /** Currency from the form's paymentDetails. */
    currency?: string;
};

/**
 * Derive the payment link from a submitted event form payload.
 * 'none', '' and missing productId all mean "no link".
 */
export function eventProductLinkFromPayload(payload: EventFormPayloadLike): EventProductLink {
    const details = payload?.paymentDetails;
    const isPaid = details?.isPaid === true;
    const rawId = payload?.productId;
    const productId = typeof rawId === 'string' && rawId !== '' && rawId !== 'none'
        ? rawId
        : undefined;
    if (!isPaid) return { isPaid: false, productId };
    return {
        isPaid: true,
        productId,
        amount: typeof details?.amount === 'number' ? details.amount : undefined,
        currency: typeof details?.currency === 'string' && details.currency !== ''
            ? details.currency
            : undefined,
    };
}

type EventLike = {
    productId?: unknown;
    linkedStoreProductId?: unknown;
} | null | undefined;

/**
 * The linked store product id of a stored event, from either field
 * name ('none' / '' count as no link). Mirrors the fallback the CTA
 * and checkout already apply; the register page must use this too.
 */
export function eventLinkedProductId(event: EventLike): string | undefined {
    for (const raw of [event?.linkedStoreProductId, event?.productId]) {
        if (typeof raw === 'string' && raw !== '' && raw !== 'none') return raw;
    }
    return undefined;
}
