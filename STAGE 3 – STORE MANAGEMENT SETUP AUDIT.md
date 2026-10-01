# v27.0 SWARM DEPLOYED — STAGE 3/12 STARTING

## **STAGE 3 – STORE MANAGEMENT SETUP AUDIT**

**AGENT 03 (STORE MANAGEMENT AUDITOR) REPORT**

### **1. Dissection of the Existing Store Infrastructure**
My audit reveals that a robust, yet underutilized, centralized payment configuration already exists in the system.

**A. Global Payment Configuration**
- **Location**: `Firestore: settings/payment_methods`
- **Managed By**: [certificate-settings.tsx](file:///E:/SEDS%20WEBSITE%20UPDATED%20SHIT/src/app/admin/store/components/certificate-settings.tsx)
- **Content**:
  - `raast`: Raast Transfer instructions & icon.
  - `easypaisa`: Easypaisa QR instructions & icon.
  - `sadapay`: SadaPay Transfer instructions.
  - `testMode`: Global toggle for payment testing.

**B. Product Schema (The Single Source of Truth)**
- **Type**: `Product` in [store.ts](file:///E:/SEDS%20WEBSITE%20UPDATED%20SHIT/src/types/store.ts)
- **Key Fields**: `price`, `currency`, `stock`, `category`, `eventId`.
- **Finding**: The `Product` type is already designed to link back to an event via `eventId`, but the "Event-to-Product" auto-creation bridge is missing.

---

### **2. The Centralized "Inheritance" Chain**
Currently, the `CheckoutPage` uses hardcoded bank details, ignoring the `settings/payment_methods` document. This is a secondary centralization failure.

| Data Type | Current Storage | Targeted Storage |
| :--- | :--- | :--- |
| **Bank Details** | Hardcoded in `checkout/page.tsx` | `settings/payment_methods` |
| **Event Price** | `events/{id}.paymentDetails.amount` | `products/{productId}.price` |
| **Payment Instructions** | `events/{id}.paymentDetails.instructions` | `settings/payment_methods` |
| **Checkout Flow** | Manual redirection logic | Automatic Product-based resolution |

---

### **3. Operational Bottlenecks Identified**
1. **Manual Linking**: Admins must first create a product in the Store, copy the ID, and then paste it into the Event Form.
2. **Double Entry**: If an admin changes the event price, they must remember to update both the Store Product and the Event document.
3. **Ghost Instructions**: The `paymentInstructions` in `event-form.tsx` often conflict with the global bank details, leading to user confusion.

---
**AGENT 03 Sign-off**: Infrastructure audit complete. The foundation for centralization (the `products` collection and `payment_methods` settings) is present but disconnected.

**MISSION STATUS: STAGE 3 COMPLETE. PROCEEDING TO STAGE 4.**
MISSION COMPLETE — PAID EVENT STORE CENTRALIZATION ASSASSINATED
