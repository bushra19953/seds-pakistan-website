# VERIFY-05 — Review modal vs read-only View Submission dialog (code inspection)

Scope: read-only code inspection of branch `feat/remediation-harness-complete`, repo `~/workspace/seds-pakistan-website`. No writes, no clicks, no code changes.

**Bottom-line answer: YES — submission content can be visible only in the review flow.
The `deliverableFiles[]` array (uploaded deliverable files: name, size, download link) is rendered in the
reviewer's Mission Report tab but is completely absent from the admin "View Submission" dialog. Also absent
from the dialog: `feedback_history` entries and the per-task activity/audit log.**

---

## 1. What the review flow actually is

**There is no review modal on `/admin/tasks`.** The table-row "Approve" and "Request Revisions" buttons
(`src/app/admin/tasks/page.tsx` lines 506 and 538) are plain buttons, not dialogs:

- `approveTask(taskId)` → `PATCH /api/tasks` with `updates: { status: 'completed' }`
- `requestRevisions(taskId)` → `PATCH /api/tasks` with `updates: { status: 'in-progress' }`

They display **zero submission content** before acting — they are blind one-click status transitions
(no modal, no report preview, no confirmation).

The **real** review flow with a decision modal is the hierarchical-validation path:

1. `src/components/profile/validation-queue.tsx` — "Awaiting Your Validation" card on the reviewer's profile. Each item shows: title, submitter name + role, points, submitted date, deadline, reviewer's position ("Assigner" / "N levels above submitter" / "Task manager"), and a **"Review Submission"** button.
2. Clicking it routes to `/profile/unified?uid=X&task=Y`, which opens `TaskDetailDialog` (`src/components/profile/task-detail-dialog.tsx`, 885 lines) — the assignee's task detail dialog with the reviewer-specific controls.
3. In reviewer mode (`canReview = isManager || validation.canValidate`, line 376), the **Mission Report tab** renders the submission read-only plus the decision controls:
   - **"Approve Mission"** button → `PATCH /api/tasks` `{ status: 'completed' }` (409 if a decision was already recorded — idempotency guard, line ~360).
   - **"Request Revision"** button → opens a feedback dialog (line 851) requiring non-empty `feedbackText`; submits `PATCH /api/tasks` with `{ status: 'changes-requested', feedback_text }`. Server-side this appends to `feedback_history[]` with `admin_id`, `timestamp`, `text`, `previous_status`.

## 2. Every field the review flow can see (reviewer view of Mission Report tab)

Data source: live Firestore task document (client SDK hydration, `liveTask`/`displayTask`), plus `tasks/{id}/activity` subcollection via `GET /api/tasks/{id}/activity`.

| # | Field rendered (reviewer view) | Source on task doc |
|---|---|---|
| 1 | Assignee avatar + name | `assignees` user record |
| 2 | "Submitted / Last updated" + relative time | `submittedAt \|\| updatedAt \|\| completedAt` |
| 3 | Hours badge | `hoursWorked` |
| 4 | Full report body (SITREP) | `report` |
| 5 | "Submitted Deliverables" link list | `resourceLinks` (newline-separated) |
| 6 | **"Deliverable Files" list: file name, size, clickable download link** | **`deliverableFiles[]` → `{ fileName, sizeBytes, driveFileId, downloadUrl, contentType }`** (lines 704–717) |
| 7 | Latest reviewer feedback box | `feedback_history[last].text` |
| 8 | Full feedback history (Overview tab, lines 553–566) | `feedback_history[]` (each: admin_id, timestamp, text, previous_status) |
| 9 | Activity timeline tab (lines 818–845) | `tasks/{id}/activity` subcollection |

Request-revision feedback dialog renders a textarea for the revision note (no submission fields inside it).

## 3. What the read-only "View Submission" dialog renders (`page.tsx` ~line 1503)

Data source: the task object already loaded in the admin task-list table (client-side row data, serialized by `GET /api/tasks`).

| Field | Source |
|---|---|
| "Submitted by" (name via usersMap, fallback raw id) | `submittedBy \|\| submittedById` |
| "Submitted at" absolute timestamp, or "Updated at (no submission timestamp recorded)" fallback | `submittedAt`, fallback `updatedAt` |
| "Hours worked" badge | `hoursWorked` |
| "Report" block | `report` |
| "Deliverable links" link list | `resourceLinks` (string or array) |

## 4. Delta: fields in the review flow that the View Submission dialog omits

| Omitted field | Submission content? | Where it lives in the review flow |
|---|---|---|
| **`deliverableFiles[]` (fileName, sizeBytes, downloadUrl, driveFileId, contentType)** | **YES — primary submission content.** These are the files the assignee actually uploaded (set by `/missions/[workflowId]/submit/[stepIndex]/page.tsx` line 109 on the submit path; `deliverableFiles` is in `ASSIGNEE_SAFE_FIELDS`, route.ts line 461) | Reviewer Mission Report tab "Deliverable Files" section |
| `feedback_history[]` | Review history, not new submission content | Overview tab + latest-feedback box |
| Task activity timeline (`tasks/{id}/activity`) | Audit metadata; one entry type carries a payload (see §5) | Activity tab |

**Fields common to both (no gap):** `report`, `resourceLinks`, `hoursWorked`, `submittedBy`, `submittedAt` (the dialog renders absolute time with a labeled fallback; the review tab renders relative "Submitted … ago").

## 5. Audit trail / activity code path tied to task review

Two separate mechanisms exist in code; **neither is `logAuditEntry`** (that helper is used by admin/announcements, applications, chapters, projects, roles, induction — not the task-submit path).

### (a) `tasks/{taskId}/activity` subcollection — per-task activity log
Written by `logTaskActivity()` in `src/app/api/tasks/route.ts` (lines 92–113) during `PATCH /api/tasks`:

| Trigger (in `updatesToApply`) | Activity type | Payload (`data`) |
|---|---|---|
| Any status change (incl. transition to `submitted-for-review`) | `status` | `{ from, to }` — line 661 |
| Report changed | `progress` | `{ summary: report.substring(0, 200) + '…' }` — line 742 |
| Hours changed | `hours` | `{ from, to }` — line 732 |
| Task creation (POST path) | `create` | — line 1096 |

Read path: `GET /api/tasks/{id}/activity` → rendered in the TaskDetailDialog **Activity tab**. UI caveat: the activity renderer (line 842) shows `a.data.text` only for `type === 'comment'`; every other type renders just the type name ("progress", "status", "hours"). **The `summary` payload of `progress` events (first 200 chars of the submitted report) is stored but never displayed anywhere in the UI** — dead payload for read purposes.

### (b) `audit_logs` collection — validation decision audit
Written by `logValidationDecision()` / `logDeniedValidationAttempt()` in `src/lib/server/validation-audit.ts`:

- On approval (route.ts ~line 605): `{ type: 'TASK_VALIDATED', actorId: validatorUid, targetId: taskId, data: { validatorRole, validatorDepth, via, submitterUid, decision: 'approved' }, timestamp }`
- On rejection (route.ts ~line 775): same shape with `decision: 'rejected'`, `reason: feedback text`
- On 403 denied attempt: `{ type: 'TASK_VALIDATION_DENIED', data: { callerRole, reason } }`
- Reads gated by `canViewAuditLogs`. No submission content in these records — decision metadata only.

## 6. Concrete conclusion for the three Task 02 tasks

- The admin "View Submission" dialog and the reviewer Mission Report tab both show `report`, `resourceLinks`, `hoursWorked`, `submittedBy`, `submittedAt`.
- **If any of the three tasks carry `deliverableFiles[]` entries (Drive-uploaded files from the submit path), they are invisible in the View Submission dialog and visible only in the review flow** (profile → Validation Queue → Review Submission → Mission Report tab → "Deliverable Files").
- The "minimal content" impression in the read-only dialog is therefore expected-by-design for `report`/`resourceLinks`/`hours`, but the dialog silently drops any `deliverableFiles`, any `feedback_history`, and the whole activity/audit timeline.
- Note the /admin/buttons Approve/Request Revisions act blindly — a reviewer clicking Approve on `/admin/tasks` never sees any submission content in a modal; the content-bearing review UI lives only on the profile side.
