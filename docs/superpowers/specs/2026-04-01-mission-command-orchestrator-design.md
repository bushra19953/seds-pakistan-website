# Mission Command Orchestrator Design Spec

**Date:** 2026-04-01  
**Status:** Draft  
**Owner:** Gemini CLI

---

## 1. Problem Statement
The current task delegation system is limited to a single assignee and only considers direct reports. It lacks automated task breakdown and intelligent role-based matching. Furthermore, administrative access for several modules (Blog, Store, Users, etc.) is inconsistently gated by role-based hardcoding, making it difficult to delegate admin authority. Lastly, the task details UI contains redundant and confusing "Update" and "Overview" sections.

## 2. Goals
- **Intelligent Delegation Engine:** Enable AI-powered workflow breakdown and multi-user assignment based on system roles and workload.
- **Hierarchy Reach:** Allow delegation to anyone in the sub-hierarchy (full-tree), not just direct reports.
- **Managed Review Loop:** Implement a strict "Chain of Command" where the delegator must approve sub-tasks before the parent task can be completed.
- **Permission & Role Hardening:** Centralize administrative permissions and enable "Nuclear" role deletion (reverting to 'member').
- **UI Consolidation:** Refactor `TaskDetailDialog` to eliminate redundant tabs and clarify the "Overview" vs. "Mission Report" flow.

---

## 3. Architecture

### 3.1 AI Orchestration Flow
When a user (Delegator) triggers the delegation flow:
1.  **Input Collection:** 
    - Parent Task Context (Title, Description, Deadline, Points).
    - Additional Briefing (Resources, specific instructions).
    - Full Sub-Hierarchy Registry (User IDs, System Roles, and Active Task Count).
    - Role Definitions (Descriptions of what each role does).
2.  **AI Engine (`/api/ai-task-generator`):**
    - Breaks down the task into 2-5 actionable "Mission Steps."
    - Matches steps to the best-fit person based on their **System Role**.
    - Balances workload by preferring people with fewer active tasks in the sub-hierarchy.
    - Suggests a point split (keeping a % for the delegator as a "Management Reserve").
3.  **Review & Launch:** The delegator reviews the suggested workflow, makes manual adjustments, and confirms.

### 3.2 Permission Registry & Admin Hardening
A new centralized `PermissionRegistry` will define administrative modules:
- `manageUsers`, `manageBlog`, `manageStore`, `manageInventory`, `manageAnnouncements`, `manageAuditLogs`, etc.
- **AuthorizationGate:** A shared component/middleware that checks the current user's role against these permissions.
- **Role Drawer:** Updated to show a checklist of these permissions for each role definition.

### 3.3 Role Lifecycle Management
- **Nuclear Deletion:** `DELETE /api/admin/roles/[slug]` will:
    - Remove the `roleDefinition`.
    - Perform a batch update on the `roles` collection for all users assigned to that role, reverting them to `member`.
    - Revoke all associated administrative permissions.

---

## 4. Implementation Details

### 4.1 Data Models
- **Delegated Workflow:**
    ```typescript
    interface DelegatedWorkflow {
      id: string;
      parentTaskId: string;
      delegatorId: string;
      managementReservePoints: number;
      totalPointsDelegated: number;
      steps: WorkflowStep[];
      status: 'active' | 'completed';
    }
    
    interface WorkflowStep extends Task {
      isSubTask: true;
      parentWorkflowId: string;
      requiresApprovalBy: string; // The Delegator
    }
    ```

### 4.2 API Changes
- `POST /api/tasks/delegate`: Updated to accept `workflowSteps` with `assigneeId` and `points` for multi-user support.
- `PATCH /api/tasks/[id]/approve`: New endpoint for delegators to approve sub-tasks.
- `DELETE /api/admin/roles/[slug]`: Endpoint for "Nuclear" role deletion.

### 4.3 UI Changes
- **`TaskDetailDialog`:**
    - Consolidate "Overview" (Briefing) and "Update" (Mission Report) tabs.
    - Overview shows: Briefing, Deadline, Assigner, and Progress.
    - Mission Report (Update) shows: Situation Report, Hours Worked, and Resource Links.
- **`DelegateTaskDialog`:**
    - New "Orchestration" step where AI suggests the team and breakdown.
    - Grid view for reviewing/editing the AI-suggested workflow.

---

## 5. Success Criteria
- [ ] A delegator can break a 50pt task into 3 sub-tasks assigned to 3 different people in their hierarchy.
- [ ] Sub-tasks must be approved by the delegator to contribute to the parent task progress.
- [ ] Deleting a role instantly removes all permissions from its members and reverts them to 'member'.
- [ ] All admin pages (Blog, Store, etc.) are restricted by module-level permissions.
- [ ] Redundant UI tabs in `TaskDetailDialog` are removed.
