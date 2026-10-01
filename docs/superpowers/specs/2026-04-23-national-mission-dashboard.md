# Design Spec: National Mission Dashboard & Premium PDF Upgrades

## 1. Objective
Transform the SEDS Pakistan Projects page into a high-authority "National Mission Board" and upgrade PDF exports with professional assignee avatars to reflect organizational scale.

## 2. Components

### 2.1 The "National Mission Hub" Dashboard
*   **Location**: Top of `/src/app/projects/page.tsx`, above the project search/filter bar.
*   **Data Source**: Real-time Firestore listener on `tasks` collection (filter: `workflowId != null`).
*   **Features**:
    *   **Global Progress**: Total completion percentage of all active national missions.
    *   **Live Ticker**: Displays the 3 most recently updated workflow steps across all chapters.
    *   **Command Metrics**: Count of Active Operations, Chapters involved, and total Mission Personnel.

### 2.2 Premium PDF "National" Export
*   **Avatars**: 12mm circular profile photos for each step assignee.
*   **Branding**: Pakistan Green accents and explicit Chapter labeling in the header/footer.
*   **Logic**: Automatic Base64 conversion of assignee profile images before PDF injection.

## 3. Architecture & Data Flow

### 3.1 Backend (API)
*   `GET /api/workflows`: Already returns `assigneePhoto` and `chapterName`. No changes needed.

### 3.2 Frontend (PDF Export)
*   `src/lib/workflow-pdf-export.ts`: 
    *   Update `WorkflowPDFStep` to include `assigneePhoto` (base64 string).
    *   Implement `drawCircularImage` helper using `jsPDF`'s circle clipping.
*   `src/app/admin/workflows/page.tsx`:
    *   Implement image-to-base64 utility to process `assigneePhoto` URLs before calling export.

### 3.3 Public Board (Projects Page)
*   `src/app/projects/page.tsx`:
    *   Add a `MissionBoard` sub-component.
    *   Query Firestore for task progress rollup.

## 4. Verification Plan
1.  **PDF**: Export a workflow and verify the assignee's face appears next to their name in a clean circle.
2.  **Dashboard**: Navigate to `/projects` and verify the "National Readiness" percentage updates as tasks are completed.
