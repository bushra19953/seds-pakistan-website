# STAGE 3 — PAGE BREAKDOWN: EVENTS PAGE
## v11.0 SWARM DEPLOYED — STAGE 3/15 (PAGE 2 of 11)
**AGENT 03 – PAGE BUTCHER**

---

> **Thinking (COT):** Events are the lifeblood of SEDS activity. The events system spans: public event listing (`/events`), individual event detail pages (`/events/[slug]`), admin event CRUD (`/admin/events`), event registration flow (with store integration), ticket generation (`/admin/events/[id]/tickets`), and event registration management. Payment goes through the Store. Each event can be paid/free, public/members-only, and can have an associated Store product.

---

## 📅 Page: Events Listing (`/events`)

**File:** `src/app/events/page.tsx`  
**Visibility:** Public  
**Purpose:** Discover and filter all upcoming SEDS events, workshops, and webinars

### Sections
1. **Hero Header** — "Events & Workshops" title, search bar
2. **Filter Bar** — Filter by type (event / workshop / webinar), status, date range
3. **Events Grid** — Card grid of published events
4. **Pagination** — Load more / paginated cards

### Visibility Rules
| Event Visibility | Guest | Member | Admin |
|---|---|---|---|
| `public` | ✅ | ✅ | ✅ |
| `members` | ❌ (blurred/hidden) | ✅ | ✅ |
| `private` | ❌ | ❌ | ✅ |
| `draft` | ❌ | ❌ | ✅ (in admin) |

---

## 📋 Page: Event Detail (`/events/[slug]`)

**File:** `src/app/events/[slug]/page.tsx`  
**Visibility:** Public (respects event visibility rules)  
**Purpose:** Full event landing page with registration CTA

### Sections
1. **Hero Image** — Full-width event banner
2. **Event Info** — Title, date/time, location (online or physical), type badge
3. **Value Proposition** — `valueProposition` and `catalystStatement` from EventDoc
4. **Strategic Framing** — Lifestyle outcome, emotional hooks (hidden backend labels)
5. **Registration CTA** — Button triggers registration flow
6. **Capacity Info** — Shows remaining spots if capacity is set
7. **Speakers/Details** — Additional rich content

### Registration Flow Decision Tree
```
User clicks "Register" →
  Is user signed in?
  ├─ NO → Redirect to /auth/login?redirect=/events/[slug]
  └─ YES →
       Is event linked to Store product? (linkedStoreProductId present)
       ├─ YES → Redirect to /checkout?productId=[linkedStoreProductId]
       └─ NO →
            Is event paid? (paymentDetails.isPaid = true)
            ├─ YES → Show manual payment modal (requires Transaction ID + receipt)
            └─ NO → Direct registration (free event, stored in events/{id}/registrations)
```

### Event Payment States
| State | Description |
|---|---|
| `registrationOpen: false` | Registration closed — CTA disabled |
| `paymentDetails.isPaid: false` | Free event — direct register |
| `paymentDetails.isPaid: true` + `productId` | Paid via Store checkout |
| `paymentDetails.isPaid: true` + no `productId` | Manual bank transfer |

---

## 🎛️ Admin Events Management (`/admin/events`)

**Access:** `manageEvents` permission  
**File:** `src/app/admin/events/page.tsx`

### What Admins Can Do
| Action | How |
|---|---|
| Create new event | Click "New Event" → `/admin/events/new` |
| Edit existing event | Click event → `/admin/events/[id]` |
| Toggle publish status | Status dropdown: draft → scheduled → published → archived |
| Set event visibility | public / members / private |
| Open/close registration | Toggle `registrationOpen` |
| Link Store product | Set `productId` field on event form |
| Set ticker display | Toggle `showInTicker` and `broadcastUntil` |
| Design ticket | `/admin/events/[id]/tickets` — Live Ticket Studio |
| View registrations | `/admin/events/[id]/registrations` |
| AI Sponsor Match | `/admin/events/sponsor-match` — AI-powered sponsor suggestions |

### Event Form Key Fields
```
Title, Slug (auto-generated), Description
Type: event | workshop | webinar
Status: draft | scheduled | published | archived
Visibility: public | members | private
Start Date/Time, End Date/Time
Online/Physical toggle
Location, Venue, Map URL
Capacity (optional)
Registration Open toggle
Payment: isPaid, amount, currency, instructions, QR code URL
Tags
Value Proposition, Catalyst Statement, Lifestyle Outcome
Strategic Framing fields (internal only)
Image URL
Linked Store Product ID
Show in Ticker + Broadcast Until
```

---

## 🎫 Live Ticket Studio (`/admin/events/[id]/tickets`)

**Purpose:** Design the PDF ticket for an event with drag-and-drop overlay positioning

### 15 Configurable Overlays
| Overlay | Side | Description |
|---|---|---|
| `name` | Front/Back | Attendee's name |
| `ticketNum` | Front/Back | Ticket number |
| `email` | Front/Back | Attendee email |
| `eventTitle` | Front | Event name |
| `eventDate` | Front/Back | Event date |
| `eventVenue` | Front/Back | Venue |
| `logo` | Front/Back | Organization logo |
| `orgName` | Front/Back | Organization name |
| `orgTagline` | Front/Back | Organization tagline |
| `issuedDate` | Front/Back | Issue date |
| `statusBadge` | Front/Back | Registration status badge |
| `paymentRef` | Front/Back | Payment reference number |
| `verificationUrl` | Front/Back | QR/URL for verification |
| `disclaimer` | Front/Back | Legal disclaimer |
| `qrCode` | Front/Back | QR code |

Admins can position each overlay by x/y coordinates, font size, color, and toggle enabled/disabled.

---

## 📊 Event Registrations (`/admin/events/[id]/registrations`)

Shows all registrations for an event with:
- Attendee name, email, WhatsApp
- Registration status: `pending` | `under_review` | `confirmed` | `cancelled`
- Payment status: `unpaid` | `pending` | `verified` | `refunded`
- Linked transaction ID
- Actions: Confirm, Reject, Print Ticket, Send Notification

---

*AGENT 03 sign-off: Events page fully documented end-to-end.*
