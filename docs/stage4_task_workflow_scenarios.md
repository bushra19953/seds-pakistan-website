# STAGE 4 — SCENARIO ANALYSIS: TASK WORKFLOW & ACCOUNTABILITY
## v11.0 SWARM DEPLOYED — STAGE 4/15 (SCENARIO 6 of 8)
**AGENT 04 – SCENARIO HUNTER**

---

> **Thinking (COT):** The task workflow is the core mechanism of member labor and reward. This MD details the lifecycle of a task from creation to point award.

---

## ✅ Scenario 6.1: Delegating a High-Priority Technical Task

**Actor:** `projects_director`.  
**Trigger:** New milestone for the Rover project.

1. **Creation:** Admin visits `/admin/tasks` → **"Create Task"**.
2. **Details:** Title: "Analyze Suspension Load"; Points: 100; Due: End of Month.
3. **Assignment:** Selects role: `rover_team`.
4. **Deployment:** Clicks "Assign". 
5. **Result:** Every user with the `rover_team` role now has this task in their `/tasks` dashboard.

---

## ✅ Scenario 6.2: Submitting Proof of Work

**Actor:** A `rover_team` member.  
**Trigger:** Work completed.

1. **Action:** Member visits `/tasks` → clicks the "Analyze Suspension" card.
2. **Evidence:** Uploads a PDF report and enters: "Finished the load calculations for all 4 axles."
3. **Submit:** Clicks "Submit for Review".
4. **Backend:** Task status moves from `pending` → `submitted`.

---

## ✅ Scenario 6.3: Approving & Rewarding Labor

**Actor:** `projects_director`.  
**Trigger:** Reviewing the daily submission queue.

1. **Review:** Admin opens the submission in the Universal Inbox.
2. **Validation:** Checks the PDF report → Quality is good.
3. **The Reward:** Admin clicks **"Approve"**.
4. **The Cascade:**
   - Task status → `approved`.
   - Member's Firestore `points` += 100.
   - Leaderboard position (global + chapter) auto-recalculates.
   - Project progress bar (Rover) increments by 5%.

---

## ✅ Scenario 6.4: Handling an Overdue Task (The Defaulter)

**Actor:** `hr_director` (Monitoring).

1. **Notice:** Admin visits `/admin/defaulters`.
2. **The List:** System flags 5 members who missed the suspension task deadline.
3. **Action:** Admin selects all and clicks **"Issue Warning"**.
4. **Result:** Users receive: "WARNING: Missed Deadline. Warning 1 of 3 recorded."
5. **Persistence:** The warning count is now a permanent part of their profile metadata.

---

*AGENT 04 sign-off: Task workflow scenarios fully documented.*
