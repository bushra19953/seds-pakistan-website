# Resources & Opportunities CRM Forensics Report

## 1. Executive Summary
The forensic audit confirms that the "CRM" data resides primarily in the **`sponsors_partners`** Firestore collection (referred to as "Sponsors & Partners" or "Organizations" in the Admin UI). This collection contains all the CRM-critical fields: pipeline stages, deal values, interaction logs, and contact details.

A secondary collection, **`resources`**, exists for static items (software, hardware, documentation) but lacks the CRM schema (no stages, deals, or contacts). 

**Recommendation:** The new `contacts-crm.html` should efficiently load and manage the `sponsors_partners` collection to achieve the "One-Page CRM" goal. The existing `resources` collection (Standard Library) is structurally incompatible with the requested "Deal/Stage" columns and should likely remain separate or be displayed in a simplified auxiliary view, unless "Collaboration Opportunities" from that list are migrated to the Partners collection.

---

## 2. File Inventory

### **Primary CRM Data (Opportunities/Partners)**
*   **Data Model & Logic:** `src/lib/partners.ts`
    *   Defines `PartnerRecord` interface.
    *   Exports `partnersCollection` reference (Firestore path: `sponsors_partners`).
    *   Contains helper functions: `createPartner`, `updatePartner`, `deletePartner`.
    *   Exports constants: `RELATIONSHIP_TYPES`, `STATUS_OPTIONS` (Pipeline Stages).
*   **Current UI Implementation:** 
    *   `src/app/admin/sponsors-partners/page.tsx` (Main "Sponsors & Partners" Dashboard).
    *   `src/app/admin/resources/page.tsx` (Wrapper that includes the above page as a tab).
*   **AI Integration:**
    *   `/api/admin/partners/analyze/route.ts` (Agreement Analysis).
    *   `/api/ai/analyze-reply/route.ts` (Negotiation Copilot).
*   **Permissions:**
    *   `src/components/admin/AuthorizationGate.tsx`
    *   `src/hooks/use-authorization.ts`

### **Secondary Resource Data (Static Library)**
*   **Data Model:** `src/lib/resource-types.ts` (Simple `Resource` interface).
*   **Ui Implementation:** `src/app/resources/page.tsx` (Public Card View).
*   **Admin Management:** `src/app/admin/resources/new/page.tsx` (Add New Resource).
*   **Firestore Collection:** `resources` (Simple items: title, link, type).

---

## 3. Data Structures & Storage

### **A. Primary CRM Object (`PartnerRecord`)** 
**Storage:** Firestore Collection `sponsors_partners`
**Key Schema:**
```typescript
{
  id: string; // Firestore Doc ID
  organizationName: string; // "Contact (Company)"
  relationshipType: 'Sponsor' | 'Technical Partner' | ...;
  status: 'Prospect' | 'In Negotiation' | 'Active' | ...; // "Stage"
  sponsorshipTier?: 'Platinum' | 'Gold' | ...;
  
  primaryContact: {
    name: string;   // "Contact (Name)"
    email: string;  // "Email"
    phone: string;  // "Phone"
    role: string;
  };

  financials: {
    pledgedAmount: number;   // "Deal Value"
    amountReceived: number;
    agreementDate: string;   // "agreementDate"
  };

  interactionHistory: [        // "Activity Log / Last Activity"
    { 
      note: string; 
      author: string; 
      timestamp: FirestoreTimestamp 
    }
  ];

  strategicContext: string;   // AI Context
  agreementIntelligence: Object; // AI Analysis
  associatedEventIds: string[];
}
```

### **B. Secondary Resource Object (`Resource`)**
**Storage:** Firestore Collection `resources`
**Key Schema:**
```typescript
{
  title: string;
  description: string;
  type: 'software' | 'hardware' | 'collaboration' | 'documentation';
  link: string;
  createdAt: Timestamp;
}
```
*Note: This schema lacks the fields required for the CRM view (Deal Value, Stage, Contact, etc).* 

---

## 4. Functionality Traces

### **Loading Data**
- **Current:** Uses `useCollection` hook with a real-time listener on the Firestore query.
- **Future:** `contacts-crm.html` should use the same real-time listener pattern (`onSnapshot`) to ensure "Real-time updates if multiple tabs open".

### **Search & Filter**
- **Current:** Client-side filtering (`.filter()`) on the loaded array.
- **Fields:** Matches `organizationName`, `primaryContact.name`, restricts by `status` (Stage) and `relationshipType`.
- **Future:** This exact logic can be ported to the new page for "Instant fuzzy search".

### **Editing**
- **Current:** Opens a `Dialog` (Modal) which saves via `updatePartner` (atomic update).
- **Future:** "Inline edit" will require creating small functional components that trigger `updatePartner` on `blur` or `Enter` without opening a full modal.

### **Pipeline System**
- **Defined in:** `src/lib/partners.ts` -> `STATUS_OPTIONS`.
- **Stages:** Prospect, In Negotiation, Active, Past, On Hold.
- **Tags:** Current UI uses simple text; New UI should use colored Badges/Tags as requested.

---

## 5. Mobile Performance & UI Components
- **Current Mobile State:** The existing `admin/sponsors-partners` page uses a rudimentary `<Table>` inside `overflow-x-auto`. This requires horizontal scrolling and is **poor** for mobile usage.
- **Proposed Solution:** The new `contacts-crm.html` must implement a **Card View** or **Stacked List** for mobile breakpoints, distinct from the desktop Table view, to satisfy the "Mobile: Open... scroll on phone" requirement.

## 6. Forensics Q&A
*   **Where is the data stored?** Firestore (`sponsors_partners` collection). No `TaskRepository` pattern is used; direct Firestore functions (`createPartner`, `updatePartner`) are imported from `@/lib/partners`.
*   **What fields exist?** All requested fields exist in `sponsors_partners` EXCEPT "Next Action Date" (currently, actions are just logged in notes).
    *   *Remediation:* We can add a `nextActionDate` field to the `PartnerRecord` schema without breaking existing code (it will just be undefined for old records).
*   **Is there duplication?** No, provided we bind to the `sponsors_partners` collection.
*   **Reproduce on mobile:** Current Resource/Partner tables are not optimized for mobile (horizontal scroll hell). The new page requires a dedicated mobile layout.

## 7. Next Steps (Phase 2)
1.  **Create `contacts-crm.html`** (or a Next.js route `/admin/crm`). *Note: User asked for .html but codebase is Next.js. We should create a Next.js Page `src/app/admin/crm/page.tsx` for full integration, or a raw HTML file if strictly necessary. Given the app structure, a Next.js page is STRONGLY recommended to reuse `useFirestore`, `Auth`, and `components`.*
2.  **Model Reuse:** Import `PartnerRecord`, `partnersCollection`, `updatePartner` from `@/lib/partners`.
3.  **Schema Update:** Add `nextActionDate` to `PartnerRecord` type to support the specific column request.
4.  **UI Construction:** Build the "One-Page" layout with:
    *   **Desktop:** Virtualized Table (TanStack Table or similar, or just optimized <div> list).
    *   **Mobile:** Card List.
    *   **Sidebar:** Pipeline Stage Counter (derived from `partners` array).
