# STAGE 3 — PAGE BREAKDOWN: STORE & PRODUCTS
## v11.0 SWARM DEPLOYED — STAGE 3/15 (PAGE 4 of 11)
**AGENT 03 – PAGE BUTCHER**

---

> **Thinking (COT):** The Store (`/explore`) is the central marketplace. It is the destination for all paid items. This MD focuses on the storefront and product management, separating it from the Checkout flow.

---

## 🛒 Page: Store (`/explore`)

**File:** `src/app/explore/page.tsx`  
**Visibility:** Signed-in users only. Unauthenticated users redirected to `/auth/login`.  
**Purpose:** Browse and buy SEDS Pakistan products, memberships, and event tickets.

### Store Architecture
The store is a data-driven catalog that feeds into the unified checkout system. It is designed to be lightweight, with most logic residing in the Firestore `products` collection.

---

## Page Sections

### 1. Product Grid
- **Source:** Firestore `products` collection where `isActive: true`.
- **Filtering:** Filter by category (Event Ticket / Membership / Merch / Donation).
- **Sorting:** Sort by price (low to high / high to low) or creation date.
- **Search:** Title-based client-side search across all active products.

### 2. Product Card
- **Elements:** Product image, title, price (PKR), stock level.
- **CTA:** "Buy Now" → Redirects to `/checkout?productId=[id]`.
- **Logic:** If `stock <= 0`, button shows "Sold Out" and is disabled.

---

## 🎛️ Admin Store Management (`/admin/store`)

**Access:** `superadmin` role only.  
**Purpose:** Manage the inventory and pricing of all site items.

### Product CRUD Options
| Action | Field | Detail |
|---|---|---|
| **Create** | `name`, `description` | Public-facing product info |
| **Price** | `price`, `currency` | Typically PKR |
| **Stock** | `stock` | Inventory count (decrements on verified sale) |
| **Category** | `category` | Controls UI grouping |
| **Links** | `eventId`, `formId` | Connects product to event or custom form |
| **Visuals** | `imageUrl` | Product display image |

### Interaction: Linking to an Event
1. Admin creates a paid event in `/admin/events`.
2. Admin creates a corresponding product in `/admin/store` with `category: 'event_ticket'`.
3. Admin sets `eventId` on the product to the ID of the event.
4. Admin sets `productId` on the event to the ID of the product.
5. **Result:** When user clicks "Register" on event page, they are auto-routed to the Store product checkout.

---

## 📊 Inventory State Management

- **Pending Order:** Stock is NOT decremented yet.
- **Verified Payment:** Admin confirms receipt → Stock decrements by `quantity`.
- **Low Stock Alert:** Admin UI highlights products with `< 5` items remaining.

---

*AGENT 03 sign-off: Store and product management page fully documented.*
