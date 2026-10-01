# Principles Vault & AI Headquarters: Forensic Audit

## 1. Existing Infrastructure Analysis
*   **Principles Storage:** **Non-existent.** No files or Firestore collections found matching "principles", "rules", or "laws" in a user-configurable context.
*   **AI Engine Locations:** 
    *   `src/app/api/ai-task-generator/route.ts`: Uses `fetch` to call Google Generative Language API directly. Allows client-side API key override.
    *   `src/app/api/ai/analyze-reply/route.ts`: Uses `@google/generative-ai` SDK. Hardcoded "Breakthrough Negotiation" prompt.
    *   `src/ai/genkit.ts`: Configures `genkit` but seems underutilized compared to direct routes.
*   **Prompt Engineering:** currently hardcoded in `route.ts` files (e.g., "You are a master negotiator...").
*   **Conversation Import:** No streamlined tool exists. Users currently rely on generic `Textarea` inputs in `LogComposer` or `TaskForm`.

## 2. Technical Strategy
### A. Storage Architecture
We will implement a new sub-collection in Firestore or a top-level collection keyed by User ID.
*   **Path:** `users/{userId}/principles/{principleId}`
*   **Schema:**
    ```typescript
    interface Principle {
      id: string;
      title: string; // e.g., "Law 1"
      source: string; // "48 Laws of Power"
      category: 'Power' | 'Psychology' | 'Business' | 'Ethics';
      content: string; // The full text or summary
      active: boolean;
      tags: string[];
      createdAt: any;
    }
    ```

### B. AI "Headquarters" Engine
We will build a **dynamic prompt generator** instead of hardcoded strings.
*   **New Route:** `src/app/api/ai/headquarters-advisor/route.ts`
*   **Logic:**
    1.  Fetch efficient list of *Active* principles for the user.
    2.  Inject them into the System Instruction:
        > "You are the user's Strategic Advisor. You MUST apply the following active principles to every piece of advice:
        > [Law 1: ...]
        > [Law 15: ...]
        > Context: [User Conversation]..."
    3.  Output JSON: `{ analysis, suggested_reply, next_actions[], risk_assessment }`.

### C. UI Implementation (`headquarters.html` equivalent)
We will create `src/app/admin/headquarters/page.tsx`.
*   **Left Column:** Principles Vault (CRUD, Toggle Active/Inactive).
*   **Right Column:** Strategic Advisor (Chat interface, Paste-bin, "Generate Power Move" button).

## 3. Integration Points
*   **CRM:** Add "Consult HQ" button in `FullScreenContact` that opens a dialog or redirects to HQ with `?context={interactionId}`.
*   **Tasks:** "Save Action" button in HQ will create a Task in `TasksRepository`.

---
**Status:** Ready to Build.
