# CRM Relationship Forensics & Implementation Plan

## 1. Current State Forensics
### **Data Structure: `sponsors_partners` Collection** (Managed by `src/lib/partners.ts`)

**Existing Interactions Log:**
*   Field: `interactionHistory`
*   Type: `Array<{ timestamp?: any; note: string; author?: string }>`
*   **Missing Critical Data**:
    *   **Direction**: No distinction between Sent ("You") and Received ("Them").
    *   **Type**: No explicit field for Call vs Email vs Meeting (currently just free text in `note`).
    *   **Attachments**: No field for files/images.

**Existing Relationship Metrics:**
*   **Status**: `RelationshipStatus` (Prospect, In Negotiation, Active, etc.)
*   **Intelligence**: `agreementIntelligence` (AI analyzed data) & `strategicContext` (Context blob).
*   **Missing Metrics**:
    *   `lastContactAt` (We can derive from `interactionHistory` metadata, but a dedicated field is faster for filtering).
    *   `relationshipScore` (1-10).
    *   `followUpStreak`.

### **UI Implementation (`src/app/admin/crm/page.tsx`)**
*   **Table View**: Uses a standard HTML `<table>`.
*   **Row Expansion**: Currently does NOT exist. Clicking rows has no expansion logic.
*   **Activity Logging**: Simple `Dialog` with a single textarea.

---

## 2. Upgrade Strategy (Phase 2)

### **A. Schema Evolution (`src/lib/partners.ts`)**
We will extend the `PartnerRecord` interface without breaking existing data:

```typescript
// New Types
export type InteractionType = 'call' | 'email' | 'meeting' | 'whatsapp' | 'note';
export type Direction = 'sent' | 'received';

export interface Interaction {
  id: string; // Add GUID for threading/reacting
  type: InteractionType;
  direction: Direction;
  content: string;
  timestamp: any; // Firestore Timestamp
  author: string;
  attachmentUrl?: string;
}

// Extended PartnerRecord
export interface PartnerRecord {
  // ... existing fields
  // Replace loose array with typed Interaction array
  timeline?: Interaction[]; 
  
  // New Relationship Metrics
  relationshipScore?: number; // 1-10
  lastContactAt?: any; // Timestamp
  nextActionDate?: any; // Timestamp
}
```

*Migration Strategy*: We will create a utility to map old `interactionHistory` items to the new `timeline` format on the fly (treating them all as `note` / `sent` / `type: note`) if `timeline` is undefined.

### **B. UI Architecture Upgrade (`src/app/admin/crm/page.tsx`)**
1.  **Expandable Rows**:
    *   Convert `TableRow` to a component that manages an `isExpanded` state.
    *   Insert a `TableRow` (colSpan=6) immediately after the main row when expanded.
    *   Inside the expanded row: Render the **Relationship Command Center**.

2.  **Command Center Components**:
    *   **Left Column (Timeline)**: Vertical list of bubbles.
        *   `Sent` -> Right aligned, Blue.
        *   `Received` -> Left aligned, Gray.
        *   `Icon` -> Based on `type`.
    *   **Right Column (Health & Meta)**:
        *   Radial Progress for `relationshipScore`.
        *   Last Contact stats.
        *   "Strategic Context" textual area (Quick reference).

3.  **Structured Logger**:
    *   Replace the simple Modal textarea with an **Inline Composer** at the bottom of the timeline.
    *   Tabs for: Status Update | Log Call | Log Email.
    *   Radio buttons for Direction (You Spoke / They Spoke).

### **C. Repository Logic (`src/lib/contacts-repository.ts`)**
*   Add `logInteraction(id, data)` method that:
    1.  Generates ID.
    2.  Appends to `timeline` array.
    3.  Updates `lastContactAt`.
    4.  Updates `updatedAt`.
    5.  (Optional) Updates `relationshipScore` via simple heuristic (e.g., +1 for contact).

---

## 3. Execution Plan
1.  **Refactor `src/lib/partners.ts`**: Add new types `Interaction`, `InteractionType`, `Direction` and update `PartnerRecord`.
2.  **Update `src/lib/contacts-repository.ts`**: Implement `addInteraction` method to handle the appended log + metadata update.
3.  **Refactor `src/app/admin/crm/page.tsx`**:
    *   Extract `ContactRow` to a separate component to handle expansion logic cleanly.
    *   Build `RelationshipTimeline` component.
    *   Build `ConversationComposer` component.
    *   Integrate all into the main Page.

This plan addresses all "Reported Pain Points" by moving from "Phonebook" (List) to "Command Center" (Deep threaded view).
