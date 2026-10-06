# SWARM-A2: Approve/Request Revisions Modal Code Findings

Scope: investigation only, no code changes. Repo: `~/workspace/seds-pakistan-website`, branch `feat/remediation-harness-complete`.

## 1. Which component is the review modal

The review modal is **`TaskDetailDialog`** at `src/components/profile/task-detail-dialog.tsx` (850 lines). It is the only component that renders both the submission content and the Approve / Request Revision decision buttons together.

Rendered by (profile-side only):
- `src/components/profile/mission-card.tsx`
- `src/components/profile/task-history.tsx`
- `src/components/profile/team-tasks.tsx`
- `src/components/profile/assigned-tasks.tsx`

It is reached by reviewers through the `ValidationQueue` component (`src/components/profile/validation-queue.tsx`), whose "Review Submission" button opens the profile with the task and then the dialog.

Important: the Approve and Request Revisions buttons on **/admin/tasks do NOT open any modal**. In `src/app/admin/tasks/page.tsx` (lines 483-542), `approveTask()` and `requestRevisions()` are direct `PATCH /api/tasks` calls that flip `status` to `completed` or `in-progress` with no confirmation dialog and no submission preview. An admin approving from /admin/tasks sees zero submission content.

## 2. Exactly which submission fields the modal reads and renders

The "Mission Report" tab (the tab the "Review Now" / "AWAITING REVIEW" banner jumps to) renders these fields from the task document:

| Field on task doc | How it renders in the modal |
|---|---|
| `report` (string) | "MISSION REPORT (SITREP)" card: full report text in a bordered inner box. If empty, shows "Waiting for Operator Transmission..." placeholder instead. |
| `hoursWorked` (number) | Badge reading `"{n}H LOGGED"` next to the report header. |
| `resourceLinks` (newline-separated string) | "Submitted Deliverables" section: each non-empty line rendered as a clickable link row. |
| `updatedAt \|\| completedAt` | "Submitted {relative time}" line under the report header (e.g. "Submitted 2 hours ago"). Uses `safeFormatDistance`. |
| `feedback_history` (array) | "Reviewer Feedback" section in the Overview tab: each entry's `text` plus relative timestamp. |
| `status` / `actualStatus` | Gates everything: the report block and the decision buttons only render when `(!isAssignee \|\| status === 'completed')` and `canReview && status === 'submitted-for-review'`. |

Other task fields the modal also renders (briefing context, not submission content): title, description, priority, deadline, points, penaltyPoints, workflowBonusPoints, assigner name/photo, assignee name/photo, project title, guidance, resources, completionBadge name, activity timeline (via separate `/api/tasks/[id]/activity` call).

### Read-only visibility gate inside the modal itself

When the viewer is the submitter (assignee) and the task is still `submitted-for-review`, the modal does NOT show them their own report text. They get a locked panel: "Transmitted - awaiting review / Your report is locked while the reviewer decides", plus a "Recall submission" button. The report text becomes visible to the submitter only after the task reaches `completed`.

## 3. Where the modal gets the data

**Directly from the task document, live.** On open, the component subscribes with `onSnapshot(doc(firestore, 'tasks', task.id))` (lines 237-245) and renders `liveTask || task`. No separate API call is made to fetch submission content; `report`, `hoursWorked`, `resourceLinks`, `feedback_history` all come from the Firestore `tasks/{id}` document.

Two API calls happen, neither of which returns submission content:
- `GET /api/tasks/[id]/validation` - returns only `{ canValidate, via, depth }` (permission info: whether the viewer may approve, and through what path: assigner, reporting chain, or task manager). The modal uses this to decide whether to render the "Approve Mission" / "Request Revision" buttons.
- `GET /api/tasks/[id]/activity` - returns the activity timeline for the History tab only.

The submit path writes these fields: `PATCH /api/tasks` with `{ status: 'submitted-for-review', report, hoursWorked, resourceLinks }`, and the server additionally stamps `submittedBy` (uid) and `submittedAt` (server timestamp) at `src/app/api/tasks/route.ts` lines 475-476.

## 4. Fields the modal displays that NO read-only view displays

Cross-checked against /admin/tasks table (columns: task title, assignees, workflow participants, project, status badge, deadline, points, efficiency stats, created date), the admin edit dialog, and the ValidationQueue card (title, submitter name/role, points, submitted date, deadline):

| Field | Shown in TaskDetailDialog (Mission Report tab) | Shown anywhere else read-only |
|---|---|---|
| `report` text (SITREP) | Yes, full text | No. /admin/tasks table and ValidationQueue card show none of it. The admin TaskForm edit dialog prefills a `report` field but that is an edit form, not read-only. |
| `resourceLinks` (Submitted Deliverables links) | Yes, clickable link list | No read-only view shows it. The assignee's own inline card in assigned-tasks.tsx renders them in edit context only. |
| `hoursWorked` ("XH LOGGED") | Yes, badge in report header | No. The /admin/tasks table shows points, never hours. |
| `feedback_history` (Reviewer Feedback) | Yes, Overview tab section | No read-only view renders it. |
| Submitted time | Yes ("Submitted {relative time}") | Partially: the ValidationQueue card shows "Submitted {date}" (from `submittedAt` via the review-queue API), but the modal itself does NOT read `submittedAt`. |

### Related gaps worth noting (same flow, adjacent components)

1. The modal does **not** read `submittedAt` or `submittedBy`. The "Submitted" timestamp it shows is `updatedAt || completedAt`, which is a proxy. Any later update (e.g. a recall, or an edit) moves `updatedAt` and makes the displayed submission time wrong. The real `submittedAt` is only visible in the small ValidationQueue card.
2. The Approve and Request Revisions buttons on /admin/tasks bypass the modal entirely, so the only place a reviewer can inspect a submission before deciding is this dialog via the profile-side ValidationQueue.
3. The nested "Request Mission Revision" dialog (`showFeedbackDialog`) collects free text and writes it as `feedback_text` on the PATCH that sets `status: 'changes-requested'`; that text lands in `feedback_history` and is then only visible again inside this same modal.
4. Approve writes `status: 'completed'` with a 409 guard against concurrent decisions ("A decision was already recorded for this task").

## Summary for the parent

The submission content (report text, submitted deliverable links, hours logged) exists only on the `tasks/{id}` Firestore document and is rendered read-only in exactly one place: the Mission Report tab of `TaskDetailDialog` (profile components), reached by reviewers via the ValidationQueue "Review Submission" button. The data comes from a live `onSnapshot` on the task doc; no API call fetches the content itself. The /admin/tasks Approve/Request Revisions buttons are direct status-flipping PATCHes with no modal and no submission preview. Fields exclusive to this modal's read-only render: `report` (full SITREP text), `resourceLinks` (Submitted Deliverables), `hoursWorked` ("H LOGGED" badge), and `feedback_history`. Caveat: the modal's "Submitted {time}" display uses `updatedAt || completedAt`, not the actual `submittedAt` field the API stamps.
