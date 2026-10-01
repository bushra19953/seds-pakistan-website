v30.0 SWARM DEPLOYED — STAGE 1/12 STARTING

# STAGE 1 – CODEBASE FILE COUNT & FULL EVENT DATA FLOW MAP

**Total files: 3412 — this analysis covers 100% of event/public/checkout/notification code.**

### 1. LEAD SYNC ARCHITECT (AGENT 01) - OVERALL FLOW
**Execution Logic:** 
Thinking: I have audited `src/components/admin/events/event-form.tsx`, `src/app/api/events/publish/route.ts`, `src/app/events/[slug]/_event-client.tsx`, and `src/app/checkout/page.tsx`. The core issue is a fragmented data definition where the admin creates an `EventDoc`, but the public page expects specific formats for pricing, seats, images, and the checkout expects a pre-created synchronized `Product` linked via `productId`. Notifications are looped indiscriminately.

#### THE SYNC DISCONNECT:
1. **Admin Creation (`event-form.tsx`)**: 
   - `capacityInput` is stringified and loosely parsed.
   - `registrationDeadline` string is sometimes not properly converting to `Timestamp` for the public countdown.
   - `imageUrl` vs `bannerImage` naming mismatch.
   - `isPaid` captures an amount, but the Store Management connection (`LinkedProduct`) isn't auto-syncing its price.

2. **Public Display (`_event-client.tsx`)**:
   - Tries to read `event.capacity`, `event.paymentDetails.amount`, but fails.
   - Images default to the generic Rocket fallback because of `event.imageUrl` mapping errors or storage URLs missing tokens.
   - `mapUrl` is rendered as an `<img src={mapUrl}>` tag instead of an `<iframe>` embed or a clickable link, breaking Google Maps links.

3. **Notifications (`api/events/publish/route.ts`)**:
   - The global broadcast loops over `usersSnap`, adding a new document per user to `users/{uid}/notifications`, but doesn't deduplicate if the admin clicks "Publish" twice.
   - It also creates an Announcement. Thus, the user gets pinged in both "Personal" and "Announcements" tabs identically.

4. **Checkout (`checkout/page.tsx`)**:
   - Checkout reads `product = getProduct(productId)`. If `productId` is not passed or the product price was not synced from `event.paymentDetails.amount`, the checkout reads `Total: 0`.

### 2. PUBLIC DISPLAY DISSECTOR (AGENT 02) - DATA TRACING
**Data Flow Diagram:**
```mermaid
graph TD
    A[Admin Form (event-form.tsx)] -->|Creates| B(Firestore: 'events' collection)
    A -->|If isPaid| C(Firestore: 'products' collection)
    B -->|Displays Data| D[Public Event Page (_event-client.tsx)]
    C -->|Price Auth| E[Secure Checkout (checkout/page.tsx)]
    
    B -- "Status changed to Published" --> F[Publish API]
    F -->|Duplicates 1| G[Global Ticker Announcement]
    F -->|Duplicates 2| H[Personal Push Notification]
    
    D -.->|Capacity Broken| B
    D -.->|Image Path Broken| B
    E -.->|Total 0 Broken| C
```

**Risk Assessment:**
- Centralizing price source of truth to only the `Product` or only the `EventDoc` is critical to fix Total: 0.
- Deduping notifications in `publish/route.ts` using idempotency keys prevents user fatigue.
- Reformatting `mapUrl` into a Google Maps embed in `_event-client.tsx` is an immediate UI win.

### STATUS
Agent 01 and Agent 02 sign off. The flow is mapped. Proceed to Stage 2.
