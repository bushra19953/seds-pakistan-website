# CRM Phase 3 Forensic Audit

## 1. Last Touch & Activity Tracking
**Current State:**
- **Primary Field:** `lastContactAt` (Firestore `serverTimestamp`).
- **Update Triggers:** Only updates when a *new interaction* (call/email/note) is added via `addInteraction`.
- **Blind Spot:** Changing the `status` (Stage) or `financials` does NOT update `lastContactAt`. It only updates `updatedAt`.
- **Reliability:** "Last Touch" currently implies "Last Communication", not "Last Activity". This causes confusion when a user works on a deal (updating stage) but the contact sinks to the bottom because they didn't "call" them.
- **Timestamp Format:** Mixed.
  - `timeline[].timestamp`: Client-side ISO String (`new Date().toISOString()`).
  - `lastContactAt`: Server-side Firestore Timestamp.
  - `updatedAt`: Server-side Firestore Timestamp.

**Action Plan:**
- Introduce `lastActivityAt` (ISO String for consistency with timeline, or Firestore Timestamp).
- Introduce `lastActivityType` (String: "Call Logged", "Stage Updated", "Next Action Set").
- Ensure **ALL** write operations (create, update, log, delete) update this field.

## 2. Sorting Capabilities
**Current State:**
- **Backend:** Hardcoded `orderBy('updatedAt', 'desc')`.
- **Frontend:** `filtered` logic handles Search and Stage filtering but **does not** perform client-side re-sorting.
- **UI:** Table headers (`Entity`, `Value`, `Last Touch`) are static text. No click handlers. No visual indicators (↑↓).
- **Result:** Users cannot find "Who did I talk to longest ago?" (Ascending Sort) or "Who is the highest value?" (Value Sort).

**Action Plan:**
- Implement `sortConfig` state `{ key: string, direction: 'asc' | 'desc' }`.
- Make headers clickable buttons.
- Implement robust client-side sorting logic in the `useMemo` block.

## 3. Execution & AI
**Current State:**
- **Next Steps:** Only `nextActionDate` exists. No text field, no tracking, no checkbox.
- **AI:** No integration. `LogComposer` is manual only.
- **Storage:** No dedicated structure for `nextActions`.

**Action Plan:**
- Add `nextActions: Array<{ id, text, dueDate, boolean completed }>` to `PartnerRecord`.
- Implement AI Agent in `FullScreenContact` (or separate panel) to read `timeline` and generate:
  1. Suggested Reply.
  2. Recommended Next Actions.

## 4. Responsiveness (Mobile/Tablet)
**Current State:**
- **CRM List:** Uses standard HTML `<table>`. On mobile, this will either overflow horizontally or squash columns to unreadability.
- **Deep Dive:** Recently improved to use `Sheet`.
- **Resources Page:** Uses `AdminSponsorsPartnersPage` (same table issue) or `CompetitionsTab` (also uses Table).

**Action Plan:**
- **Mobile First View:** Hide `<Table>` on mobile (`hidden md:block`).
- **Card View:** Render a `<div className="md:hidden space-y-4">` containing `CRMCard` components for phone users.
- **Columns:** On tablet/desktop, keep the table but ensure columns have sensible `max-width` and truncation.

## 5. CSS & Styling
- **Files:** `globals.css` (Tailwind).
- **Structure:** Most styles are inline Tailwind classes.
- **Action:** Continue using Tailwind utility classes. Ensure generic components like `CRMRow` have responsive counterparts.

## 6. Implementation Strategy
1.  **Schema Upgrade:** Add `lastActivityAt`, `lastActivityType`, `nextActions`.
2.  **Repository Upgrade:** Update `create`, `update`, `addInteraction` to set `lastActivityAt`.
3.  **UI - Sorting:** Switch `CRMPage` to use dynamic sorting.
4.  **UI - Mobile:** Build `CRMCard` for mobile list view.
5.  **UI - AI & Execution:** Build "AI Assistant" panel in `FullScreenContact` and "Next Actions" checklist.

---
**Approved for Execution.**
