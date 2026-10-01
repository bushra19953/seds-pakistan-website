# Mission Command Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the delegation system into an AI-powered Mission Orchestration Engine with centralized permissions and hardened role management.

**Architecture:** 
- Centralize all admin module access under a `PermissionRegistry`.
- Enhance the delegation API to support multi-step workflows assigned to anyone in the sub-hierarchy.
- Integrate role descriptions and workload metrics into the AI orchestration prompt.
- Refactor Task Details for clarity and eliminate UI redundancy.

**Tech Stack:** Next.js (App Router), Firebase (Firestore/Auth), Gemini AI API, Tailwind CSS, Lucide Icons.

---

## Chunk 1: Permissions & Role Lifecycle

### Task 1: Define Permission Registry
**Files:**
- Create: `src/config/permission-registry.ts`
- Modify: `src/config/permissions.ts`

- [ ] **Step 1: Create the Permission Registry**
Define all admin modules that require gated access.
```typescript
export const ADMIN_PERMISSIONS = {
  manageUsers: { label: 'User Directory', description: 'Assign roles and view user data' },
  manageBlog: { label: 'Blog System', description: 'Create and edit blog posts' },
  manageStore: { label: 'Store & Inventory', description: 'Manage products and orders' },
  manageAnnouncements: { label: 'Announcements', description: 'Post global notifications' },
  manageAudit: { label: 'Audit Logs', description: 'View system activity logs' },
  manageHierarchy: { label: 'Organization Chart', description: 'View and edit reporting lines' },
  manageRoles: { label: 'Role Definitions', description: 'Create and delete system roles' },
  manageTasks: { label: 'Task Management', description: 'Assign tasks to anyone' },
};
```
- [ ] **Step 2: Export from permissions.ts**
Ensure the registry is available throughout the app.

### Task 2: Permission Management UI
**Files:**
- Modify: `src/components/admin/roles/role-privileges-drawer.tsx`

- [ ] **Step 1: Replace simple list with checkboxes**
Map through `ADMIN_PERMISSIONS` and show a checkbox for each.
- [ ] **Step 2: Update handleSave**
Ensure selected permissions are saved to the `roleDefinitions` document in Firestore.

### Task 3: Nuclear Role Deletion
**Files:**
- Create: `src/app/api/admin/roles/[slug]/route.ts`
- Modify: `src/app/admin/roles/page.tsx`

- [ ] **Step 1: Implement the DELETE API**
Must delete the `roleDefinition` AND batch-update all users with that role to 'member'.
- [ ] **Step 2: Add Delete button to Roles Page**
Add a "Delete Role" button with a confirmation dialog.

---

## Chunk 2: Task Detail Refactor & Delegation Backend

### Task 4: Task Detail Dialog UI Cleanup
**Files:**
- Modify: `src/components/profile/task-detail-dialog.tsx`

- [ ] **Step 1: Consolidate Tabs**
Remove the "Update" tab and move its functionality into "Overview" or a renamed "Mission Report" tab.
- [ ] **Step 2: Separate Briefing from Reporting**
Ensure the "Briefing" (Description/Resources from assigner) is distinct from the "Mission Report" (Report/Hours from assignee).

### Task 5: Multi-User Delegation API
**Files:**
- Modify: `src/app/api/tasks/delegate/route.ts`

- [ ] **Step 1: Support Workflow Steps**
Update the POST handler to accept an array of steps, each with its own `assigneeId` and `points`.
- [ ] **Step 2: Implement Point Validation**
Ensure the sum of sub-task points + management reserve equals the parent task points.

### Task 6: Workload Data Aggregation
**Files:**
- Create: `src/app/api/admin/hierarchy/workload/route.ts`

- [ ] **Step 1: Fetch Task Counts**
Fetch the number of active tasks for every user in the sub-hierarchy of the caller.

---

## Chunk 3: AI Orchestration & Review UI

### Task 7: AI Orchestrator Upgrade
**Files:**
- Modify: `src/app/api/ai-task-generator/route.ts`

- [ ] **Step 1: Enhance the Prompt**
Include Role Definitions and Workload Data in the prompt sent to Gemini.
- [ ] **Step 2: Define Output Schema**
Enforce a JSON schema for the mission plan (2-5 steps).

### Task 8: Mission Command Orchestrator UI
**Files:**
- Modify: `src/components/profile/delegate-task-dialog.tsx`

- [ ] **Step 1: Multi-Step Orchestration View**
Implement a grid/list where the AI suggestions are displayed and can be edited.
- [ ] **Step 2: Step-Assignee-Points Mapping**
Allow selecting different assignees from the full hierarchy for each step.

### Task 9: Final Integration & Verification
- [ ] **Step 1: Run Full End-to-End Test**
Delegate a complex task to multiple users and verify the workflow creation.
- [ ] **Step 2: Verify Role Deletion**
Delete a test role and confirm users are reverted to member.
- [ ] **Step 3: Verify Admin Gates**
Confirm that removing a permission in the Role Drawer instantly locks the corresponding admin page for that role.
