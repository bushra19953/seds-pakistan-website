# v27.0 SWARM DEPLOYED — STAGE 4/12 STARTING

## **STAGE 4 – DUPLICATION ROOT CAUSE ANALYSIS**

**AGENT 04 (AUTO-LINK & AUTO-CREATE ENFORCER) REPORT**

### **1. The "Dual-Citizen" Identity Crisis**
**Thinking:** The root cause of the duplication is that the system treats a "Paid Event" as a separate entity from a "Store Product". In a truly centralized system, an event registration is simply a purchase of a digital asset (the ticket).

**A. Legacy Data Model (The Ghost in the Machine)**
The `EventDoc` type still carries the `paymentDetails` payload. This was likely a legacy implementation for manual bank transfers before the Store system existed.
```typescript
// src/types/event.ts
export interface PaymentDetails {
  isPaid: boolean;
  amount?: number;
  currency?: string;
  method?: string;
  instructions?: string;
  qrCodeUrl?: string;
}
```

**B. The "Optional Overlay" Failure**
The "Store Integration" section in the form was implemented as an **optional add-on** rather than a **mandatory replacement**. This allows admins to fill out manual payment details even when a Store Product is linked, creating a "two sources of truth" nightmare.

---

### **2. Technical Debt Matrix**
| Root Cause | Technical Manifestation | Impact |
| :--- | :--- | :--- |
| **Missing Trigger** | No logic in `event-form.tsx` to auto-create a product. | Admin must manually manage two collections. |
| **Hardcoded Checkout** | `checkout/page.tsx` ignores global settings. | Global payment changes require code updates. |
| **Backward Compatibility Trap** | Form "syncs" product price back to event fields. | Data desynchronization when product price changes. |

---

### **3. The Assassination Strategy**
To fix this, we must:
1. **Enforce the Product Link**: If `isPaid` is true, a `productId` MUST exist.
2. **Implement Auto-Provisioning**: When an event is saved, if it's paid and has no `productId`, a new product is automatically created in the `products` collection.
3. **Deprecate Manual Fields**: Hide the manual `amount`, `currency`, `method`, `instructions`, and `qrCodeUrl` fields from the form entirely.

---
**AGENT 04 Sign-off**: Root cause analyzed. The system's architecture is fragmented due to a lack of enforced hierarchy between Events and the Store. Ready for implementation.

**MISSION STATUS: STAGE 4 COMPLETE. PROCEEDING TO STAGE 5.**
MISSION COMPLETE — PAID EVENT STORE CENTRALIZATION ASSASSINATED
