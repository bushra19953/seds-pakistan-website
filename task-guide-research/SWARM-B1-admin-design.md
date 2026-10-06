# B1: Admin-Side Read-Only Submission View, Design

Branch: feat/remediation-harness-complete. Investigation and design only. No code changed.

## 1. Problem, stated precisely

Three tasks sit at `submitted-for-review`. On the admin tasks table (`src/app/admin/tasks/page.tsx`) the Actions cell offers Approve and Request Revisions as direct PATCH calls with zero visibility into what the submitter delivered. Reviewers are asked to approve work they cannot read. The submission content (SITREP report, hours, deliverable links) lives on the Task document and renders only inside the profile-side `TaskDetailDialog` Mission Report tab (`src/components/profile/task-detail-dialog.tsx`, line 651 onward), which the admin table does not reuse.

## 2. Existing components, mapped

- `src/app/admin/tasks/page.tsx` (1538 lines). Table row Actions cell already shows Approve / Request Revisions buttons when `task.status === 'submitted-for-review'`. `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription` from `@/components/ui/dialog` are already imported and used for the Create/Edit task form. `usersMap` (memoized from `users`) already resolves assignee names. `fetchTasks` calls `/api/tasks` and spreads the full task doc into state, so `report`, `hoursWorked`, `resourceLinks`, `updatedAt` are already present in memory; no extra fetch needed.
- `src/components/profile/task-detail-dialog.tsx`. Its "Current Report View (Read-Only/Manager)" block is the reference read-only rendering: avatar + "Mission Report (SITREP)" header, "Submitted {relative time}" line, hours badge, report body in pre-wrap, "Submitted Deliverables" link cards from `resourceLinks` split on newline, and a dashed "Waiting for Operator Transmission..." placeholder when no report exists.
- Submission fields on the Task document (`src/lib/task-types.ts` plus profile-dialog usage): `report?: string`, `hoursWorked?: number`, `resourceLinks?: string` (newline-separated URLs), `updatedAt` (no dedicated `submittedAt` field exists on tasks; the profile dialog uses `updatedAt` as the submitted-time proxy), submitter = `assigneeId` resolved through `usersMap`.

## 3. Recommendation: "View Submission" button plus dedicated read-only dialog

Pick the new button over expanding the Edit dialog.

- Fits convention: the Actions cell already has per-status buttons (Approve / Request Revisions). One more `size="sm"` outlined button appears only for `submitted-for-review` rows.
- Least new code: a new boolean state plus one `Dialog` block in `page.tsx`, reusing the already-imported shadcn dialog primitives. No changes to `TaskForm` (avoiding any risk of touching its react-hook-form state), no schema changes, no API changes.
- Do not reuse `TaskDetailDialog` directly: it is profile-domain, military-styled, and tightly coupled to assignee view state (`isAssignee`, validation API, manager approve flow). The admin table's Approve/Request Revisions are separate direct-PATCH handlers; wiring the profile dialog's manager controls into the admin page would be more coupling, not less. Extract the visual pattern, not the component.
- Rejected alternative: a read-only section inside the existing Edit dialog. The Edit dialog is a write path (TaskForm with submit handlers); bolting a read-only review block into it risks accidental edits, duplicates Approve/Request Revisions buttons in two places, and mixes two jobs into one modal.

## 4. Fields to render, with truthful empty states

Header: task title, the existing "Submitted for Review" status chip, and points value for context.

1. Submitted by: `usersMap[task.assigneeId]` displayName or email. Empty or unresolved: show "Unknown assignee" plus the raw assigneeId, never a blank line.
2. Submitted at: `updatedAt` formatted `dd/MM/yyyy hh:mm a` (the same `format`/`toDate` helpers the page already uses). Label must say "Last updated", not "Submitted at", because tasks carry no dedicated submittedAt field. If `updatedAt` is missing: "Not recorded".
3. Mission Report (SITREP): `report` rendered with `whitespace-pre-wrap`. Empty or missing: a dashed placeholder box reading "No report submitted".
4. Hours logged: `hoursWorked` as a badge reading e.g. "2.5H LOGGED". Missing: plain text "No hours logged".
5. Submitted deliverables: `resourceLinks` split on newlines, filtered for non-empty, each rendered as a full-width link card with `ExternalLink` icon and `target="_blank" rel="noopener noreferrer"`, prefixed with `https://` when the scheme is missing (same logic as the profile dialog). Empty: "No deliverable links submitted".

Keep the dialog strictly read-only: no Approve / Request Revisions buttons inside it. The row's existing buttons remain the only action path, which keeps one decision point and avoids double handlers.

## 5. Reusable pieces to build it from

- `@/components/ui/dialog` (already imported in the page), `@/components/ui/button`, `@/components/ui/badge`, `@/components/ui/avatar` (all already used in the page or its dialog).
- The existing `usersMap`, `toDate`, and `format` (date-fns) helpers in `page.tsx`.
- The "Current Report View" block in `task-detail-dialog.tsx` as the visual reference for the SITREP header, deliverable cards, and dashed empty-state placeholder.
- lucide-react `FileText` and `ExternalLink` icons (already imported in the codebase for the same purpose).

## 6. What this fixes and what it does not

- Fixes: reviewers on /admin/tasks can read the SITREP, hours, and deliverable links before approving, using only data the page already fetches.
- Does not fix: the underlying empty-submission problem (Maira's submissions appear to contain no report text, no hours, no links; the read-only view will truthfully show "No report submitted" instead of a silent blank). That is a submit-flow data issue for the assignee-side group, not this view.
- Does not fix: no dedicated `submittedAt` field on tasks; the "Last updated" label is a deliberate, honest compromise. If the swarm wants a true submitted-at timestamp, the submit PATCH path would need to write one, which is outside this design.
