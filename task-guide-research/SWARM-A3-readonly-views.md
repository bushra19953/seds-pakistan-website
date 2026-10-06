# Swarm A3: Read-Only Views vs Submission Fields Audit

Date: 2026-10-06. Investigation only, no code changed.

## Submission fields on the task document

From `src/app/api/tasks/route.ts` (assignee safe fields, server-stamped fields, schemas):

- `report` (string) — assignee-written execution report
- `hoursWorked` (number) — assignee-logged hours
- `resourceLinks` (string, newline-separated URLs) — assignee-provided deliverable links
- `deliverableFiles` (array of {name, url, type, uploadedAt}) — uploaded files, written only by the public submit page (`src/app/missions/[workflowId]/submit/[stepIndex]/page.tsx` line 109); validated by zod schema in `src/app/api/tasks/route.ts` line 275
- `submittedBy` (uid) — server-stamped on transition to submitted-for-review (line 475)
- `submittedAt` (Timestamp) — server-stamped on transition to submitted-for-review (line 476)
- `feedback_history` (array of {admin_id, timestamp, text, previous_status}) — reviewer feedback on changes-requested
- `feedback_text` — transient input, erased into `feedback_history` on save
- Reviewer stamps: `approvedBy`, `approvedAt`, `rejectedBy`, `rejectedAt`, `approvedByRole`, `rejectedByRole`, `validatedVia`, `validatorDepth`

The ONLY view that renders submission content is the task detail dialog (`src/components/profile/task-detail-dialog.tsx`) "Mission Report" tab, together with the Approve Mission / Request Revisions buttons. Every other read-only view ignores submission data entirely.

## View 1: Admin task table (/admin/tasks)

File: `src/app/admin/tasks/page.tsx`.

Row columns (10): selection checkbox, Title (with a "Submitted for Review" pill when status matches), Assignee (+ role), Team (workflow participants), Project, Status badge, Deadline, Points, Efficiency (completed/assigned, on-time %), Created, Actions (Edit, Delete, plus one-click Approve / Request Revisions when submitted-for-review).

- No expandable row, no detail drawer, no submission preview anywhere in the table.
- The row Approve button (`approveTask`, line 483) is a one-click PATCH to status 'completed' with NO modal and NO display of the submission. The reviewer never sees the report before clicking Approve.
- The row Request Revisions button (`requestRevisions`, line 515) is a one-click PATCH back to 'in-progress' with NO modal, NO feedback text captured. It bypasses the API's changes-requested feedback mandate entirely (sets 'in-progress' instead of 'changes-requested', so `feedback_history` is never written from this path).

Fields IGNORED by this view: report, hoursWorked, resourceLinks, deliverableFiles, submittedAt, submittedBy, feedback_history, and all reviewer stamps (approvedBy, approvedAt, rejectedBy, rejectedAt, validatedVia, validatorDepth).

## View 2: Task Edit dialog (TaskForm in the admin)

File: `src/components/admin/tasks/task-form.tsx`, launched from `src/app/admin/tasks/page.tsx` "Task Form Dialog".

Rendered fields (all configuration): Title, Description, Task Guidance, Step-by-Step Instructions, Brain Dump (AI), Base Points, Deadline Penalty, Workflow Bonus, Chapter, Team Badge, Project, Status, Deadline, Assignees, Workflow Plan (per-step title, description, deadline override, assignee, step badge, step resources), Resources and Logistics, Badge Awarded on Completion.

- `report` exists in `TaskFormValues` (line 75) and initial values (line 154) but has NO visible label or input in the form UI. It is state-only, carried through saves, never displayed.
- No submission fields are rendered: no read-only report, no hoursWorked, no deliverableFiles, no resourceLinks, no submittedAt/By, no feedback_history. The dialog cannot be used to inspect what a submitter delivered.

Fields IGNORED: report (state-only, invisible), hoursWorked, resourceLinks, deliverableFiles, submittedAt, submittedBy, feedback_history, all reviewer stamps.

## View 3: Assignee mission card, TRANSMITTED state

File: `src/components/profile/assigned-tasks.tsx`.

Collapsed card renders: directive number, status badge, title, resource chips, countdown, points, sync %, personnel (current op + mission command).

The resource chips (lines 340, 373-379): if admin `resources` array exists it renders those; only if it does not exist does it fall back to rendering `resourceLinks` split into "ATTACHMENT N" chips. This is the ONLY trace of any submission field on this card, and it is ambiguous (indistinguishable from admin resources in layout).

TRANSMITTED expanded state (lines 499-509): the SITREP panel shows only "Transmitted — awaiting review. Locked while the reviewer decides. Recall it to keep working on it." plus a Recall Submission button. No report, no hours, no submission timestamp, no submitter identity, no feedback.

- `inlineReport` / `inlineHours` state is populated from the task but only bound to editable inputs in the non-submitted branch; in the transmitted branch they are hidden.
- `feedback_history` renders only when status is 'changes-requested' (lines 517-527), never in the transmitted state.

Fields IGNORED in TRANSMITTED state: report, hoursWorked, deliverableFiles, submittedAt, submittedBy, feedback_history. resourceLinks is partially visible as generic "ATTACHMENT N" chips only when the admin resources array is absent.

## View 4: Public mission page (/missions/[workflowId])

File: `src/app/missions/[workflowId]/page.tsx`; data from `src/app/api/missions/[workflowId]/route.ts`.

Per step it renders: title, status badge (IN REVIEW for submitted-for-review), description, assignee name (+ N in the loop), chapter, role, due date, points, progress bar.

- The public API deliberately sanitizes: the task projection includes only title, description, status, sequenceIndex, points, deadlines, completedAt, createdAt, assignee ids, role, chapterId, projectId. All submission fields are stripped server-side before the client ever sees them.
- `completedAt` exists in the `MissionStep` interface but is never rendered in JSX (dead field on the page).
- No submission content for submitted (IN REVIEW) steps: no report, no hours, no deliverable files, no links, no submission timestamp.

Fields IGNORED: report, hoursWorked, resourceLinks, deliverableFiles, submittedAt, submittedBy, feedback_history, all reviewer stamps.

## Cross-view gap summary

| Field | Admin table | Edit dialog | Assignee card (TRANSMITTED) | Public mission page |
|---|---|---|---|---|
| report | ignored | state-only, invisible | hidden | ignored |
| hoursWorked | ignored | ignored | hidden | ignored |
| resourceLinks | ignored | ignored | ATTACHMENT chips fallback only | ignored |
| deliverableFiles | ignored | ignored | ignored | ignored |
| submittedAt | ignored | ignored | ignored | ignored |
| submittedBy | ignored | ignored | ignored | ignored |
| feedback_history | ignored | ignored | hidden unless changes-requested | ignored |
| reviewer stamps | ignored | ignored | ignored | ignored |

## Critical findings

1. `deliverableFiles` is written by the submit page but rendered in ZERO UI components anywhere (only the public submit page writes it; API schema validates it; the duplicate-workflows route strips it on copy). Uploaded deliverable files are invisible to every user including reviewers.
2. On /admin/tasks, Approve and Request Revisions are one-click actions with no preview of the submission. Request Revisions from this path sets 'in-progress' without feedback text, so no reviewer feedback record is created (the mandatory `feedback_text` for changes-requested is bypassed).
3. The task detail dialog "Mission Report" tab is the single place submission content is visible (report, hoursWorked, resourceLinks as "Submitted Deliverables", feedback_history). Even there, deliverableFiles, submittedAt, submittedBy, and reviewer stamps are never rendered; the date shown is derived from updatedAt/completedAt, not submittedAt.
4. The Edit dialog loads `editingTask.report` into form state but renders no input or display for it, so an admin editing a task can unknowingly preserve (or, on other save paths, overwrite) submission content without seeing it.
