/**
 * EV-P07 fix — event <-> store product linking (src/lib/events/product-link.ts).
 *
 * On the unmodified tree this suite cannot run (the module does not
 * exist), and each expectation below contradicts the old inline
 * behavior:
 *  - the dropdown filter in event-form.tsx accepted only the hyphen
 *    spellings 'event-ticket' / 'event', while every producer writes
 *    'event_ticket' (underscore) — real ticket products were never
 *    offered;
 *  - the create/edit pages gated their store sync on a top-level
 *    payload.isPaid the form never emits, so the link never persisted;
 *  - the register page read only linkedStoreProductId, ignoring the
 *    productId field the form writes, and sent paid events to a
 *    product-less checkout ("Item Unavailable").
 */
import {
    EVENT_TICKET_CATEGORY,
    eventLinkedProductId,
    eventProductLinkFromPayload,
    filterLinkableEventProducts,
    isLinkableEventProduct,
} from '../product-link';

describe('EV-P07: Linked Store Product dropdown eligibility', () => {
    it('the canonical category constant is the underscore spelling producers write', () => {
        expect(EVENT_TICKET_CATEGORY).toBe('event_ticket');
    });

    it('offers a product written by syncEventToProduct / the store product form (category "event_ticket")', () => {
        const offered = filterLinkableEventProducts([
            { id: 'ticket-1', name: 'EV2 PAID TEST — Ticket', price: 500, currency: 'PKR', isActive: true, category: 'event_ticket' },
        ]);
        expect(offered.map((p) => p.id)).toEqual(['ticket-1']);
    });

    it('still offers the legacy spellings "event-ticket" and "event"', () => {
        const offered = filterLinkableEventProducts([
            { id: 'a', isActive: true, category: 'event-ticket' },
            { id: 'b', isActive: true, category: 'event' },
        ]);
        expect(offered.map((p) => p.id)).toEqual(['a', 'b']);
    });

    it('does not offer other categories', () => {
        const offered = filterLinkableEventProducts([
            { id: 'm', isActive: true, category: 'merchandise' },
            { id: 'c', isActive: true, category: 'certificate' },
            { id: 'w', isActive: true, category: 'workshop' },
            { id: 'd', isActive: true, category: 'digital_content' },
            { id: 'o', isActive: true, category: 'other' },
        ]);
        expect(offered).toEqual([]);
    });

    it('does not offer inactive ticket products', () => {
        expect(isLinkableEventProduct({ isActive: false, category: 'event_ticket' })).toBe(false);
        expect(filterLinkableEventProducts([
            { id: 'x', isActive: false, category: 'event_ticket' },
        ])).toEqual([]);
    });

    it('is null-safe for an unloaded products query', () => {
        expect(filterLinkableEventProducts(undefined)).toEqual([]);
        expect(filterLinkableEventProducts(null)).toEqual([]);
        expect(isLinkableEventProduct(undefined)).toBe(false);
    });
});

describe('EV-P07: payment link derivation from the submitted form payload', () => {
    it('a paid payload with a chosen product yields the link the create/edit sync needs', () => {
        const link = eventProductLinkFromPayload({
            productId: 'ticket-1',
            paymentDetails: { isPaid: true, amount: 500, currency: 'PKR' },
        });
        expect(link).toEqual({ isPaid: true, productId: 'ticket-1', amount: 500, currency: 'PKR' });
    });

    it('a paid payload with "none" chosen yields a paid link with NO product id (sync must create one)', () => {
        const link = eventProductLinkFromPayload({
            productId: 'none',
            paymentDetails: { isPaid: true, amount: 750, currency: 'PKR' },
        });
        expect(link.isPaid).toBe(true);
        expect(link.productId).toBeUndefined();
    });

    it('a paid payload whose dropdown was never touched (empty productId) also has no product id', () => {
        const link = eventProductLinkFromPayload({
            productId: '',
            paymentDetails: { isPaid: true, amount: 750, currency: 'PKR' },
        });
        expect(link.isPaid).toBe(true);
        expect(link.productId).toBeUndefined();
    });

    it('a free payload is not a payment link, even if a stale productId rides along', () => {
        const link = eventProductLinkFromPayload({
            productId: 'ticket-1',
            paymentDetails: { isPaid: false },
        });
        expect(link.isPaid).toBe(false);
    });

    it('reads isPaid ONLY from paymentDetails — a stray top-level isPaid does not make it paid', () => {
        const link = eventProductLinkFromPayload({
            productId: 'ticket-1',
            // @ts-expect-error probing the exact shape confusion that broke the old gate
            isPaid: true,
            paymentDetails: { isPaid: false },
        });
        expect(link.isPaid).toBe(false);
    });
});

describe('EV-P07: linked product id of a stored event (checkout entry points)', () => {
    it('resolves productId — the field the form writes (the register page used to miss this)', () => {
        expect(eventLinkedProductId({ productId: 'ticket-1' })).toBe('ticket-1');
    });

    it('prefers linkedStoreProductId when both are present', () => {
        expect(eventLinkedProductId({ productId: 'a', linkedStoreProductId: 'b' })).toBe('b');
    });

    it('treats "none" and "" as no link on either field', () => {
        expect(eventLinkedProductId({ productId: 'none' })).toBeUndefined();
        expect(eventLinkedProductId({ linkedStoreProductId: 'none', productId: 'ticket-1' })).toBe('ticket-1');
        expect(eventLinkedProductId({})).toBeUndefined();
        expect(eventLinkedProductId(undefined)).toBeUndefined();
    });
});
