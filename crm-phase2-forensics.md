# CRM Phase 2 Forensics Report

## 1. Data Structure Analysis

### **Activity Logs (`timeline`)**
*   **Field Name**: `timeline` (New) / `interactionHistory` (Deprecated/Legacy).
*   **Structure**: Array of Objects.
*   **Current Schema**:
    ```typescript
    interface Interaction {
      id: string;          // UUID
      type: 'call' | 'email' | 'meeting' | 'whatsapp' | 'note';
      direction: 'sent' | 'received';
      content: string;
      timestamp: any;      // Firestore Timestamp or ISO String
      author: string;
      attachmentUrl?: string; // Optional
    }
    ```
*   **Findings**:
    *   **Timestamps**: Yes, `timestamp` field exists.
    *   **Direction**: Yes, `direction` field exists (`sent` | `received`).
    *   **Attachments**: Basic support via `attachmentUrl` (string), but requirement asks for `attachments` as `[urls]`.
        *   *Action Required*: Update schema to `attachments: string[]`.

### **Contact Information**
*   **Storage**: Nested within `primaryContact` object.
    ```typescript
    primaryContact?: {
      name?: string;
      email?: string;
      phone?: string;  // <-- Exists but currently hidden if email is present
      role?: string;
    };
    ```
*   **Current Display**: The UI currently prioritizes Email and separates fields with a `|`, but often truncates or hides Phone.
*   **Action Required**: Update UI to stack them: **Bold Email** \n *Small Phone*.

### **Full Screen / Expansion**
*   **Current State**: "Accordion" style expansion (TableRow expansion).
    *   *Limitation*: Constraints the view to the table width; not true "Full Screen".
    *   *Mobile*: terrible experience (horizontal scroll hell).
*   **Action Required**: Implement a `<Sheet>` or `<Dialog>` overlay that takes up 100% viewport on mobile and centered large modal on desktop.

### **Delete/Undo Functionality**
*   **Current State**: **None**. Logs are append-only.
*   **Action Required**:
    *   Add `deleteInteraction(partnerId, interactionId)` to Repository.
    *   UI: Add Trash Icon -> Optimistic UI Remove -> 3s Toast with "Undo".

---

## 2. Example Data Dump (Synthetic)

```json
{
  "id": "partner-123",
  "organizationName": "SpaceX",
  "primaryContact": {
    "name": "Elon M.",
    "email": "elon@spacex.com",
    "phone": "+1-555-0199"
  },
  "timeline": [
    {
      "id": "uuid-1",
      "type": "email",
      "direction": "sent",
      "content": "Sent sponsorship proposal v2.",
      "timestamp": "2025-12-13T08:00:00Z",
      "author": "Admin"
    },
    {
      "id": "uuid-2",
      "type": "call",
      "direction": "received",
      "content": "Discussed Q4 budget capabilities.",
      "timestamp": "2025-12-13T09:30:00Z",
      "author": "Elon M."
    }
  ]
}
```

## 3. Plan of Action (Immediate)

1.  **Schema Update**: Change `attachmentUrl` to `attachments: string[]`.
2.  **Repo Upgrade**: Add `deleteInteraction` method.
3.  **UI Overhaul**:
    *   **Contact Cell**: Redesign to show Name + Email + Phone stack.
    *   **Interaction Mode**: Switch from Table Row Expansion to **Full Digital Sheet/Overlay**.
    *   **Timeline**: Add "Delete" button (Trash icon) to bubbles.
    *   **Composer**: Add "Cancel/Close" button for full screen mode.
