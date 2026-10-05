# E2E Test: Task Submission Flow (Code Trace)

Date: 2026-10-05
Method: Code trace + live API probe. **No real task was created** — the API requires a Firebase ID token and this environment has no authenticated user session. What follows is verified from source code, not a live run.

## 1. Task Creation

### API path: POST /api/tasks
Source: `src/app/api/tasks/route.ts` (line 850)

**Auth:** Firebase ID token via `Authorization: Bearer` header or `__session` cookie. Verified live: unauthenticated POST returns `401 {"error":"Unauthorized: missing Bearer <redacted>"}`.

**Permission:** Caller needs `canManageTasks` (via custom claims or `roles/{uid}` doc), OR must have direct subordinates in the hierarchy (managers can create for their team).

**Required fields** (zod schema):
- `title` (1-256 chars) — required
- `description` (string) — required
- `points` (number >= 0) — required
- `deadline` (string/number/date, must be in the future) — required
- At least one assignee: `assigneeId` or `assigneeIds` — required (refine check)

**Optional:** `status` (default 'pending'), `workflowId`, `workflowTitle`, `sequenceIndex`, `individualDeadline`, `projectId`, `resources[]`, `report`.

**What happens on create:**
- Task doc written to `tasks` collection with server timestamps
- Assignee's `users/{uid}` counters incremented (`tasksAssignedCount`, `lastTaskAssignedAt`)
- Assignee status validated (banned/vacationing users rejected with 403)

### Admin UI path (for the guide screenshots)
1. Go to `/admin/tasks`
2. Click **"Create New Task"** button (line 936)
3. Fill the dialog form (title, description, assignees, deadline, points)
4. Submit → "Create Task"

## 2. Assignee Sees the Task (Profile)

Component: `src/components/profile/assigned-tasks.tsx`
- Profile shows task cards with status badges
- Status filter: ALL / STANDBY (pending) / ACTIVE (in-progress) / IN REVIEW (submitted-for-review) / OVERDUE
- Each card expandable: description, deadline, points, report field, deliverable uploads

## 3. The Submit Path (Transmit for Review)

**UI:** In the profile task card, the assignee sets status and clicks **"TRANSMIT FOR REVIEW"** (or "SUBMIT SITREP").

**What the client sends:** `PATCH /api/tasks` with `{ taskId, updates: { status: 'submitted-for-review', report: '...' } }` plus Firebase ID token.

**Server-side chain** (`handleUpdate` in route.ts):
1. Auth verified (401 if not)
2. Field auth: assignees may ONLY touch `status`, `hoursWorked`, `report`, `resourceLinks`, `feedback_text`, `deliverableFiles` — anything else → 403. `status` is in the safe set, so submit works.
3. On transition to `submitted-for-review`: server stamps `submittedBy` (uid) and `submittedAt` — never trusts client claims. Clears any prior approval/rejection stamps (resubmission support).
4. Single Firestore batch write to the task doc.
5. **Notifications:**
   - Assigner/manager gets in-app notification + email (`task_submitted_for_review` template) with link to `/admin/tasks?taskId=...`
   - Validator chain fan-out: everyone above the submitter in the reporting hierarchy gets an in-app notification via `notifyValidatorsOnSubmission` (non-blocking, failures logged only)
6. Activity logged to `tasks/{id}/activity` subcollection.

**Verdict: chain is complete, no broken links found.** Every step has error handling; notification failures are non-blocking (warn-logged).

## 4. Reviewer Side (Validation Queue)

**API:** `GET /api/tasks/review-queue` — returns tasks with `status == 'submitted-for-review'` that the caller may validate. Eligibility: anyone above the submitter in the reporting chain, the original assigner, or a `canManageTasks` holder. Caller's own submissions excluded. Auth required.

**UI:** `src/components/profile/validation-queue.tsx` — "Awaiting Your Validation" section rendered on the reviewer's **own profile page**, pinned above Mission Control. Only renders when non-empty.

**Reviewer actions** (via PATCH):
- Approve → status `completed` (or `approved`): server stamps `approvedBy`, `approvedAt`, `approvedByRole`, `validatorDepth`, `validatedVia`. Triggers gamification transaction (points awarded, deadline penalty if late).
- Request changes → status `changes-requested`: stamps `rejectedBy`, `rejectedAt`.

## 5. Gaps / Risks Found

1. **No live E2E verification possible from here.** The whole chain is code-traced. A real test needs a logged-in session (assignee submits → reviewer sees queue → approves).
2. **Email notifications depend on the mailer config.** In-app notifications are Firestore-based (free, reliable). Email uses `sendEmailNotification` — if SMTP/Resend is misconfigured, the assigner gets the in-app ping but no email. (Known: Resend key was invalid as of Oct 5.)
3. **Validator chain depends on `reporting_relationships` data.** If the hierarchy data is missing/stale for a submitter, only the assigner gets notified — the wider chain fan-out silently finds nobody.
4. **Deadline display:** the submit page and mission page show deadlines, but there is no proactive "due soon" nudge in the profile task list beyond the OVERDUE filter.

## 6. Summary for the Guide

| Step | Who | Where | Action |
|------|-----|-------|--------|
| 1. Create | Admin/Manager | `/admin/tasks` → Create New Task | Fill title, description, assignee(s), deadline, points |
| 2. Do the work | Assignee | Their profile → assigned tasks | Open the task card, work, attach deliverables |
| 3. Submit | Assignee | Their profile → task card | Click TRANSMIT FOR REVIEW |
| 4. Get notified | Reviewer (upline) | In-app notification + profile | "Awaiting Your Validation" appears on their profile |
| 5. Validate | Reviewer | Their profile → validation queue | Approve or request changes |
