# STAGE 3 — PAGE BREAKDOWN: STORE, CHECKOUT & PROFILE PAGES
## v11.0 SWARM DEPLOYED — STAGE 3/15 (PAGES 4, 5, 6)
**AGENT 03 – PAGE BUTCHER**

---

> **Thinking (COT):** The Store is the centralized payment gateway. All financial transactions — event registrations, chapter fees, donations, certificates, tickets — route through the Store. The Checkout page handles the entire purchase flow. The Profile page is each user's personal hub. These three pages are tightly interconnected.

---

## 🛒 Page: Store (`/explore` or store-embedded checkout)

**Visibility:** Signed-in users only  
**Purpose:** Central marketplace for SEDS products (event tickets, merch, memberships)

### Store Data Model
```
products/{productId}
  name: string
  description: string
  price: number
  currency: string
  stock: number
  category: string
  eventId?: string          ← Links to events/{eventId}
  formId?: string           ← Links to custom form
  isActive: boolean
  imageUrl?: string
  createdBy: string
```

### Product Categories
| Category | Description |
|---|---|
| Event Ticket | Paid event registration |
| Chapter Registration | Membership fee |
| Certificate | Skill/participation certificate |
| Donation | Contribution to SEDS |
| Merchandise | SEDS branded items |

### Store Admin (`/admin/store`) — Superadmin Only
| Action | Description |
|---|---|
| Create product | Add new item with price, stock, category |
| Edit product | Update name, price, description, stock |
| Toggle active | Show/hide product from buyers |
| Link to event | Attach product to an event for ticket sales |
| Link to form | Require form completion before purchase |
| View orders | See all orders for this product |

---

## 💳 Page: Checkout (`/checkout?productId=[id]`)

**File:** `src/app/checkout/page.tsx`  
**Visibility:** Signed-in users only  
**Purpose:** Unified payment flow for all purchases

### Checkout Flow
```
1. User arrives at /checkout?productId=[id]
2. System fetches product details from Firestore
3. If product has linked form (formId):
   → User must complete the form first
4. User reviews purchase summary
5. User enters payment details:
   - Bank account transfer information shown
   - User uploads proof-of-payment (receipt image)
   - User enters Transaction ID (mandatory)
6. Order created in Firestore:
   orders/{orderId}
   status: 'pending'
   paymentStatus: 'pending'
   proofOfPaymentUrl: [uploaded image URL]
7. Admin reviews the receipt in /admin/orders
8. Admin manually confirms → paymentStatus: 'completed'
9. Order status → 'delivered'
10. If linked to event:
    → EventRegistration updated to status: 'confirmed', paymentStatus: 'verified'
11. User receives email notification
```

### Order Document Structure
```
orders/{orderId}
  userId: string
  items: OrderItem[]
  total: number
  currency: string
  status: 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled'
  paymentMethod: 'bank_transfer'
  paymentStatus: 'pending' | 'completed' | 'failed' | 'refunded'
  proofOfPaymentUrl: string     ← Receipt image
  buyer: { fullName, email, phone }
  formResponses?: {}             ← Custom form answers
  originatingModule: 'store' | 'chapter-registration' | 'donation'
  eventId?: string               ← If event ticket
  productId?: string
  createdAt, updatedAt, createdBy
```

---

## 👤 Page: Profile (`/profile/[uid]` and `/profile`)

**Files:** `src/app/profile/page.tsx`, `src/app/profile/[uid]/page.tsx`  
**Visibility:** Own profile — signed-in user; Other profiles — public or member-only  

### Profile Sections
| Section | Editable By | Visible To |
|---|---|---|
| Avatar / Photo | Self | Everyone |
| Display Name | Self | Everyone |
| Bio | Self | Everyone |
| University | Self | Everyone |
| Field of Study | Self | Everyone |
| Chapter | Self (read) / Admin (write) | Everyone |
| GitHub URL | Self | Everyone |
| LinkedIn URL | Self | Everyone |
| WhatsApp Number | Self | Self + Admin only |
| Badges | Admin only | Everyone |
| Points | Admin only (via tasks) | Everyone |
| Warning Count | Admin reads | Admin only |
| Ban Status | Admin only | Admin only |

### Profile Edit Flow
1. User visits `/profile` (own profile)
2. Clicks "Edit Profile"
3. Updates fields → submits
4. `PATCH /api/profile` → validates + writes to Firestore `users/{uid}`
5. Changes reflected immediately via Firestore real-time listener

### Public Profile (`/user/[uid]`)
- Shows public fields: name, bio, university, github, linkedin, badges, points
- Does NOT show: whatsapp, warnings, ban status

---

## 🔔 Page: Notifications (`/notifications`)

**Visibility:** Signed-in users  
**Purpose:** Inbox for all system notifications

### Notification Types
| Type | Trigger | Channel |
|---|---|---|
| Event registration confirmed | Admin confirms registration | In-app + Email |
| New event published | Event goes live | Push + In-app |
| Application status change | HR updates application | Email + In-app |
| Task assigned | Admin assigns task | In-app + Push |
| Warning received | Admin issues warning | Email + In-app |
| Payment verified | Admin confirms payment | Email + In-app |
| New announcement | Admin broadcasts | Push + In-app |
| Role changed | Admin upgrades role | Email + In-app |

### Notification Delivery
- **Push notifications:** Firebase FCM (Service Worker + VAPID keys)
- **In-app:** Firestore `notifications/{uid}/items` collection, real-time listener
- **Email:** Nodemailer SMTP (free tier) configured via `src/lib/mailer.ts`

---

*AGENT 03 sign-off: Store, Checkout, Profile, Notifications pages fully documented.*
