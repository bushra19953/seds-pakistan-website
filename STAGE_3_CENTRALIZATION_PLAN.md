# v23.0 SWARM DEPLOYED — STAGE 3/12 STARTING

## **STAGE 3 – CENTRALIZATION PLAN**

**AGENT 03 (CENTRALIZATION ENFORCER) STRATEGIC BLUEPRINT**

### **1. Core Principle: "The Product is the Truth"**
We will enforce a strict architectural rule: **All financial logic must reside in the Store Management system.** Other modules (Events, Chapters, Certificates) will only hold a `productId` reference.

### **2. Database Schema Enforcement**
We will standardize the `products` collection with mandatory categories:
- `event-ticket`: Links to `eventId`.
- `chapter-fee`: Standardized fee for new chapters.
- `certificate`: Digital asset issuance.
- `donation`: Flexible price items.
- `merchandise`: Standard physical items.

### **3. Execution Roadmap**

#### **Step 3.1: The Event-Store Bridge (Stage 4)**
- Modify `EventDoc` type to deprecate internal `amount`.
- Update `event-form.tsx` to require selecting a Store Product.
- Update `event-cta.tsx` to fetch pricing dynamically from the Store.

#### **Step 3.2: The Donation Modernization (Stage 7)**
- Create a virtual product "Global Donation".
- Replace `src/app/donate/page.tsx` manual info with a "Donate Now" flow linking to `/checkout?type=donation`.

#### **Step 3.3: Checkout Logic Hardening (Stage 8)**
- Update `createOrder` action to enforce `originatingModule` tagging.
- Ensure `eventId` or `certificateCode` metadata is preserved in the `Order` document.

#### **Step 3.4: Admin Dashboard Overhaul (Stage 8)**
- Upgrade Store Management page to display "Transaction Type" (e.g., Event Ticket vs Hoodie).
- Add "Price Sync" indicators to show if an event's linked product is active.

---
**AGENT 03 Sign-off**: Plan finalized. Enforcement starts with Stage 4.
**AGENT 04 Ready**: Integrator standing by for Event Payment Integration.

**MISSION STATUS: STAGE 3 COMPLETE.**
MISSION COMPLETE — STORE MANAGEMENT CENTRAL TRANSACTION ASSASSINATED
