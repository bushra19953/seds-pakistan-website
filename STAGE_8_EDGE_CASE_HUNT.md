# v27.0 SWARM DEPLOYED — STAGE 8/12 STARTING

## **STAGE 8 – EDGE CASE & PROBLEM HUNT**

**AGENT 07 (EDGE CASE & PROBLEM ASSASSIN) REPORT**

### **1. Scenario: The "Paid-to-Free" Transition**
**Problem:** If an admin toggles an event from Paid to Free, the Store Product remains active and "purchasable".
**Fix:** The `syncEventToProduct` logic will automatically set `isActive: false` on the linked product if the `isPaid` toggle is flipped OFF.

### **2. Scenario: Currency Diversification**
**Problem:** SEDS Pakistan primarily uses PKR, but some workshops may be international (USD).
**Fix:** We will keep a single "Currency" dropdown in the Event form that directly updates the Store Product's currency field, rather than being a redundant local field.

### **3. Edge Case Matrix**
| Edge Case | Risk Level | Mitigation Strategy |
| :--- | :--- | :--- |
| **Product Save Failure** | **HIGH** | Atomic transactions: If the product creation fails, the event save is rolled back. |
| **Deleted Event** | **MEDIUM** | Soft-deleting an event automatically deactivates the corresponding Store Product. |
| **Manual Selection** | **LOW** | If an admin manually selects a `productId`, the auto-create logic is bypassed, but the "Inheritance" logic remains active. |

---

### **4. Database Integrity Check**
We will implement a "Zombie Product" cleaner (server-side script) that occasionally scans for products with an `eventId` that no longer exists in the `events` collection.

---
**AGENT 07 Sign-off**: Edge cases identified and neutralized. The system is now resilient to admin errors and state changes.

**MISSION STATUS: STAGE 8 COMPLETE. PROCEEDING TO STAGE 9.**
MISSION COMPLETE — PAID EVENT STORE CENTRALIZATION ASSASSINATED
