# STAGE 3 — PAGE BREAKDOWN: TASKS & ACCOUNTABILITY
## v11.0 SWARM DEPLOYED — STAGE 3/15 (PAGE 10 of 11)
**AGENT 03 – PAGE BUTCHER**

---

> **Thinking (COT):** The Task System is the engine of member engagement. It drives the leaderboard and member rank. This MD details the task dashboard and submission flow.

---

## ✅ Page: Tasks Dashboard (`/tasks`)

**File:** `src/app/tasks/page.tsx`  
**Visibility:** Signed-in Members only.  
**Purpose:** Personal to-do list for every SEDS Pakistan member.

---

## Member View: The Task Queue

- **Filters:** All / Pending / Submitted / Approved / Rejected.
- **Task Cards:**
  - **Points:** Clear indicator of reward (e.g., "50 Points").
  - **Deadline:** Countdown clock or relative time ("Due in 2 days").
  - **Status Badge:** Real-time indicator of submission state.

---

## 📝 Submission Flow

1. Member clicks "View Details" on an active task.
2. **Submission Drawer:**
   - Text area for "Proof of Work" or completion notes.
   - File attachment (optional) for documents/images/reports.
3. Member clicks **"Submit Task"**.
4. **Result:** Task moves to "Submitted" status; member notified.

---

## 🎛️ Admin Task Console (`/admin/tasks`)

**Access:** `projects_director` and `superadmin`.  
**Purpose:** Delegating work and rewarding performance.

### 🤖 AI Task Generator (Gemini Integration)
- Admin can input a project goal → AI generates specific, actionable tasks with point values.
- **Logic:** Calls `/api/ai-task-generator` for structured JSON output.

### 📋 Task Assignment Logic
- **Single User:** Assign to one specific UID.
- **Role Group:** Assign to every user with role `member`, `rocketry_team`, etc.
- **Automatic:** New members auto-assigned "Onboarding Tasks" via triggers.

---

## 📊 Post-Submission: Approval & Points
1. Submission arrives at `/admin/submissions`.
2. Admin reviews the proof.
3. **Approve:** `points` field in `users/{uid}` incremented; notification sent.
4. **Reject:** Feedback note sent to user; task resets to "Pending".

---

*AGENT 03 sign-off: Tasks and accountability page fully documented.*
