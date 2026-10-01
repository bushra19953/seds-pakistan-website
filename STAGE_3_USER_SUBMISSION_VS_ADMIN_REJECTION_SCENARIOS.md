# v18.0 SWARM DEPLOYED — STAGE 3/14 STARTING
# STAGE 3: USER SUBMISSION VS ADMIN REJECTION SCENARIOS

## 1. Agent Swarm Analysis: The "Edge-Case & HCI" Layer (COT)

### Agent 04 (QA / Edge-Case Assassin):
> "The rejection logic is a 'Double-Agent' system. We have two parallel paths for the same logical action. Path A (Admin UI) uses `changes-requested` which is strict and mandates feedback. Path B (Profile UI) uses `in-progress` which is a regression to the 'started' state. This obscures the fact that a task was actually rejected and makes it look like it just 'stalled'."

### Agent 08 (HCI Specialist):
> "From a human-computer interaction standpoint, the 'Notification Fatigue' and 'Information Fragmentation' are high. A user receives a notification for `task_feedback` but the task status simply says 'In Progress'. They have to hunt through the 'Activity' tab or 'Chat' to find the rejection reason, whereas in the Admin flow, the status itself signals the state."

---

## 2. Scenario Analysis: The "Split-Personality" Workflow

### Scenario A: The "Formal" Rejection (Admin Dashboard)
1. **Trigger:** Admin sets status to `changes-requested` in `src/app/admin/tasks/page.tsx`.
2. **Backend Enforcement:** `src/app/api/tasks/route.ts` mandates `feedback_text`.
3. **Data Integrity:** Feedback is stored in a structured `feedback_history` array on the task document.
4. **User Perception:** Status = `Changes Requested` (Clear & Authoritative).

### Scenario B: The "Informal" Rejection (Profile / Team Tasks)
1. **Trigger:** Manager clicks 'Request Changes' in `src/components/profile/task-detail-dialog.tsx`.
2. **Backend Execution:** `status` is patched to `in-progress`.
3. **Data Integrity:** Feedback is stored as a loosely-coupled `comment` in the `activity` subcollection.
4. **User Perception:** Status = `In Progress` (Confusing; looks like the task was never submitted).

---

## 3. Critical Flow: The "Submission" Handshake

| Action | User Input | State Transition | Notification Trigger |
| :--- | :--- | :--- | :--- |
| **Submit for Review** | Report + Hours + Resources | `in-progress` -> `submitted-for-review` | `task_status_change` to Assigner |
| **Request Changes** | Feedback (Mandatory/Optional?) | `submitted-for-review` -> `changes-requested` OR `in-progress` | `task_feedback` (Custom) |
| **Final Approval** | N/A | `submitted-for-review` -> `completed` | `gamification_transaction` |

---

## 4. Edge-Case Assassination: The "Overdue" Submission
A unique edge-case was identified in `src/app/api/tasks/team/route.ts`: **The Overdue/Poisoned Status.**
- If a task is marked as `overdue` but has a `report`, the system "heals" it by setting it to `submitted-for-review`.
- **Thinking:** This is a reactive fix for a deeper problem: the lack of a clear 'Overdue-but-Submitted' state in the state machine.

---

## 5. Strategy for Optimization (Stage 3 Verdict)
1. **Unify the Rejection State:** Force all rejection flows to use `changes-requested`.
2. **Sync Feedback Storage:** Move all rejection feedback into the structured `feedback_history` field for 100% auditability.
3. **Status Clarity:** Implement a virtual UI status `Review Overdue` to distinguish between "User hasn't finished" and "Manager hasn't reviewed."

**MISSION COMPLETE — TASK MANAGEMENT WORKFLOW ASSASSINATED & PERFECTED**
