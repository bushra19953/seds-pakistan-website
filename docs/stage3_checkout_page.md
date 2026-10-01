# STAGE 3 — PAGE BREAKDOWN: CHECKOUT & PAYMENT FLOW
## v11.0 SWARM DEPLOYED — STAGE 3/15 (PAGE 5 of 11)
**AGENT 03 – PAGE BUTCHER**

---

> **Thinking (COT):** The checkout page (`/checkout`) is the most critical financial route. It must handle form responses, receipt uploads, and transaction tracking with 100% reliability. This MD details the multi-step checkout funnel.

---

## 💳 Page: Checkout (`/checkout`)

**File:** `src/app/checkout/page.tsx`  
**Visibility:** Signed-in users only.  
**Purpose:** Unified multi-step funnel for all financial transactions.

---

## Step-by-Step Checkout Flow

### Step 1: Product Fetch & Verification
- System reads `productId` from URL query.
- Fetches product details from Firestore.
- Checks `isActive` and `stock > 0`.
- If invalid, redirects to `/explore` with error.

### Step 2: Custom Form Completion (Optional)
- **Trigger:** Product has a linked `formId`.
- **UI:** Dynamically renders the linked form from `/admin/forms`.
- **Requirement:** User must fill all mandatory fields (e.g., chapter name, event-specific questions).
- **Data:** Responses are stored as `formResponses` in the final Order document.

### Step 3: Payment Instruction & Evidence
- **UI:** Shows organization's bank account details (account number, bank name, titles).
- **Action:** User performs manual bank transfer outside the app.
- **Requirement 1:** Upload proof-of-payment (JPG/PNG receipt).
- **Requirement 2:** Enter Transaction ID (mandatory for cross-referencing).

### Step 4: Submission & Order Creation
- **Action:** User clicks "Complete Purchase".
- **Backend:** Creates `orders/{orderId}` with `paymentStatus: 'pending'`.
- **Notification:** Email confirmation sent to user; Admin dashboard updated in real-time.

---

## 📈 Order Document (Financial Ledger)

Each checkout creates a master record in the `orders` collection:

| Field | Purpose |
|---|---|
| `userId` | Links to the buyer's profile |
| `items` | Array of purchased products (id, name, quantity, price) |
| `total` | Final price in PKR |
| `proofOfPaymentUrl` | Firebase Storage path to the receipt image |
| `transactionId` | The bank reference number entered by the user |
| `originatingModule` | Tags the source (store / event / donation / chapter) |
| `formResponses` | JSON map of any custom form answers |

---

## 🛡️ Security & Integrity

1. **Transaction ID Uniqueness:** Backend checks if Transaction ID has already been used to prevent double-claiming.
2. **File Validation:** Receipt uploads are restricted to image types and limited in size (5MB).
3. **Rollback:** If order creation fails after image upload, the image is not orphaned — it remains linked to the session for retry.

---

*AGENT 03 sign-off: Checkout and payment flow page fully documented.*
