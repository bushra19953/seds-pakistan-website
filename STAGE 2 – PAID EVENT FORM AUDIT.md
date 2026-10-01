# v27.0 SWARM DEPLOYED — STAGE 2/12 STARTING

## **STAGE 2 – PAID EVENT FORM AUDIT**

**AGENT 02 (PAID EVENT FORM DISSECTOR) REPORT**

### **1. Dissection of the Redundant Payload**
The `event-form.tsx` is currently suffering from a "Split Personality Disorder". It captures payment metadata that is 100% redundant with the Store Management system.

| Field Name | Code Reference | Redundancy Level | Logic Failure |
| :--- | :--- | :--- | :--- |
| `amountInput` | L754-L768 | **CRITICAL** | Duplicates `Product.price`. Stale if product price changes in Store. |
| `currency` | L769-L780 | **CRITICAL** | Duplicates `Product.currency`. Risk of currency mismatch. |
| `method` | L781-L792 | **HIGH** | Duplicates Store payment method settings. |
| `instructions` | L793-L805 | **HIGH** | Duplicates Store checkout instructions. |
| `qrCodeUrl` | L806-L817 | **MEDIUM** | Should be a Store-level asset for that product/category. |

---

### **2. The Duplication Loop (Lines 966-995)**
The current implementation of "Store Integration" is a "Pseudo-Sync" that actually ENCOURAGES duplication:

```typescript
// src/components/admin/events/event-form.tsx:966-995
onValueChange={(val) => {
  field.onChange(val);
  // Sync price/currency from product for backward compatibility
  const selectedProduct = eventProducts.find((p: any) => p.id === val);
  if (selectedProduct) {
    form.setValue('amountInput', String(selectedProduct.price));
    form.setValue('currency', selectedProduct.currency);
    form.setValue('isPaid', true);
  }
}}
```

**Why this fails:**
1. **One-Way Sync**: If the Admin changes the price in the Store later, the Event still holds the old `amountInput` value.
2. **Confusing UI**: The user sees the Store selection AND the manual fields, leading to uncertainty about which one is "active".
3. **Database Bloat**: Both `productId` and `paymentDetails` are stored in the `EventDoc`, creating two sources of truth.

---

### **3. Audit Sign-off**
The form is currently architected as if the Store and Events are separate entities that occasionally talk. They must be merged.

**AGENT 02 Sign-off**: Redundancy confirmed in 5 major fields. Logic failure identified in the `onValueChange` sync handler.

**MISSION STATUS: STAGE 2 COMPLETE. PROCEEDING TO STAGE 3.**
MISSION COMPLETE — PAID EVENT STORE CENTRALIZATION ASSASSINATED
