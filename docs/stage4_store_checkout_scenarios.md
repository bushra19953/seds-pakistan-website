# STAGE 4 — SCENARIO ANALYSIS: STORE & CHECKOUT
## v11.0 SWARM DEPLOYED — STAGE 4/15 (SCENARIO 3 of 8)
**AGENT 04 – SCENARIO HUNTER**

---

> **Thinking (COT):** The Store and Checkout flow is the most complex path due to manual bank transfers and receipt uploads. This MD details the "Happy Path" and the "Rejection Path".

---

## 🛒 Scenario 3.1: Successful Membership Fee Payment

**Actor:** A newly inducted guest.  
**Trigger:** Must pay chapter fee to activate membership.

1. **Entry:** User visits `/checkout?productId=chapter_fee_id`.
2. **Form Fill:** User completes the mandatory "Chapter Identity" form linked to the product.
3. **The Bank Transfer:** User opens their banking app, transfers 500 PKR to the SEDS account shown on screen.
4. **Evidence:** User screenshots the receipt and uploads it to the dropzone.
5. **Submission:** User enters the unique Transaction ID from the bank and clicks "Complete Purchase".
6. **State:** Order is created in `orders` collection with `paymentStatus: 'pending'`.

---

## 🛒 Scenario 3.2: Admin Verifying an Order

**Actor:** `superadmin` or `treasurer`.  
**Trigger:** New pending item in Universal Inbox.

1. **Notice:** Admin sees a notification for a "New Payment Submission".
2. **Review:** Admin opens `/admin/orders` and clicks the pending order.
3. **The Cross-Check:** 
   - Admin views the uploaded receipt image.
   - Admin checks organizational bank account statement for the Transaction ID.
4. **The Approval:** Admin clicks **"Confirm Payment"**.
5. **The Cascade:**
   - Order `paymentStatus` → `completed`.
   - User role potentially auto-upgraded (if linked logic).
   - Email: "Payment Verified! Your order is complete."

---

## 🛒 Scenario 3.3: Rejection of Fake/Incorrect Receipt

**Actor:** `treasurer`.  
**Trigger:** Receipt is blurry, incorrect amount, or duplicate Transaction ID.

1. **Detection:** Admin identifies a mismatch between the upload and bank records.
2. **Action:** Admin clicks **"Reject Payment"**.
3. **Feedback:** A mandatory "Reason for Rejection" field appears. Admin enters: "Amount mismatch (Required: 500, Paid: 400). Please re-submit."
4. **The Reset:** 
   - Order `paymentStatus` → `failed`.
   - Order `status` → `cancelled`.
5. **Recovery:** User receives notification and is prompted to visit the checkout again.

---

*AGENT 04 sign-off: Store and checkout scenarios fully documented.*
