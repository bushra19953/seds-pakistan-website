# SWARM B4: Task Detail Component Inventory (reuse for read-only submission view)

Scope: investigation only, no code changes. Branch: feat/remediation-harness-complete.

## Problem statement
Three tasks are "Submitted for Review" but no read-only view shows the submission. A read-only submission view is needed before building new UI.

## Components found that render a full task detail view

### 1. TaskDetailDialog (BEST CANDIDATE)
Path: `src/components/profile/task-detail-dialog.tsx` (850 lines)

- Renders: 3 tabs (Briefing/Overview, Mission Report, History).
- Fields rendered:
  - Header: title, priority badge, status badge, short id, project title badge, mission progress bar.
  - Overview tab: metadata grid (deadline + overdue flag, mission value points + penalty/bonus, assigner avatar + name, operator/assignee avatar + name), reviewer feedback history, full briefing/description (collapsible), execution guidance (description + numbered steps), completion badge/commendation, operational resources (typed link cards).
  - Report tab: assignee name + photo, submitted time ("Submitted x ago"), hours logged badge, SITREP report text, submitted deliverable links (resourceLinks, one per line, as clickable link cards), empty state ("Waiting for Operator Transmission...").
  - History tab: activity log timeline from `/api/tasks/[id]/activity`.
- Read-only or editable: MIXED. It contains both:
  - Read-only views (all of the above render paths) when the viewer is not the assignee / not a manager / task is completed.
  - Editable submit form for the assignee (status select, hours input, SITREP textarea, artifact links textarea, "Transmit Mission Update").
  - Approve / Request Revision manager controls when `canReview` (manager or hierarchy-chain validator) and status is submitted-for-review.
  - AWAITING REVIEW banner when a reviewer opens it.
  - Manager briefing edit (title/description), recall submission (assignee), delegate button.
- Used in (all with the same shared interface: `task`, `open`, `onOpenChange`, `onTaskUpdated`, `isManager`, `initialTab`):
  - `src/components/profile/mission-card.tsx` (2 instances, detailInitialTab configurable)
  - `src/components/profile/task-history.tsx` (`isManager={false}`, read-only history context)
  - `src/components/profile/team-tasks.tsx` (`isManager={true}`)
  - `src/components/profile/assigned-tasks.tsx` (`isManager={isOwner || isAdmin}`, initialTab configurable)
- Live features: Firestore onSnapshot subscription for live task updates, hierarchical validation check via `/api/tasks/[id]/validation`.
- Already has: a reviewer entry point. When a reviewer opens a submitted-for-review task and clicks "Review Now", it jumps straight to the report tab, where the report, hours, and deliverable links render read-only with Approve / Request Revision controls underneath. This is the existing submission view. Its gaps for the current incident: the report tab only shows fields that were actually written to the task doc; it does NOT render `deliverableFiles` at all.

### 2. TaskForm (task-form.tsx)
Path: `src/components/admin/tasks/task-form.tsx` (1395 lines)

- Renders: create/edit form fields (title, description, assigneeIds, deadline, status, report, points, projectId, completionBadgeId).
- Read-only or editable: EDITABLE ONLY. It is the task create/edit dialog.
- Used in: `src/app/admin/tasks/page.tsx` for handleCreateTask / handleEditTask.
- Reuse verdict: wrong shape. It is a write form, not a detail viewer.

### 3. Admin tasks page table row
Path: `src/app/admin/tasks/page.tsx` (1538 lines)

- Renders: task list table (title, assignee, status, deadline, points). Row click opens the edit form above.
- No dedicated read-only detail dialog. Admins reviewing submissions currently rely on the profile-side TaskDetailDialog via team-tasks or the validation queue.

### 4. TaskInspector
Path: `src/components/admin/inspectors/task-inspector.tsx` (74 lines, wraps generic-inspector)

- Renders: title, priority, description, and "Member Submission Data" (JSON.stringify of `submissionData`, or a Launch Link button if it starts with http).
- Read-only or editable: READ-ONLY. It is an audit/inspector drawer pattern.
- Used in: inspector drawer system (drawer-content-factory context, admin).
- Reuse verdict: designed for a different data shape (`submissionData` string/object). Our task docs store submissions as separate fields (`report`, `hoursWorked`, `resourceLinks`, `deliverableFiles`), so this inspector would show nothing useful without mapping. Also renders raw JSON, not polished.

### 5. /tasks/[taskId] page
Path: `src/app/tasks/[taskId]/page.tsx` (63 lines)

- Renders: skeleton placeholder only, then redirects to `/profile/unified?task=<id>`.
- Not a detail view. Legacy bridge.

## Submission data model (from API schema, src/app/api/tasks/route.ts)
Assignee-safe PATCH fields: `status`, `hoursWorked`, `report`, `resourceLinks`, `feedback_text`, `deliverableFiles[]` (fileName, driveFileId, downloadUrl, sizeBytes, contentType).

Critical finding: **`deliverableFiles` exists in the API schema but is referenced in zero profile components** (grep over assigned-tasks.tsx, team-tasks.tsx, task-detail-dialog.tsx returns nothing). TaskDetailDialog renders `report`, `hoursWorked`, and `resourceLinks`, but has no render path for `deliverableFiles`. If the Oct 5 submissions carried files/photos, they are stored on the task doc and simply never rendered. This is the most likely root cause of "submissions appear EMPTY": the submit path may have written deliverableFiles while every read-only view only renders report/resourceLinks.

## Recommendation: best reuse candidate

**TaskDetailDialog (`src/components/profile/task-detail-dialog.tsx`)** is the single best candidate. Reasons:

1. Least new code: the read-only submission view already exists as the report tab. A reviewer opening a submitted-for-review task sees the AWAITING REVIEW banner, clicks Review Now, lands on the report tab showing assignee, hours, report text, and deliverable links, with Approve / Request Revision controls. No new component needed.
2. Fits existing conventions: it is already the shared detail surface used by mission-card, assigned-tasks, team-tasks, and task-history, with an `initialTab` prop (openers can pass `initialTab="report"`) and an `isManager`/hierarchy-validation gate for review actions.
3. Known gap to close instead of building new: add a `deliverableFiles` render block to the report tab (and to the TaskDetail interface), since the API already stores them and nothing displays them. That is a small additive change, not a new UI surface.

## What task-detail-dialog.tsx renders (full answer to item 4)
See component 1 above: header (title, priority/status badges, id, project badge, progress bar), Overview tab (deadline, points/penalty/bonus, assigner, operator, reviewer feedback history, briefing description, execution guidance steps, completion badge, typed resource links), Report tab (read-only SITREP report + hours + clickable deliverable links with empty state, or the editable transmit form for the assignee, or the awaiting-review locked view with recall), History tab (activity timeline), plus AWAITING REVIEW banner, manager Approve/Request Revision controls, manager briefing edit, and delegation dialog. It does NOT render `deliverableFiles` (photos/attachments) anywhere.

## Open question for the swarm
Whether the Oct 5 "empty" submissions wrote `report`/`resourceLinks` (empty strings) or only `deliverableFiles`. If files were attached via `deliverableFiles`, the fix is purely the missing render block in TaskDetailDialog. If nothing was written at all, the submit path itself needs a fix (Group A territory).
